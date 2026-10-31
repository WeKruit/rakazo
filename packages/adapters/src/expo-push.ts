import { randomUUID } from "node:crypto";
import type {
  AdapterContext,
  NotificationMessage,
  NotificationProvider,
} from "@rakazo/adapter-kit";
import type { PrismaClient } from "@rakazo/db";
import { claimConversationNotification } from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import { combineSignals } from "./connector-safety.js";
import { readBodyCapped, withAbort } from "./web-ssrf.js";

const EXPO_PUSH_TIMEOUT_MS = 15_000;
export const MAX_EXPO_PUSH_RESPONSE_BYTES = 64 * 1024;

/** Data a notification tap uses to open the bot or group thread in its space.
 * `deliveryId` distinguishes this send from another push for the same thread:
 * the Expo request identifier stays the thread id. */
export function expoPushData(message: NotificationMessage, spaceId: string, deliveryId: string) {
  return {
    kind: message.kind,
    botId: message.botId,
    threadId: message.threadId,
    deliveryId,
    ...(spaceId ? { spaceId } : {}),
    ...(message.groupId ? { groupId: message.groupId } : {}),
  };
}

export type PushTokenDb = Pick<PrismaClient, "pushToken" | "$transaction">;

/** Registration found that its session was already gone. */
export class PushSessionEndedError extends Error {
  constructor() {
    super("Push session ended");
    this.name = "PushSessionEndedError";
  }
}

/** Expiry of the session that registered a token, or null when that session is gone. */
export type PushSessionExpiresAt = (sessionId: string) => Promise<Date | null>;

export async function loadPushToken(
  prisma: PushTokenDb,
  userId: string,
): Promise<string | undefined> {
  return (await prisma.pushToken.findUnique({ where: { userId } }))?.token;
}

function isUniqueViolation(error: unknown): boolean {
  return (error as { code?: unknown } | null)?.code === "P2002";
}

/**
 * A device token belongs to one account: saving it removes it from every other user, so a
 * handed-over device stops receiving the previous account's pushes. The session check holds the
 * session row until the write commits, so a sign-out cannot land between the check and the save.
 */
export async function savePushToken(
  prisma: PushTokenDb,
  userId: string,
  token: string,
  sessionId?: string,
): Promise<void> {
  const value = token.trim();
  const data = { token: value, sessionId: sessionId ?? null };
  for (let attempt = 0; ; attempt += 1) {
    try {
      await prisma.$transaction(async (tx) => {
        if (sessionId) {
          const live = await tx.$queryRaw<Array<{ id: string }>>`
            SELECT "id" FROM "session" WHERE "id" = ${sessionId} AND "expiresAt" > (now() AT TIME ZONE 'UTC') FOR SHARE`;
          if (live.length === 0) throw new PushSessionEndedError();
        }
        await tx.pushToken.deleteMany({ where: { token: value, NOT: { userId } } });
        await tx.pushToken.upsert({ where: { userId }, create: { userId, ...data }, update: data });
      });
      return;
    } catch (error) {
      // Two accounts saving one device token at once: the loser retries and takes it over.
      if (attempt < 2 && isUniqueViolation(error)) continue;
      throw error;
    }
  }
}

export async function deletePushToken(prisma: PushTokenDb, userId: string): Promise<void> {
  await prisma.pushToken.deleteMany({ where: { userId } });
}

/**
 * Ends the token registered by a session that is gone, or moves it to the session that replaced
 * it. Only a row still bound to that session changes, so a token another account has since
 * claimed, or one registered again, is left alone.
 */
export async function endSessionPushToken(
  prisma: PushTokenDb,
  userId: string,
  sessionId: string,
  nextSessionId?: string,
): Promise<void> {
  const where = { userId, sessionId };
  if (nextSessionId) {
    await prisma.pushToken.updateMany({ where, data: { sessionId: nextSessionId } });
  } else {
    await prisma.pushToken.deleteMany({ where });
  }
}

export type ExpoPushTicket = {
  status?: string;
  message?: string;
  details?: { error?: string };
};

export function expoPushTickets(body: unknown): ExpoPushTicket[] {
  if (!body || typeof body !== "object") return [];
  const data = (body as { data?: unknown }).data;
  if (Array.isArray(data)) {
    return data.filter((item): item is ExpoPushTicket => Boolean(item) && typeof item === "object");
  }
  if (data && typeof data === "object") return [data as ExpoPushTicket];
  return [];
}

