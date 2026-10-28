/**
 * The web build writes this nonce on its script, preload and style tags; the production
 * listener replaces it with a fresh nonce on each page response.
 */
export const WEB_CSP_NONCE_PLACEHOLDER = "__RAKAZO_CSP_NONCE__";

/**
 * Static shell for previewing bot-authored HTML. A srcdoc frame would inherit the app's
 * nonce-only script policy, so the shell is its own document with its own policy.
 */
export const HTML_PREVIEW_PATH = "/html-preview.html";
