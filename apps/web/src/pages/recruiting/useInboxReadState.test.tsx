// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";

vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children: unknown }) => children,
  useLingui: () => ({ t: (parts: TemplateStringsArray) => parts.join("") }),
}));
const session = vi.hoisted(() => ({ userId: "first" }));
const read = vi.hoisted(() => vi.fn());
const mark = vi.hoisted(() => vi.fn());
vi.mock("../../lib/auth", () => ({
  authClient: { useSession: () => ({ data: { user: { id: session.userId } } }) },
}));
vi.mock("../../lib/rpc", () => ({
  rpc: { recruiting: { inboxReadState: read, markInboxThread: mark } },
}));

import { createRecruitingReadCache } from "../../lib/recruiting-read-cache";
import type { EmailConversationItem } from "./EmailConversation";
import { RecruitingReadCacheContext } from "./shared";
import { useInboxReadState } from "./useInboxReadState";

afterEach(() => {
  read.mockReset();
  mark.mockReset();
});

it("hides the old reader immediately and ignores their late mutation in the same space", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const email = {
    id: "email",
    sourceId: "source",
    organizationId: null,
    eaccount: "mailbox",
    threadId: "thread",
    direction: "received",
    date: "2026-10-02T00:00:00Z",
  } as EmailConversationItem;
  const baseline = { initializedAt: "2026-10-01T00:00:00Z", items: [] };
  read.mockResolvedValueOnce(baseline);
  let finishRead!: (state: typeof baseline) => void;
  read.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finishRead = resolve;
      }),
  );
  let finishMark!: () => void;
  mark.mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        finishMark = resolve;
      }),
  );
  let controls!: ReturnType<typeof useInboxReadState>;
  const observed: (boolean | null)[] = [];
  function View() {
    controls = useInboxReadState("same-space", [email]);
    observed.push(controls.unread(email));
    return null;
  }
  const host = document.createElement("div");
  const root = createRoot(host);
  try {
    await act(async () => root.render(<View />));
    expect(controls.unread(email)).toBe(true);
    let mutation!: Promise<void>;
    await act(async () => {
      mutation = controls.mark(
        { sourceId: "source", organizationId: null, mailbox: "mailbox", threadId: "thread" },
        email.date!,
        false,
      );
    });
    expect(controls.pending).toBe(true);
    observed.length = 0;
    session.userId = "second";
    await act(async () => root.render(<View />));
    expect(observed.every((value) => value === null)).toBe(true);
    expect(controls.pending).toBe(false);
    expect(controls.ready).toBe(false);
    await act(async () => {
      finishMark();
      await mutation;
    });
    expect(read).toHaveBeenCalledTimes(2);
    expect(controls.ready).toBe(false);
    await act(async () => finishRead(baseline));
    expect(controls.ready).toBe(true);
  } finally {
    await act(async () => root.unmount());
    vi.unstubAllGlobals();
  }
});

it("reads every loaded thread in bounded batches, including saved unread after thread 200", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const emails = Array.from({ length: 201 }, (_, index) => ({
    id: `email-${index}`,
    sourceId: "source",
    organizationId: null,
    eaccount: "mailbox",
    threadId: `thread-${index}`,
    direction: "received",
    date: "2026-10-01T00:00:00Z",
  })) as EmailConversationItem[];
  const savedKey = JSON.stringify(["source", null, "mailbox", "thread-200"]);
  read.mockImplementation(async ({ threads }: { threads: { threadId: string }[] }) => ({
    initializedAt: "2026-10-02T00:00:00Z",
    items: threads.some((thread) => thread.threadId === "thread-200")
      ? [{ key: savedKey, lastReadAt: null, unread: true }]
      : [],
  }));
  let controls!: ReturnType<typeof useInboxReadState>;
  function View() {
    controls = useInboxReadState("space", emails);
    return null;
  }
  const root = createRoot(document.createElement("div"));
  try {
    await act(async () => root.render(<View />));
    expect(read.mock.calls.map(([input]) => input.threads.length)).toEqual([200, 1]);
    expect(controls.unread(emails[0]!)).toBe(false);
    expect(controls.unread(emails[200]!)).toBe(true);
    expect(controls.ready).toBe(true);
  } finally {
    await act(async () => root.unmount());
    vi.unstubAllGlobals();
  }
});

it("invalidates this account's saved-mail navigation count after a successful mark", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  session.userId = "reader";
  read.mockResolvedValue({ initializedAt: "2026-10-01T00:00:00Z", items: [] });
  mark.mockResolvedValue({ ok: true });
  const cache = createRecruitingReadCache();
  const invalidate = vi.spyOn(cache.client, "invalidateQueries");
  const email = {
    id: "mail",
    sourceId: "source",
    organizationId: null,
    eaccount: "host",
    threadId: "thread",
    direction: "received",
    date: "2026-10-02T00:00:00Z",
  } as EmailConversationItem;
  let controls!: ReturnType<typeof useInboxReadState>;
  function View() {
    controls = useInboxReadState("space", [email]);
    return null;
  }
  const root = createRoot(document.createElement("div"));
  try {
    await act(async () =>
      root.render(
        <RecruitingReadCacheContext.Provider value={cache}>
          <View />
        </RecruitingReadCacheContext.Provider>,
      ),
    );
    await act(async () =>
      controls.mark(
        { sourceId: "source", organizationId: null, mailbox: "host", threadId: "thread" },
        email.date!,
        false,
      ),
    );
    expect(invalidate).toHaveBeenCalledWith({
      queryKey: ["recruiting", `global-inbox:${JSON.stringify(["reader", "space"])}`],
    });
  } finally {
    await act(async () => root.unmount());
    cache.client.clear();
    vi.unstubAllGlobals();
  }
});
