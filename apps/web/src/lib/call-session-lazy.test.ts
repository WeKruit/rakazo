import { afterEach, beforeEach, expect, it, vi } from "vitest";

vi.mock("./user-error.js", () => ({ errorText: () => "Could not start call" }));
let voice: typeof import("./call-session");
let state: typeof import("./call-session-state");
let resolve!: () => void;
let reject!: (error: Error) => void;
let loads: number;
const runtime = {
  startCall: vi.fn(),
  endCall: vi.fn(),
  discardCall: vi.fn(),
  toggleMute: vi.fn(),
  toggleTranscript: vi.fn(),
};
const call = { userId: "owner", spaceId: "space", botId: "bot", botName: "Example" };
beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();
  loads = 0;
  const ready = new Promise<void>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  vi.doMock("./call-session-engine.js", async () => {
    loads++;
    await ready;
    return runtime;
  });
  state = await import("./call-session-state");
  runtime.startCall.mockImplementation((input, initial) =>
    state.replaceCallState({ ...state.newCallState(input), ...initial }),
  );
  runtime.discardCall.mockImplementation(() => state.replaceCallState(null));
  runtime.endCall.mockImplementation(() => state.replaceCallState(null));
  voice = await import("./call-session");
});
afterEach(async () => {
  voice.discardCall();
  resolve();
  await vi.dynamicImportSettled();
  vi.doUnmock("./call-session-engine.js");
});

it("does not load voice implementation for idle subscription or auth cleanup", () => {
  const changed = vi.fn();
  const stop = voice.subscribe(changed);
  expect(voice.getSnapshot("owner", "space")).toBeNull();
  voice.discardCall();
  stop();
  expect(loads).toBe(0);
  expect(runtime.startCall).not.toHaveBeenCalled();
});
it("shows pending owned state immediately and starts only after module loading", async () => {
  voice.startCall(call);
  expect(voice.getSnapshot("owner", "space")).toMatchObject({ botId: "bot", phase: "thinking" });
  expect(voice.getSnapshot("other", "space")).toBeNull();
  expect(voice.getSnapshot("owner", "other-space")).toBeNull();
  expect(runtime.startCall).not.toHaveBeenCalled();
  resolve();
  await vi.dynamicImportSettled();
  expect(runtime.startCall).toHaveBeenCalledOnce();
  expect(voice.getSnapshot("owner", "space")?.phase).toBe("listening");
});
it.each(["discardCall", "endCall"] as const)(
  "%s cancels pending loading synchronously without starting or closing a server call",
  async (action) => {
    voice.startCall(call);
    voice[action]();
    expect(voice.getSnapshot("owner", "space")).toBeNull();
    resolve();
    await vi.dynamicImportSettled();
    expect(runtime.startCall).not.toHaveBeenCalled();
    expect(runtime.endCall).not.toHaveBeenCalled();
  },
);
it("starts only the latest account/Space request when loading finishes", async () => {
  voice.startCall(call);
  voice.discardCall();
  const next = { ...call, userId: "next", spaceId: "next-space", botId: "next-bot" };
  voice.startCall(next);
  resolve();
  await vi.dynamicImportSettled();
  expect(runtime.startCall).toHaveBeenCalledOnce();
  expect(runtime.startCall).toHaveBeenCalledWith(next, expect.any(Object));
  expect(voice.getSnapshot("owner", "space")).toBeNull();
});
it("preserves mute and transcript choices made before the microphone implementation loads", async () => {
  voice.startCall(call);
  voice.toggleMute();
  voice.toggleTranscript();
  const startedAt = voice.getSnapshot("owner", "space")!.startedAt;
  resolve();
  await vi.dynamicImportSettled();
  expect(runtime.startCall).toHaveBeenCalledWith(call, {
    muted: true,
    transcriptOpen: true,
    startedAt,
  });
});
it("delegates synchronously after loading, including owner discard", async () => {
  voice.startCall(call);
  resolve();
  await vi.dynamicImportSettled();
  runtime.startCall.mockClear();
  voice.startCall({ ...call, botId: "second" });
  expect(runtime.startCall).toHaveBeenCalledOnce();
  voice.toggleMute();
  voice.toggleTranscript();
  voice.discardCall();
  expect(runtime.toggleMute).toHaveBeenCalledOnce();
  expect(runtime.toggleTranscript).toHaveBeenCalledOnce();
  expect(runtime.discardCall).toHaveBeenCalledOnce();
  expect(voice.getSnapshot("owner", "space")).toBeNull();
});
it("reports loading failure only to the pending owner and remains dismissible", async () => {
  voice.startCall(call);
  reject(new Error("offline"));
  await vi.dynamicImportSettled();
  expect(voice.getSnapshot("owner", "space")?.caption).toBe("Could not start call");
  expect(runtime.startCall).not.toHaveBeenCalled();
  voice.endCall();
  expect(voice.getSnapshot("owner", "space")).toBeNull();
});
it("does not restore a discarded owner on a late loading failure", async () => {
  voice.startCall(call);
  voice.discardCall();
  reject(new Error("offline"));
  await vi.dynamicImportSettled();
  expect(voice.getSnapshot("owner", "space")).toBeNull();
});
