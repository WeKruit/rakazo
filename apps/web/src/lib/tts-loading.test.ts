import { afterEach, expect, it, vi } from "vitest";
import { Speaker } from "./tts.js";
import { SpeechEngine } from "./tts-engine.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("state, subscription and stop do not load the audio engine", () => {
  const load = vi.fn();
  const speaker = new Speaker(load);
  const watcher = vi.fn();
  const unsubscribe = speaker.subscribe(watcher);
  expect(speaker.state).toEqual({ status: "idle" });
  expect(speaker.isSpeaking()).toBe(false);
  speaker.stop();
  unsubscribe();
  expect(load).not.toHaveBeenCalled();
  expect(watcher).toHaveBeenCalledExactlyOnceWith({ status: "idle" });
});

it("stop settles pending speech and a late import cannot start RPC or audio", async () => {
  const loaded = deferred<{ SpeechEngine: typeof SpeechEngine }>();
  const speak = vi.spyOn(SpeechEngine.prototype, "speak");
  const fetch = vi.fn();
  vi.stubGlobal("fetch", fetch);
  const audio = vi.fn();
  vi.stubGlobal("Audio", audio);
  const speaker = new Speaker(() => loaded.promise);
  const pending = speaker.speak("old", { messageId: "old" });
  expect(speaker.state.status).toBe("preparing");
  speaker.stop();
  await pending;
  loaded.resolve({ SpeechEngine });
  await loaded.promise;
  await Promise.resolve();
  expect(speaker.state).toEqual({ status: "idle" });
  expect(speak).not.toHaveBeenCalled();
  expect(fetch).not.toHaveBeenCalled();
  expect(audio).not.toHaveBeenCalled();
});

it("only the latest speech starts after shared loading and retains its action-time space", async () => {
  const loaded = deferred<{ SpeechEngine: typeof SpeechEngine }>();
  let space = "space-a";
  const storage = { getItem: () => space };
  vi.stubGlobal("window", { localStorage: storage });
  vi.stubGlobal("localStorage", storage);
  const speak = vi.spyOn(SpeechEngine.prototype, "speak").mockResolvedValue();
  const speaker = new Speaker(() => loaded.promise);
  const first = speaker.speak("old", { messageId: "old" });
  space = "space-b";
  const second = speaker.speak("new", { messageId: "new" });
  space = "space-c";
  loaded.resolve({ SpeechEngine });
  await Promise.all([first, second]);
  expect(speak).toHaveBeenCalledExactlyOnceWith("new", { messageId: "new" }, "space-b");
});

it("an import failure becomes an error snapshot and a later speech can retry", async () => {
  const load = vi
    .fn()
    .mockRejectedValueOnce(new Error("Speech unavailable"))
    .mockResolvedValue({ SpeechEngine });
  vi.spyOn(SpeechEngine.prototype, "speak").mockResolvedValue();
  const speaker = new Speaker(load);
  await speaker.speak("first");
  expect(speaker.state).toEqual({ status: "idle", error: "Speech unavailable" });
  await speaker.speak("retry");
  expect(load).toHaveBeenCalledTimes(2);
});

it("forwards real engine state to existing subscribers and reuses the loaded engine", async () => {
  const prepare = vi
    .spyOn(SpeechEngine.prototype as unknown as { prepare: () => Promise<string[]> }, "prepare")
    .mockResolvedValue([]);
  const load = vi.fn().mockResolvedValue({ SpeechEngine });
  const speaker = new Speaker(load);
  const states: string[] = [];
  speaker.subscribe((state) => states.push(state.status));
  await speaker.speak("one");
  expect(speaker.state).toEqual({ status: "idle" });
  await speaker.speak("two");
  expect(load).toHaveBeenCalledTimes(1);
  expect(prepare).toHaveBeenCalledTimes(2);
  expect(states).toContain("preparing");
  expect(states.at(-1)).toBe("idle");
});
