import type { TeamChatInboundMessage, TeamChatSendRequest } from "@rakazo/adapter-kit";
import type { MessageBlock } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import {
  TeamChatBridge,
  teamChatAmbientPrompt,
  teamChatPrompt,
  teamChatResponseText,
} from "./team-chat-bridge.js";
import { inboundDeliveryClientNonce, messagingWakeIdempotencyKey } from "./webhook-inbound.js";

function routineReceipt(key: string, provider = "slack") {
  return {
    payload: {
      routineDelivery: {
        key,
        provider,
        prompt: "<untrusted_delivery_payload>event</untrusted_delivery_payload>",
        routineIds: ["routine-1"],
      },
    },
  };
}

describe("team chat bridge", () => {
  it("attributes an external speaker without changing their message", () => {
    expect(teamChatPrompt("slack", "Ada Lovelace", "Review the launch plan")).toBe(
      "Slack message from Ada Lovelace:\n\nReview the launch plan",
    );
  });

  it("keeps provider IDs out of ambient conversation context", () => {
    const prompt = teamChatAmbientPrompt({
      provider: "slack",
      channelId: "G123",
      channelName: "leadership",
      rules: "Engage on launch risks.",
      messages: [{ senderName: "Pat", senderId: "U123", content: "Launch moved to Friday." }],
    });
    expect(prompt).toContain("Slack channel update from #leadership.");
    expect(prompt).toContain("Pat: Launch moved to Friday.");
    expect(prompt).not.toContain("G123");
    expect(prompt).not.toContain("U123");
  });

  it("returns written agent output without leaking tool or computer blocks", () => {
    const blocks: MessageBlock[] = [
      { kind: "progress", text: "Searching" },
      { kind: "text", text: "The plan is ready." },
      { kind: "meta", text: "internal metadata" },
    ];
    expect(teamChatResponseText(blocks)).toBe("The plan is ready.");
    expect(teamChatResponseText([])).toBe("Bot completed the request without a written reply.");
  });

  it("keeps deferred messages outside reconciliation until routine routing resolves them", async () => {
    const upsert = vi.fn(async ({ create }: { create: Record<string, unknown> }) => ({
      id: "external-deferred",
      ...create,
      threadMessageId: null,
    }));
    const updateMany = vi.fn(async () => ({ count: 1 }));
    const prisma = {
      externalConversation: {
        upsert: vi.fn(async () => ({
          id: "conversation-1",
          provider: "slack",
          spaceId: "space-1",
          botId: "bot-1",
          userId: "owner-1",
          thread: { id: "thread-1" },
        })),
      },
      externalMessage: {
        upsert,
        update: vi.fn(async () => ({})),
        updateMany,
      },
    } as unknown as PrismaClient;
    const bridge = new TeamChatBridge({
      prisma,
      events: {
        sendUserMessage: vi.fn(async () => ({
          messageId: "transcript-1",
          runId: null,
          seq: 1,
          taskId: null,
        })),
      },
      jobs: { enqueue: vi.fn() },
      send: vi.fn(),
      providerId: "slack",
      botId: "bot-1",
    });
    (
      bridge as unknown as {
        target: { id: string; spaceId: string; userId: string; name: string };
      }
    ).target = { id: "bot-1", spaceId: "space-1", userId: "owner-1", name: "Chief" };

    await bridge.receive(
      {
        eventId: "Ev-deferred",
        workspaceId: "T-1",
        kind: "mention",
        conversationKey: "channel:C-1:100.1",
        conversationId: "C-1",
        senderId: "U-1",
        senderName: "Ada",
        content: "Run the release routine",
      },
      { queueAgent: false },
    );

    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({ create: expect.objectContaining({ status: "deferred" }) }),
    );
    await expect(
      bridge.resolveDeferredMessage("external-deferred", "routine", "mention"),
    ).resolves.toBe(true);
    expect(updateMany).toHaveBeenLastCalledWith({
      where: {
        id: "external-deferred",
        status: { in: ["deferred", "received", "observed"] },
        externalConversation: { provider: "slack", botId: "bot-1" },
      },
      data: {
        status: "ignored",
        engagementReason: "message_routine_wake",
        nextAttemptAt: null,
      },
    });

    await bridge.resolveDeferredMessage("external-ambient", "agent", "ambient");
    expect(updateMany).toHaveBeenLastCalledWith(
      expect.objectContaining({
        data: { status: "observed", engagementReason: null, nextAttemptAt: null },
      }),
    );
  });

  it("recovers expired deferred reservations before normal reconciliation", async () => {
    const updateMany = vi.fn(async () => ({ count: 0 }));
    const findMany = vi.fn(async ({ where }: { where: { status?: string } }) =>
      where.status === "deferred"
        ? [
            {
              id: "external-expired",
              kind: "mention",
              providerEventId: "Ev-expired",
              externalConversation: { thread: { id: "thread-1" } },
            },
          ]
        : [],
    );
    const findUnique = vi.fn(async () => null);
    const bridge = new TeamChatBridge({
      prisma: {
        externalMessage: {
          updateMany,
          findMany,
        },
        event: { findFirst: findUnique },
        routine: { findMany: vi.fn(async () => []) },
        run: { findMany: vi.fn(async () => []) },
      } as unknown as PrismaClient,
      events: { sendUserMessage: vi.fn() },
      jobs: { enqueue: vi.fn() },
      send: vi.fn(),
      providerId: "slack",
      botId: "bot-1",
    });
    (
      bridge as unknown as {
        target: { id: string; spaceId: string; userId: string; name: string };
      }
    ).target = { id: "bot-1", spaceId: "space-1", userId: "owner-1", name: "Chief" };

    await bridge.reconcileOnce();

    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          status: "deferred",
          nextAttemptAt: { lte: expect.any(Date) },
        }),
      }),
    );
    expect(updateMany).toHaveBeenCalledWith({
      where: {
        id: "external-expired",
        status: "deferred",
        nextAttemptAt: { lte: expect.any(Date) },
        OR: [
          { engagementReason: null },
          {
            NOT: {
              engagementReason: {
                in: [
                  "message_routine_routing",
                  "message_routine_routing_rearmed",
                  "message_teamchat_agent",
                ],
              },
            },
          },
        ],
      },
      data: { status: "received", engagementReason: null, nextAttemptAt: null },
    });
  });

  it("ignores expired deferred messages that already woke a message routine", async () => {
    const updateMany = vi.fn(async () => ({ count: 1 }));
    const findMany = vi.fn(async ({ where }: { where: { status?: string } }) =>
      where.status === "deferred"
        ? [
            {
              id: "external-woken",
              kind: "mention",
              providerEventId: "Ev-woken",
              externalConversation: { thread: { id: "thread-1" } },
            },
          ]
        : [],
    );
    const findUnique = vi.fn(async ({ where }: { where: { payload: { equals: string } } }) =>
      routineReceipt(where.payload.equals),
    );
    const bridge = new TeamChatBridge({
      prisma: {
        externalMessage: {
          updateMany,
          findMany,
        },
        event: { findFirst: findUnique },
        routine: { findMany: vi.fn(async () => []) },
        run: { findMany: vi.fn(async () => []) },
      } as unknown as PrismaClient,
      events: { sendUserMessage: vi.fn() },
      jobs: { enqueue: vi.fn() },
      send: vi.fn(),
      providerId: "slack",
      botId: "bot-1",
    });
    (
      bridge as unknown as {
        target: { id: string; spaceId: string; userId: string; name: string };
      }
    ).target = { id: "bot-1", spaceId: "space-1", userId: "owner-1", name: "Chief" };

    await bridge.reconcileOnce();

    expect(findUnique).toHaveBeenCalledWith({
      where: {
        threadId: "thread-1",
        spaceId: "space-1",
        botId: "bot-1",
        thread: { userId: "owner-1" },
        type: "thread.meta",
        payload: {
          path: ["routineDelivery", "key"],
          equals: inboundDeliveryClientNonce(
            "messaging",
            "bot-1",
            messagingWakeIdempotencyKey("slack", "Ev-woken"),
          ),
        },
      },
      select: { payload: true },
      orderBy: { seq: "asc" },
    });
    expect(updateMany).toHaveBeenCalledWith({
      where: {
        id: "external-woken",
        status: "deferred",
        nextAttemptAt: { lte: expect.any(Date) },
      },
      data: {
        status: "ignored",
        engagementReason: "message_routine_wake",
        nextAttemptAt: null,
      },
    });
    expect(updateMany).not.toHaveBeenCalledWith({
      where: {
        id: "external-woken",
        status: "deferred",
        nextAttemptAt: { lte: expect.any(Date) },
      },
      data: { status: "received", nextAttemptAt: null },
    });
  });

  it("recovers emulator wakes when deliveryProvider matches bridge providerId", async () => {
    // teamchat-emulator inbound uses event.provider !== bridge.providerId ("slack").
    // Recovery must look up the same nonce TeamChat wakes persist via deliveryProvider.
    const eventId = "Ev-emulator-1";
    const aligned = inboundDeliveryClientNonce(
      "messaging",
      "bot-1",
      messagingWakeIdempotencyKey("slack", eventId),
    );
    const mismatched = inboundDeliveryClientNonce(
      "messaging",
      "bot-1",
      messagingWakeIdempotencyKey("teamchat-emulator", eventId),
    );
    expect(aligned).not.toBe(mismatched);

    const updateMany = vi.fn(async () => ({ count: 1 }));
    const findMany = vi.fn(async ({ where }: { where: { status?: string } }) =>
      where.status === "deferred"
        ? [
            {
              id: "external-emulator",
              kind: "direct",
              providerEventId: eventId,
              externalConversation: { thread: { id: "thread-1" } },
            },
          ]
        : [],
    );
    const findUnique = vi.fn(async ({ where }: { where: { payload: { equals: string } } }) =>
      where.payload.equals === aligned ? routineReceipt(aligned, "teamchat-emulator") : null,
    );
    const bridge = new TeamChatBridge({
      prisma: {
        externalMessage: { updateMany, findMany },
        event: { findFirst: findUnique },
        routine: { findMany: vi.fn(async () => []) },
        run: { findMany: vi.fn(async () => []) },
      } as unknown as PrismaClient,
      events: { sendUserMessage: vi.fn() },
      jobs: { enqueue: vi.fn() },
      send: vi.fn(),
      providerId: "slack",
      botId: "bot-1",
    });
    (
      bridge as unknown as {
        target: { id: string; spaceId: string; userId: string; name: string };
      }
    ).target = { id: "bot-1", spaceId: "space-1", userId: "owner-1", name: "Chief" };

    expect(bridge.providerId).toBe("slack");
    await bridge.reconcileOnce();

    expect(findUnique).toHaveBeenCalledWith({
      where: {
        threadId: "thread-1",
        spaceId: "space-1",
        botId: "bot-1",
        thread: { userId: "owner-1" },
        type: "thread.meta",
        payload: { path: ["routineDelivery", "key"], equals: aligned },
      },
      select: { payload: true },
      orderBy: { seq: "asc" },
    });
    expect(updateMany).toHaveBeenCalledWith({
      where: {
        id: "external-emulator",
        status: "deferred",
        nextAttemptAt: { lte: expect.any(Date) },
      },
      data: {
        status: "ignored",
        engagementReason: "message_routine_wake",
        nextAttemptAt: null,
      },
    });
  });

  it("reclaims a received row when routine resolve races lease expiry", async () => {
    const updateMany = vi.fn(async () => ({ count: 1 }));
    const bridge = new TeamChatBridge({
      prisma: { externalMessage: { updateMany } } as unknown as PrismaClient,
      events: { sendUserMessage: vi.fn() },
      jobs: { enqueue: vi.fn() },
      send: vi.fn(),
      providerId: "slack",
      botId: "bot-1",
    });
    (
      bridge as unknown as {
        target: { id: string; spaceId: string; userId: string; name: string };
      }
    ).target = { id: "bot-1", spaceId: "space-1", userId: "owner-1", name: "Chief" };

    await expect(
      bridge.resolveDeferredMessage("external-raced", "routine", "mention"),
    ).resolves.toBe(true);
    expect(updateMany).toHaveBeenCalledWith({
      where: {
        id: "external-raced",
        status: { in: ["deferred", "received", "observed"] },
        externalConversation: { provider: "slack", botId: "bot-1" },
      },
      data: {
        status: "ignored",
        engagementReason: "message_routine_wake",
        nextAttemptAt: null,
      },
    });
  });

  it("extends deferred routing leases for thirty minutes", async () => {
    const updateMany = vi.fn(async () => ({ count: 1 }));
    const bridge = new TeamChatBridge({
      prisma: { externalMessage: { updateMany } } as unknown as PrismaClient,
      events: { sendUserMessage: vi.fn() },
      jobs: { enqueue: vi.fn() },
      send: vi.fn(),
      providerId: "slack",
      botId: "bot-1",
    });
    (
      bridge as unknown as {
        target: { id: string; spaceId: string; userId: string; name: string };
      }
    ).target = { id: "bot-1", spaceId: "space-1", userId: "owner-1", name: "Chief" };

    const before = Date.now();
    await expect(bridge.extendDeferredReservation("external-deferred")).resolves.toBe(true);
    const after = Date.now();
    expect(updateMany).toHaveBeenCalledWith({
      where: {
        id: "external-deferred",
        status: "deferred",
        externalConversation: { provider: "slack", botId: "bot-1" },
      },
      data: {
        nextAttemptAt: expect.any(Date),
        engagementReason: "message_routine_routing",
      },
    });
    const nextAttemptAt = (updateMany.mock.calls[0]![0] as { data: { nextAttemptAt: Date } }).data
      .nextAttemptAt;
    expect(nextAttemptAt.getTime()).toBeGreaterThanOrEqual(before + 25 * 60_000);
    expect(nextAttemptAt.getTime()).toBeLessThanOrEqual(after + 30 * 60_000);
  });

  it("keeps renewing a deferred lease while routine delivery remains blocked", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    try {
      let leaseUntil = new Date(0);
      const updateMany = vi.fn(
        async (input: { data?: { nextAttemptAt?: Date; status?: string } }) => {
          if (input.data?.nextAttemptAt) leaseUntil = input.data.nextAttemptAt;
          return { count: 1 };
        },
      );
      const findMany = vi.fn(async ({ where }: { where: { status?: string } }) =>
        where.status === "deferred" && leaseUntil.getTime() <= Date.now()
          ? [
              {
                id: "external-routing",
                kind: "mention",
                providerEventId: "Ev-routing",
                externalConversation: { thread: { id: "thread-1" } },
              },
            ]
          : [],
      );
      const bridge = new TeamChatBridge({
        prisma: {
          externalMessage: { updateMany, findMany },
          event: { findFirst: vi.fn(async () => null) },
          run: { findMany: vi.fn(async () => []) },
        } as unknown as PrismaClient,
        events: { sendUserMessage: vi.fn() },
        jobs: { enqueue: vi.fn() },
        send: vi.fn(),
        providerId: "slack",
        botId: "bot-1",
      });
      (
        bridge as unknown as {
          target: { id: string; spaceId: string; userId: string; name: string };
        }
      ).target = { id: "bot-1", spaceId: "space-1", userId: "owner-1", name: "Chief" };

      // Keeping the stopper open models wakeMessageRoutines still waiting on
      // delivery while reconciliation continues on its normal timer.
      const leaseHeartbeat = await bridge.startDeferredReservationHeartbeat("external-routing");
      await vi.advanceTimersByTimeAsync(31 * 60_000);
      await bridge.reconcileOnce();

      expect(updateMany.mock.calls.length).toBeGreaterThan(30);
      expect(leaseUntil.getTime()).toBeGreaterThan(Date.now());
      expect(updateMany).not.toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            id: "external-routing",
            status: "deferred",
            nextAttemptAt: { lte: expect.any(Date) },
          },
          data: { status: "received", nextAttemptAt: null },
        }),
      );

      leaseHeartbeat.stop();
      const renewalsAfterRoute = updateMany.mock.calls.length;
      await vi.advanceTimersByTimeAsync(2 * 60_000);
      expect(updateMany).toHaveBeenCalledTimes(renewalsAfterRoute);
    } finally {
      vi.useRealTimers();
    }
  });

  it("aborts the routing heartbeat when a lease renewal is lost", async () => {
    vi.useFakeTimers();
    try {
      const updateMany = vi
        .fn()
        .mockResolvedValueOnce({ count: 1 })
        .mockResolvedValueOnce({ count: 0 });
      const bridge = new TeamChatBridge({
        prisma: { externalMessage: { updateMany } } as unknown as PrismaClient,
        events: { sendUserMessage: vi.fn() },
        jobs: { enqueue: vi.fn() },
        send: vi.fn(),
        providerId: "slack",
        botId: "bot-1",
      });
      (
        bridge as unknown as {
          target: { id: string; spaceId: string; userId: string; name: string };
        }
      ).target = { id: "bot-1", spaceId: "space-1", userId: "owner-1", name: "Chief" };

      const leaseHeartbeat = await bridge.startDeferredReservationHeartbeat(
        "external-routing",
        1_000,
      );
      const lost = expect(leaseHeartbeat.lost).rejects.toThrow(
        /Team chat deferred reservation was lost/,
      );
      await vi.advanceTimersByTimeAsync(1_000);
      await lost;
      leaseHeartbeat.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps routing ownership when renewal fails while a reconciler runs", async () => {
    // Periodic renewal returns zero rows while routine delivery stays blocked.
    // Another reconciler must leave exclusive routing ownership in place instead
    // of promoting to a TeamChat agent run, even past the former grace window.
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    try {
      let held = true;
      let leaseUntil = new Date(0);
      let engagementReason: string | null = null;
      const sendUserMessage = vi.fn();
      const updateMany = vi.fn(
        async (input: {
          where?: {
            id?: string;
            status?: string | { in?: string[] };
            nextAttemptAt?: unknown;
          };
          data?: {
            nextAttemptAt?: Date | null;
            status?: string;
            engagementReason?: string | null;
          };
        }) => {
          const isRoutingHold =
            input.where?.status === "deferred" &&
            input.data?.nextAttemptAt instanceof Date &&
            (input.data.engagementReason === "message_routine_routing" ||
              input.data.engagementReason === "message_routine_routing_rearmed") &&
            input.data.status === undefined;
          // Heartbeat renewals omit nextAttemptAt from the where clause.
          if (isRoutingHold && input.where?.nextAttemptAt === undefined) {
            if (!held) return { count: 0 };
            leaseUntil = input.data!.nextAttemptAt as Date;
            engagementReason = input.data!.engagementReason ?? "message_routine_routing";
            return { count: 1 };
          }
          if (
            input.where?.status === "deferred" &&
            (input.data?.status === "received" || input.data?.status === "observed")
          ) {
            engagementReason = input.data.engagementReason ?? null;
            leaseUntil = new Date(0);
            return { count: 1 };
          }
          return { count: 1 };
        },
      );
      const findMany = vi.fn(async ({ where }: { where: { status?: string } }) => {
        if (where.status === "deferred" && leaseUntil.getTime() <= Date.now()) {
          return [
            {
              id: "external-lost",
              kind: "mention",
              providerEventId: "Ev-lost",
              engagementReason,
              nextAttemptAt: leaseUntil,
              externalConversation: { thread: { id: "thread-1" } },
            },
          ];
        }
        return [];
      });
      const bridge = new TeamChatBridge({
        prisma: {
          externalMessage: { updateMany, findMany },
          event: { findFirst: vi.fn(async () => null) },
          run: { findMany: vi.fn(async () => []) },
        } as unknown as PrismaClient,
        events: { sendUserMessage },
        jobs: { enqueue: vi.fn() },
        send: vi.fn(),
        providerId: "slack",
        botId: "bot-1",
      });
      (
        bridge as unknown as {
          target: { id: string; spaceId: string; userId: string; name: string };
        }
      ).target = { id: "bot-1", spaceId: "space-1", userId: "owner-1", name: "Chief" };

      const lease = await bridge.startDeferredReservationHeartbeat("external-lost", 60_000);
      expect(engagementReason).toBe("message_routine_routing");
      const lost = expect(lease.lost).rejects.toThrow("Team chat deferred reservation was lost");

      held = false;
      leaseUntil = new Date(Date.now() - 1);
      await vi.advanceTimersByTimeAsync(60_000);
      await lost;
      await bridge.reconcileOnce();

      expect(sendUserMessage).not.toHaveBeenCalled();
      expect(engagementReason).toBe("message_routine_routing");
      expect(updateMany).not.toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ id: "external-lost", status: "deferred" }),
          data: expect.objectContaining({ status: "received" }),
        }),
      );

      // Ownership survives the former two-minute grace window: reconcile must
      // not promote while an in-flight wake may still commit.
      leaseUntil = new Date(Date.now() - 1);
      await vi.advanceTimersByTimeAsync(2 * 60_000);
      await bridge.reconcileOnce();
      expect(engagementReason).toBe("message_routine_routing");
      expect(sendUserMessage).not.toHaveBeenCalled();
      expect(updateMany).not.toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ id: "external-lost", status: "deferred" }),
          data: expect.objectContaining({ status: "received", engagementReason: null }),
        }),
      );

      lease.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not promote a rearmed routing claim after grace while wake is blocked", async () => {
    // Heartbeat renewal fails; wake stays blocked past the old re-armed grace
    // window. First reconcile only drops orphaned ownership; it must not queue a
    // TeamChat run beside the wake in that same pass.
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    try {
      let leaseUntil = new Date(Date.now() - 1);
      let engagementReason: string | null = "message_routine_routing_rearmed";
      let status = "deferred";
      const sendUserMessage = vi.fn();
      const updateMany = vi.fn(
        async (input: {
          where?: { id?: string; status?: string | { in?: string[] } };
          data?: {
            nextAttemptAt?: Date | null;
            status?: string;
            engagementReason?: string | null;
          };
        }) => {
          if (
            input.where?.id === "external-grace" &&
            (input.data?.status === "received" || input.data?.status === "queueing")
          ) {
            status = input.data.status;
            engagementReason = input.data.engagementReason ?? null;
            leaseUntil = input.data.nextAttemptAt ?? new Date(0);
            return { count: 1 };
          }
          if (
            input.where?.id === "external-grace" &&
            input.data?.nextAttemptAt instanceof Date &&
            input.data.status === undefined
          ) {
            leaseUntil = input.data.nextAttemptAt;
            if ("engagementReason" in (input.data ?? {})) {
              engagementReason = input.data.engagementReason ?? null;
            }
            return { count: 1 };
          }
          return { count: 0 };
        },
      );
      const findMany = vi.fn(
        async ({ where }: { where: { status?: string | { in?: string[] } } }) => {
          if (
            where.status === "deferred" &&
            status === "deferred" &&
            leaseUntil.getTime() <= Date.now()
          ) {
            return [
              {
                id: "external-grace",
                kind: "mention",
                providerEventId: "Ev-grace",
                engagementReason,
                nextAttemptAt: leaseUntil,
                externalConversation: {
                  spaceId: "space-1",
                  botId: "bot-1",
                  userId: "owner-1",
                  thread: { id: "thread-1" },
                },
              },
            ];
          }
          if (where.status === "received" && status === "received") {
            return [
              {
                id: "external-grace",
                kind: "mention",
                providerEventId: "Ev-grace",
                senderId: "U-1",
                senderName: "Ada",
                content: "hello",
                batchContext: null,
                engagementReason,
                nextAttemptAt: null,
                externalConversation: {
                  spaceId: "space-1",
                  botId: "bot-1",
                  userId: "owner-1",
                  thread: { id: "thread-1" },
                },
              },
            ];
          }
          return [];
        },
      );
      const bridge = new TeamChatBridge({
        prisma: {
          externalMessage: {
            updateMany,
            findMany,
            findUnique: vi.fn(async () => ({
              status,
              engagementReason,
            })),
          },
          event: { findFirst: vi.fn(async () => null) },
          run: { findMany: vi.fn(async () => []) },
        } as unknown as PrismaClient,
        events: { sendUserMessage },
        jobs: { enqueue: vi.fn() },
        send: vi.fn(),
        providerId: "slack",
        botId: "bot-1",
      });
      (
        bridge as unknown as {
          target: { id: string; spaceId: string; userId: string; name: string };
        }
      ).target = { id: "bot-1", spaceId: "space-1", userId: "owner-1", name: "Chief" };

      // Past the former two-minute re-armed grace; wake still blocked (no nonce).
      await vi.advanceTimersByTimeAsync(3 * 60_000);
      await bridge.reconcileOnce();

      expect(status).toBe("deferred");
      expect(engagementReason).toBeNull();
      expect(sendUserMessage).not.toHaveBeenCalled();
      expect(updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            id: "external-grace",
            status: "deferred",
            engagementReason: {
              in: ["message_routine_routing", "message_routine_routing_rearmed"],
            },
          }),
          data: { engagementReason: null, nextAttemptAt: expect.any(Date) },
        }),
      );
      expect(updateMany).not.toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ id: "external-grace" }),
          data: expect.objectContaining({ status: "received" }),
        }),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("promotes deferred rows that still carry an ambient engagement reason", async () => {
    const updateMany = vi.fn(async () => ({ count: 1 }));
    const findMany = vi.fn(async ({ where }: { where: { status?: string } }) =>
      where.status === "deferred"
        ? [
            {
              id: "external-ambient",
              kind: "ambient",
              providerEventId: "Ev-ambient",
              engagementReason: "Channel may need a reply",
              nextAttemptAt: new Date(Date.now() - 1_000),
              externalConversation: { thread: { id: "thread-1" } },
            },
          ]
        : [],
    );
    const bridge = new TeamChatBridge({
      prisma: {
        externalMessage: { updateMany, findMany },
        event: { findFirst: vi.fn(async () => null) },
        run: { findMany: vi.fn(async () => []) },
      } as unknown as PrismaClient,
      events: { sendUserMessage: vi.fn() },
      jobs: { enqueue: vi.fn() },
      send: vi.fn(),
      providerId: "slack",
      botId: "bot-1",
    });
    (
      bridge as unknown as {
        target: { id: string; spaceId: string; userId: string; name: string };
      }
    ).target = { id: "bot-1", spaceId: "space-1", userId: "owner-1", name: "Chief" };

    await bridge.reconcileOnce();

    expect(updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: "external-ambient",
          status: "deferred",
          OR: [
            { engagementReason: null },
            {
              NOT: {
                engagementReason: {
                  in: [
                    "message_routine_routing",
                    "message_routine_routing_rearmed",
                    "message_teamchat_agent",
                  ],
                },
              },
            },
          ],
        }),
        data: expect.objectContaining({ status: "observed", engagementReason: null }),
      }),
    );
  });

  it("clears expired routing ownership during reconcile so orphans are not stuck", async () => {
    const updateMany = vi.fn(async () => ({ count: 1 }));
    const findMany = vi.fn(async ({ where }: { where: { status?: string } }) =>
      where.status === "deferred"
        ? [
            {
              id: "external-orphan",
              kind: "mention",
              providerEventId: "Ev-orphan",
              engagementReason: "message_routine_routing",
              nextAttemptAt: new Date(Date.now() - 1_000),
              externalConversation: { thread: { id: "thread-1" } },
            },
          ]
        : [],
    );
    const bridge = new TeamChatBridge({
      prisma: {
        externalMessage: { updateMany, findMany },
        event: { findFirst: vi.fn(async () => null) },
        run: { findMany: vi.fn(async () => []) },
      } as unknown as PrismaClient,
      events: { sendUserMessage: vi.fn() },
      jobs: { enqueue: vi.fn() },
      send: vi.fn(),
      providerId: "slack",
      botId: "bot-1",
    });
    (
      bridge as unknown as {
        target: { id: string; spaceId: string; userId: string; name: string };
      }
    ).target = { id: "bot-1", spaceId: "space-1", userId: "owner-1", name: "Chief" };

    await bridge.reconcileOnce();

    expect(updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: "external-orphan",
          engagementReason: {
            in: ["message_routine_routing", "message_routine_routing_rearmed"],
          },
        }),
        data: { engagementReason: null, nextAttemptAt: expect.any(Date) },
      }),
    );
    expect(updateMany).not.toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: "external-orphan" }),
        data: expect.objectContaining({ status: "received" }),
      }),
    );
  });

  it("keeps in-flight routine wakes exclusive after lease expiry", async () => {
    const updateMany = vi.fn(async () => ({ count: 1 }));
    const findMany = vi.fn(async ({ where }: { where: { status?: string } }) =>
      where.status === "deferred"
        ? [
            {
              id: "external-inflight",
              kind: "mention",
              providerEventId: "Ev-inflight",
              engagementReason: "message_routine_routing",
              nextAttemptAt: new Date(Date.now() - 1_000),
              externalConversation: { thread: { id: "thread-1" } },
            },
          ]
        : [],
    );
    const bridge = new TeamChatBridge({
      prisma: {
        externalMessage: { updateMany, findMany },
        event: { findFirst: vi.fn(async () => null) },
        run: { findMany: vi.fn(async () => []) },
      } as unknown as PrismaClient,
      events: { sendUserMessage: vi.fn() },
      jobs: { enqueue: vi.fn() },
      send: vi.fn(),
      providerId: "slack",
      botId: "bot-1",
    });
    (
      bridge as unknown as {
        target: { id: string; spaceId: string; userId: string; name: string };
      }
    ).target = { id: "bot-1", spaceId: "space-1", userId: "owner-1", name: "Chief" };
    bridge.markRoutineWakeInFlight("external-inflight");

    await bridge.reconcileOnce();

    expect(updateMany).not.toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: "external-inflight" }),
        data: expect.objectContaining({ engagementReason: null }),
      }),
    );
    expect(updateMany).not.toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: "external-inflight" }),
        data: expect.objectContaining({ status: "received" }),
      }),
    );
    bridge.clearRoutineWakeInFlight("external-inflight");
  });

  it("releases only expired routing ownership before startup reconciliation", async () => {
    const updateMany = vi.fn(async () => ({ count: 1 }));
    const findMany = vi.fn(async () => []);
    const bridge = new TeamChatBridge({
      prisma: {
        bot: {
          findFirst: vi.fn(async () => ({
            id: "bot-1",
            spaceId: "space-1",
            userId: "owner-1",
            name: "Chief",
            modelProvider: null,
            modelId: null,
          })),
        },
        externalMessage: {
          findMany,
          updateMany,
        },
        run: { findMany: vi.fn(async () => []) },
      } as unknown as PrismaClient,
      events: { sendUserMessage: vi.fn() },
      jobs: { enqueue: vi.fn() },
      send: vi.fn(),
      providerId: "slack",
      botId: "bot-1",
      reconcileIntervalMs: 60_000,
    });

    await bridge.start();
    await bridge.stop();

    expect(updateMany).toHaveBeenCalledWith({
      where: {
        status: "deferred",
        engagementReason: {
          in: ["message_routine_routing", "message_routine_routing_rearmed"],
        },
        nextAttemptAt: { lte: expect.any(Date) },
        externalConversation: { provider: "slack", botId: "bot-1", spaceId: "space-1" },
      },
      data: { engagementReason: null, nextAttemptAt: expect.any(Date) },
    });
  });

  it("releases expired routing ownership even when transcript mirroring fails", async () => {
    const updateMany = vi.fn(async () => ({ count: 1 }));
    const findMany = vi.fn(async () => {
      throw new Error("mirror failed");
    });
    const bridge = new TeamChatBridge({
      prisma: {
        bot: {
          findFirst: vi.fn(async () => ({
            id: "bot-1",
            spaceId: "space-1",
            userId: "owner-1",
            name: "Chief",
            modelProvider: null,
            modelId: null,
          })),
        },
        externalMessage: { findMany, updateMany },
        run: { findMany: vi.fn(async () => []) },
      } as unknown as PrismaClient,
      events: { sendUserMessage: vi.fn() },
      jobs: { enqueue: vi.fn() },
      send: vi.fn(),
      providerId: "slack",
      botId: "bot-1",
    });

    await expect(bridge.start()).rejects.toThrow("mirror failed");
    expect(updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          engagementReason: {
            in: ["message_routine_routing", "message_routine_routing_rearmed"],
          },
          nextAttemptAt: { lte: expect.any(Date) },
        }),
      }),
    );
  });

  it("does not queue a received message that already woke a message routine", async () => {
    const updateMany = vi.fn(async () => ({ count: 1 }));
    const findUnique = vi.fn(async ({ where }: { where: { payload: { equals: string } } }) =>
      routineReceipt(where.payload.equals),
    );
    const sendUserMessage = vi.fn();
    const bridge = new TeamChatBridge({
      prisma: {
        externalMessage: { updateMany },
        event: { findFirst: findUnique },
        routine: { findMany: vi.fn(async () => []) },
      } as unknown as PrismaClient,
      events: { sendUserMessage },
      jobs: { enqueue: vi.fn() },
      send: vi.fn(),
      providerId: "slack",
      botId: "bot-1",
    });

    await (
      bridge as unknown as {
        queue(message: {
          id: string;
          providerEventId: string;
          senderId: string;
          senderName: string;
          content: string;
          batchContext: null;
          externalConversation: {
            spaceId: string;
            botId: string;
            userId: string;
            thread: { id: string };
          };
        }): Promise<void>;
      }
    ).queue({
      id: "external-received",
      providerEventId: "Ev-woken",
      senderId: "U-1",
      senderName: "Ada",
      content: "hello",
      batchContext: null,
      externalConversation: {
        spaceId: "space-1",
        botId: "bot-1",
        userId: "owner-1",
        thread: { id: "thread-1" },
      },
    });

    expect(findUnique).toHaveBeenCalled();
    expect(updateMany).toHaveBeenCalledWith({
      where: { id: "external-received", status: "received" },
      data: {
        status: "ignored",
        engagementReason: "message_routine_wake",
        nextAttemptAt: null,
      },
    });
    expect(sendUserMessage).not.toHaveBeenCalled();
  });

  it("abandons a queueing reservation when the wake nonce appears after claim", async () => {
    const updateMany = vi.fn(async () => ({ count: 1 }));
    const findUnique = vi
      .fn()
      .mockResolvedValueOnce(null)
      .mockImplementationOnce(({ where }: { where: { payload: { equals: string } } }) =>
        routineReceipt(where.payload.equals),
      );
    const sendUserMessage = vi.fn();
    const bridge = new TeamChatBridge({
      prisma: {
        externalMessage: { updateMany },
        event: { findFirst: findUnique },
        routine: { findMany: vi.fn(async () => []) },
      } as unknown as PrismaClient,
      events: { sendUserMessage },
      jobs: { enqueue: vi.fn() },
      send: vi.fn(),
      providerId: "slack",
      botId: "bot-1",
    });

    await (
      bridge as unknown as {
        queue(message: {
          id: string;
          providerEventId: string;
          senderId: string;
          senderName: string;
          content: string;
          batchContext: null;
          externalConversation: {
            spaceId: string;
            botId: string;
            userId: string;
            thread: { id: string };
          };
        }): Promise<void>;
      }
    ).queue({
      id: "external-claimed",
      providerEventId: "Ev-woken",
      senderId: "U-1",
      senderName: "Ada",
      content: "hello",
      batchContext: null,
      externalConversation: {
        spaceId: "space-1",
        botId: "bot-1",
        userId: "owner-1",
        thread: { id: "thread-1" },
      },
    });

    expect(updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id: "external-claimed",
          status: "received",
          OR: [
            { engagementReason: null },
            {
              NOT: {
                engagementReason: {
                  in: [
                    "message_routine_routing",
                    "message_routine_routing_rearmed",
                    "message_teamchat_agent",
                  ],
                },
              },
            },
          ],
        },
        data: expect.objectContaining({
          status: "queueing",
          engagementReason: "message_teamchat_agent",
        }),
      }),
    );
    expect(updateMany).toHaveBeenCalledWith({
      where: { id: "external-claimed", status: "queueing", runId: null },
      data: {
        status: "ignored",
        engagementReason: "message_routine_wake",
        nextAttemptAt: null,
      },
    });
    expect(sendUserMessage).not.toHaveBeenCalled();
  });

  it("blocks fallback queueing when an in-flight wake commits after the queueing claim", async () => {
    // Lost-lease path can promote/queue while wakeMessageRoutines is still in
    // flight. The final pre-create barrier must see the routine nonce and abandon
    // before creating a distinct TeamChat agent run.
    const updateMany = vi.fn(async () => ({ count: 1 }));
    const messageFindUnique = vi
      .fn()
      .mockResolvedValueOnce(null) // pre-claim
      .mockResolvedValueOnce(null) // post-claim
      .mockImplementationOnce(({ where }: { where: { payload: { equals: string } } }) =>
        routineReceipt(where.payload.equals),
      ); // final barrier
    const sendUserMessage = vi.fn();
    const bridge = new TeamChatBridge({
      prisma: {
        externalMessage: {
          updateMany,
          findUnique: vi.fn(async () => ({
            status: "queueing",
            engagementReason: "message_teamchat_agent",
          })),
        },
        event: { findFirst: messageFindUnique },
        routine: { findMany: vi.fn(async () => []) },
      } as unknown as PrismaClient,
      events: { sendUserMessage },
      jobs: { enqueue: vi.fn() },
      send: vi.fn(),
      providerId: "slack",
      botId: "bot-1",
    });

    await (
      bridge as unknown as {
        queue(message: {
          id: string;
          providerEventId: string;
          senderId: string;
          senderName: string;
          content: string;
          batchContext: null;
          engagementReason?: string | null;
          externalConversation: {
            spaceId: string;
            botId: string;
            userId: string;
            thread: { id: string };
          };
        }): Promise<void>;
      }
    ).queue({
      id: "external-raced",
      providerEventId: "Ev-raced",
      senderId: "U-1",
      senderName: "Ada",
      content: "hello",
      batchContext: null,
      engagementReason: null,
      externalConversation: {
        spaceId: "space-1",
        botId: "bot-1",
        userId: "owner-1",
        thread: { id: "thread-1" },
      },
    });

    expect(messageFindUnique).toHaveBeenCalledTimes(3);
    expect(updateMany).toHaveBeenCalledWith({
      where: { id: "external-raced", status: "queueing", runId: null },
      data: {
        status: "ignored",
        engagementReason: "message_routine_wake",
        nextAttemptAt: null,
      },
    });
    expect(sendUserMessage).not.toHaveBeenCalled();
  });

  it("blocks fallback queueing when routing ownership remains after lease loss", async () => {
    const updateMany = vi.fn(async () => ({ count: 1 }));
    const sendUserMessage = vi.fn();
    const bridge = new TeamChatBridge({
      prisma: {
        externalMessage: {
          updateMany,
          findUnique: vi.fn(async () => ({
            status: "queueing",
            engagementReason: "message_routine_routing",
          })),
        },
        event: { findFirst: vi.fn(async () => null) },
      } as unknown as PrismaClient,
      events: { sendUserMessage },
      jobs: { enqueue: vi.fn() },
      send: vi.fn(),
      providerId: "slack",
      botId: "bot-1",
    });

    await (
      bridge as unknown as {
        queue(message: {
          id: string;
          providerEventId: string;
          senderId: string;
          senderName: string;
          content: string;
          batchContext: null;
          engagementReason?: string | null;
          externalConversation: {
            spaceId: string;
            botId: string;
            userId: string;
            thread: { id: string };
          };
        }): Promise<void>;
      }
    ).queue({
      id: "external-owned",
      providerEventId: "Ev-owned",
      senderId: "U-1",
      senderName: "Ada",
      content: "hello",
      batchContext: null,
      // Snapshot missed ownership (e.g. stale reconcile read after lease loss).
      engagementReason: null,
      externalConversation: {
        spaceId: "space-1",
        botId: "bot-1",
        userId: "owner-1",
        thread: { id: "thread-1" },
      },
    });

    expect(updateMany).toHaveBeenCalledWith({
      where: { id: "external-owned", status: "queueing", runId: null },
      data: {
        status: "ignored",
        engagementReason: "message_routine_wake",
        nextAttemptAt: null,
      },
    });
    expect(sendUserMessage).not.toHaveBeenCalled();
  });

  it("does not queue a stale received snapshot after another path deferred it", async () => {
    const updateMany = vi.fn(async () => ({ count: 0 }));
    const sendUserMessage = vi.fn();
    const bridge = new TeamChatBridge({
      prisma: {
        externalMessage: { updateMany },
        event: { findFirst: vi.fn(async () => null) },
      } as unknown as PrismaClient,
      events: { sendUserMessage },
      jobs: { enqueue: vi.fn() },
      send: vi.fn(),
      providerId: "slack",
      botId: "bot-1",
    });

    await (
      bridge as unknown as {
        queue(message: {
          id: string;
          providerEventId: string;
          senderId: string;
          senderName: string;
          content: string;
          batchContext: null;
          externalConversation: {
            spaceId: string;
            botId: string;
            userId: string;
            thread: { id: string };
          };
        }): Promise<void>;
      }
    ).queue({
      id: "external-1",
      providerEventId: "Ev-1",
      senderId: "U-1",
      senderName: "Ada",
      content: "Run the release routine",
      batchContext: null,
      externalConversation: {
        spaceId: "space-1",
        botId: "bot-1",
        userId: "owner-1",
        thread: { id: "thread-1" },
      },
    });

    expect(updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: "external-1", status: "received" }),
      }),
    );
    expect(sendUserMessage).not.toHaveBeenCalled();
  });

  it("repairs previously observed messages that do not have transcript rows", async () => {
    const conversation = {
      id: "conversation-legacy",
      provider: "slack",
      workspaceId: "T-1",
      conversationId: "C-1",
      spaceId: "space-1",
      botId: "bot-1",
      userId: "owner-1",
      thread: { id: "thread-legacy" },
    };
    const record = {
      id: "external-legacy",
      providerEventId: "Ev-legacy",
      senderName: "Pat",
      content: "This ordinary message was already observed.",
      threadMessageId: null as string | null,
      status: "ignored",
      externalConversation: conversation,
    };
    const sendUserMessage = vi.fn(async () => ({
      messageId: "message-visible",
      seq: 1,
      taskId: null,
      runId: null,
    }));
    const prisma = {
      bot: {
        findFirst: vi.fn(async () => ({
          id: "bot-1",
          spaceId: "space-1",
          userId: "owner-1",
          name: "Arthur",
          modelProvider: null,
          modelId: null,
        })),
      },
      externalMessage: {
        findMany: vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
          if (where.threadMessageId === null && record.threadMessageId === null) {
            return [{ ...record, externalConversation: conversation }];
          }
          return [];
        }),
        update: vi.fn(async ({ data }: { data: { threadMessageId?: string } }) => {
          if (data.threadMessageId) record.threadMessageId = data.threadMessageId;
          return record;
        }),
        updateMany: vi.fn(async () => ({ count: 0 })),
      },
      run: { findMany: vi.fn(async () => []) },
    } as unknown as PrismaClient;

    const bridge = new TeamChatBridge({
      prisma,
      events: { sendUserMessage },
      jobs: { enqueue: vi.fn() },
      send: vi.fn(),
      providerId: "slack",
      botId: "bot-1",
      reconcileIntervalMs: 60_000,
    });

    await bridge.start();
    await bridge.stop();

    expect(sendUserMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        threadId: "thread-legacy",
        blocks: [{ kind: "text", text: "This ordinary message was already observed." }],
        createRun: false,
      }),
    );
    expect(record.threadMessageId).toBe("message-visible");
  });
  it("does not reopen deliveries finalized as unconfirmed", async () => {
    const update = vi.fn();
    const updateMany = vi.fn(async () => ({ count: 0 }));
    const prisma = {
      externalMessage: {
        findUnique: vi.fn(async () => ({
          status: "delivered",
          providerReplyHandle: "unconfirmed",
        })),
        update,
        updateMany,
      },
    } as unknown as PrismaClient;

    const bridge = new TeamChatBridge({
      prisma,
      events: { sendUserMessage: vi.fn() },
      jobs: { enqueue: vi.fn() },
      send: vi.fn(),
      providerId: "slack",
      botId: "bot-1",
      reconcileIntervalMs: 60_000,
    });

    await (
      bridge as unknown as {
        retry: (
          message: { id: string; status: string; attempts: number },
          error: unknown,
        ) => Promise<void>;
      }
    ).retry({ id: "message-1", status: "delivering", attempts: 0 }, new Error("send failed"));

    expect(update).not.toHaveBeenCalled();
    expect(updateMany).not.toHaveBeenCalled();
  });

  it("only retries rows that are still delivering without a provider handle", async () => {
    const updateMany = vi.fn(async () => ({ count: 0 }));
    const prisma = {
      externalMessage: {
        findUnique: vi.fn(async () => ({
          status: "delivering",
          providerReplyHandle: null,
        })),
        update: vi.fn(),
        updateMany,
      },
    } as unknown as PrismaClient;

    const bridge = new TeamChatBridge({
      prisma,
      events: { sendUserMessage: vi.fn() },
      jobs: { enqueue: vi.fn() },
      send: vi.fn(),
      providerId: "slack",
      botId: "bot-1",
      reconcileIntervalMs: 60_000,
    });

    await (
      bridge as unknown as {
        retry: (
          message: { id: string; status: string; attempts: number },
          error: unknown,
        ) => Promise<void>;
      }
    ).retry({ id: "message-2", status: "running", attempts: 1 }, new Error("send failed"));

    expect(updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id: "message-2",
          providerReplyHandle: null,
          status: "delivering",
        },
        data: expect.objectContaining({
          status: "delivering",
          attempts: 2,
          lastError: "send failed",
        }),
      }),
    );
  });

  it("does not reopen a linked run from a stale received snapshot", async () => {
    const updateMany = vi.fn(async () => ({ count: 1 }));
    const prisma = {
      externalMessage: {
        findUnique: vi.fn(async () => ({
          status: "running",
          providerReplyHandle: null,
        })),
        update: vi.fn(),
        updateMany,
      },
    } as unknown as PrismaClient;
    const bridge = new TeamChatBridge({
      prisma,
      events: { sendUserMessage: vi.fn() },
      jobs: { enqueue: vi.fn() },
      send: vi.fn(),
      providerId: "slack",
      botId: "bot-1",
    });

    await (
      bridge as unknown as {
        retry: (
          message: { id: string; status: string; attempts: number },
          error: unknown,
        ) => Promise<void>;
      }
    ).retry({ id: "message-3", status: "received", attempts: 0 }, new Error("enqueue failed"));

    expect(updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id: "message-3",
          providerReplyHandle: null,
          status: "running",
        },
        data: expect.objectContaining({ status: "running", lastError: "enqueue failed" }),
      }),
    );
  });
});