export function expoPushErrorMessage(body: unknown, status: number): string | undefined {
  if (body && typeof body === "object" && "errors" in body) {
    const errors = (body as { errors?: Array<{ message?: string }> }).errors;
    if (Array.isArray(errors) && errors.length > 0) {
      return errors.map((error) => error.message ?? "expo push error").join("; ");
    }
  }
  const failed = expoPushTickets(body).filter((ticket) => ticket.status === "error");
  if (failed.length > 0) {
    return failed
      .map((ticket) => ticket.message ?? ticket.details?.error ?? "expo push ticket error")
      .join("; ");
  }
  if (status < 200 || status >= 300) return `expo push failed (${status})`;
  return undefined;
}

export class ExpoPushProvider implements NotificationProvider {
  constructor(
    private readonly prisma: PushTokenDb,
    private readonly sessionExpiresAt?: PushSessionExpiresAt,
  ) {}

  describe() {
    return {
      id: "expo-push",
      contractVersion: "1",
      adapterVersion: "0.1.0",
      capabilities: { push: true, email: false },
    };
  }

  async hasPushRecipient(userId: string): Promise<boolean> {
    return Boolean(await this.deliverableToken(userId));
  }

  async send(message: NotificationMessage, context: AdapterContext): Promise<void> {
    await this.deliver(message, context);
  }

  /**
   * Posts the push when a token is registered. `undeliverable` means this user
   * has no token, which is not an Expo acceptance — callers must not record it
   * as a successful reminder.
   */
  async deliver(message: NotificationMessage, context: AdapterContext): Promise<ExpoPushDelivery> {
    const token = await this.deliverableToken(context.userId);
    if (!token) return "undeliverable";
    const claim = await claimConversationNotification(this.prisma, {
      spaceId: context.spaceId,
      userId: context.userId,
      threadId: message.threadId,
      channel: "mobile",
      runId: context.runId,
      kind: message.kind,
    });
    if (!claim) return "suppressed";
    if ((await this.deliverableToken(context.userId)) !== token) return "undeliverable";
    const signal = combineSignals(context.signal, AbortSignal.timeout(EXPO_PUSH_TIMEOUT_MS));
    let response: Response;
    try {
      response = await fetch("https://exp.host/--/api/v2/push/send", {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({
          to: token,
          title: message.title,
          collapseId: message.threadId,
          tag: message.threadId,
          data: expoPushData(message, context.spaceId, randomUUID()),
        }),
        signal,
      });
    } catch (error) {
      getLogger().error("expo push request failed", error);
      throw error;
    }
    const body = await readExpoPushBody(response, signal);
    if (response.ok && body === undefined) {
      throw new Error("Expo push returned an invalid response.");
    }
    const failure = expoPushErrorMessage(body, response.status);
    if (!failure) return "delivered";
    getLogger().error(failure);
    throw new Error(failure);
  }

  /**
   * A token bound to a session is delivered only while that session is still
   * live. A missing row is left for session replacement to retarget; an expired
   * row is removed. The token is read again after the lookup so a handover
   * during that wait is not sent.
   */
  private async deliverableToken(userId: string): Promise<string | undefined> {
    const saved = await this.prisma.pushToken.findUnique({ where: { userId } });
    if (!saved?.token) return undefined;
    if (!saved.sessionId) return saved.token;
    if (!this.sessionExpiresAt) return undefined;
    let expiresAt: Date | null;
    try {
      expiresAt = await this.sessionExpiresAt(saved.sessionId);
    } catch (error) {
      getLogger().error("push session lookup failed", error);
      return undefined;
    }
    if (!expiresAt) return undefined;
    if (expiresAt.getTime() <= Date.now()) {
      await endSessionPushToken(this.prisma, userId, saved.sessionId);
      return undefined;
    }
    const current = await this.prisma.pushToken.findUnique({ where: { userId } });
    if (current?.token !== saved.token || current.sessionId !== saved.sessionId) return undefined;
    return current.token;
  }
}

export type ExpoPushDelivery = "delivered" | "undeliverable" | "suppressed";

async function readExpoPushBody(response: Response, signal: AbortSignal): Promise<unknown> {
  const declared = Number(response.headers.get("content-length") ?? 0);
  if (Number.isFinite(declared) && declared > MAX_EXPO_PUSH_RESPONSE_BYTES) {
    const cancel = response.body?.cancel() ?? Promise.resolve();
    await withAbort(
      cancel.catch(() => undefined),
      signal,
    ).catch(() => undefined);
    throw new Error("Expo push response is too large.");
  }
  try {
    const bytes = await readBodyCapped(response, MAX_EXPO_PUSH_RESPONSE_BYTES, signal);
    if (bytes.byteLength === 0) return undefined;
    return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  } catch (error) {
    if (error instanceof Error && error.message === "Response is too large") {
      throw new Error("Expo push response is too large.");
    }
    if (error instanceof SyntaxError) return undefined;
    throw error;
  }
}
