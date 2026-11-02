import { newClientId } from "../../lib/client-id";

/** Keep one create intent across retries/reopening; successful completion starts a new intent. */
export function sequenceDraftNonce(scope: string) {
  const key = `recruiting-sequence-draft:${scope}`;
  const existing = sessionStorage.getItem(key);
  if (existing) return existing;
  const nonce = newClientId();
  sessionStorage.setItem(key, nonce);
  return nonce;
}
export function clearSequenceDraftNonce(scope: string, nonce: string) {
  const key = `recruiting-sequence-draft:${scope}`;
  if (sessionStorage.getItem(key) === nonce) sessionStorage.removeItem(key);
}
