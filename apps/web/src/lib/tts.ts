import { selectedSpaceId } from "./rpc.js";
import type { SpeechEngine } from "./tts-engine.js";
import type { SpeakOptions, SpeechSnapshot } from "./tts-types.js";
import { errorText } from "./user-error.js";

export type { SpeechSnapshot, SpeechStatus } from "./tts-types.js";
export { MAX_VOICE_AUDIO_BYTES, VOICE_RESPONSE_TIMEOUT_MS } from "./tts-types.js";

const IDLE: SpeechSnapshot = { status: "idle" };
type LoadEngine = () => Promise<{ SpeechEngine: typeof SpeechEngine }>;

/** State and cancellation stay synchronous; audio code is needed only for speech. */
export class Speaker {
  private snapshot: SpeechSnapshot = IDLE;
  private watchers = new Set<(snapshot: SpeechSnapshot) => void>();
  private engine: SpeechEngine | undefined;
  private pending: AbortController | undefined;

  constructor(private loadEngine: LoadEngine = () => import("./tts-engine.js")) {}

  subscribe(watcher: (snapshot: SpeechSnapshot) => void): () => void {
    this.watchers.add(watcher);
    watcher(this.snapshot);
    return () => {
      this.watchers.delete(watcher);
    };
  }

  get state(): SpeechSnapshot {
    return this.snapshot;
  }

  private set(snapshot: SpeechSnapshot) {
    this.snapshot = snapshot;
    for (const watcher of [...this.watchers]) watcher(snapshot);
  }

  isSpeaking(messageId?: string): boolean {
    return this.snapshot.status !== "idle" && (!messageId || this.snapshot.messageId === messageId);
  }

  stop() {
    this.pending?.abort();
    this.pending = undefined;
    this.engine?.stop();
    if (this.snapshot.status !== "idle" || this.snapshot.error) this.set(IDLE);
  }

  async speak(text: string, options: SpeakOptions = {}): Promise<void> {
    this.stop();
    const request = new AbortController();
    this.pending = request;
    const spaceId = selectedSpaceId();
    const live = () => this.pending === request && !request.signal.aborted;
    this.set({ status: "preparing", botId: options.botId, messageId: options.messageId });
    try {
      if (!this.engine) {
        let abort: (() => void) | undefined;
        const cancelled = new Promise<undefined>((resolve) => {
          abort = () => resolve(undefined);
          request.signal.addEventListener("abort", abort, { once: true });
          if (request.signal.aborted) abort();
        });
        let loaded: Awaited<ReturnType<LoadEngine>> | undefined;
        try {
          loaded = await Promise.race([this.loadEngine(), cancelled]);
        } finally {
          if (abort) request.signal.removeEventListener("abort", abort);
        }
        if (!loaded || !live()) return;
        this.engine = new loaded.SpeechEngine();
        let initial = true;
        this.engine.subscribe((snapshot) => {
          if (!initial) this.set(snapshot);
        });
        initial = false;
      }
      if (!live()) return;
      await this.engine.speak(text, options, spaceId);
    } catch (error) {
      if (live()) this.set({ ...IDLE, error: errorText(error) });
    } finally {
      if (this.pending === request) this.pending = undefined;
    }
  }
}
export const speaker = new Speaker();
