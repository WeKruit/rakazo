export type SpeechStatus = "idle" | "preparing" | "speaking";

export interface SpeechSnapshot {
  status: SpeechStatus;
  botId?: string;
  messageId?: string;
  caption?: string;
  error?: string;
}

export interface SpeakOptions {
  voiceId?: string;
  botId?: string;
  messageId?: string;
}

export const VOICE_RESPONSE_TIMEOUT_MS = 70_000;
export const MAX_VOICE_AUDIO_BYTES = 16 * 1024 * 1024;
