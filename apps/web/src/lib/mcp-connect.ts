import { t } from "@lingui/core/macro";
import type { McpOAuthConfig } from "@rakazo/contracts";
import { fetchAccountSecurity } from "./account-security";
import { authClient } from "./auth";
import { MCP_OAUTH_CHANNEL } from "./mcp-oauth-channel";
import { rpc, selectedSpaceId } from "./rpc";
import { runSsoFlow } from "./sso-flow";
import { authErrorText } from "./user-error";

export { MCP_OAUTH_CHANNEL };

const MCP_OAUTH_TIMEOUT_MS = 10 * 60_000;

export type McpOauthResult =
  | "connected"
  | "cancelled"
  | "already_connected"
  | "authorization_not_requested";

/** Run the browser OAuth popup flow for an MCP server: request an
 * authorization URL, open the popup, and wait until the callback page
 * broadcasts completion or the popup is closed without finishing.
 *
 * The BroadcastChannel (not window.opener) is the completion signal because
 * provider login pages with COOP sever the opener link. */
export async function connectMcpOauth(
  serverId: string,
  oauth?: McpOAuthConfig,
): Promise<McpOauthResult> {
  const session = authClient.$store.atoms.session;
  const initial = session?.get().data;
  const userId = initial?.user.id;
  const sessionId = initial?.session.id;
  const spaceId = selectedSpaceId();
  const returnTo = window.location.href;
  const isCurrent = () => {
    const current = session?.get().data;
    return Boolean(
      userId &&
        sessionId &&
        current?.user.id === userId &&
        current?.session.id === sessionId &&
        selectedSpaceId() === spaceId,
    );
  };
  if (!isCurrent()) return "cancelled";
  const started = await rpc.mcp.oauth.begin({
    serverId,
    redirectUri: `${window.location.origin}/mcp/oauth/callback`,
    ...(oauth ? { oauth } : {}),
  });
  if (!isCurrent()) return "cancelled";
  if (started.status === "product_sign_in_required") {
    const security = await fetchAccountSecurity();
    if (!isCurrent()) return "cancelled";
    if (!security.sso) throw new Error(t`Could not continue`);
    const result = await runSsoFlow(
      (disableRedirect, callbackURL) => {
        if (!isCurrent()) return Promise.resolve({ data: null, error: null });
        const input = {
          disableRedirect,
          provider: "oidc",
          callbackURL: callbackURL(returnTo),
          errorCallbackURL: callbackURL(returnTo),
        };
        return security.ssoLinked
          ? authClient.signIn.social({ ...input, additionalData: { reauthenticate: true } })
          : authClient.linkSocial(input);
      },
      [returnTo],
    );
    if (!isCurrent()) return "cancelled";
    if (result.error) throw new Error(authErrorText(result.error, t`Could not continue`));
    // SSO navigation is not proof of service access; the next begin checks that identity.
    return "cancelled";
  }
  if (started.status !== "authorization_required") return started.status;
  const popup = window.open(
    started.authorizationUrl,
    MCP_OAUTH_CHANNEL,
    "popup,width=560,height=720",
  );
  if (!popup) {
    // Popup blocked: navigate this tab instead; the callback page returns to /app.
    window.location.assign(started.authorizationUrl);
    return "cancelled";
  }
  return await new Promise<McpOauthResult>((resolve) => {
    const channel = new BroadcastChannel(MCP_OAUTH_CHANNEL);
    let settled = false;
    let pollTimer = 0;
    let timeoutTimer = 0;
    const finish = (result: McpOauthResult) => {
      if (settled) return;
      settled = true;
      window.clearInterval(pollTimer);
      window.clearTimeout(timeoutTimer);
      channel.close();
      resolve(isCurrent() ? result : "cancelled");
    };
    pollTimer = window.setInterval(() => {
      if (isCurrent() && !popup.closed) return;
      finish("cancelled");
    }, 500);
    timeoutTimer = window.setTimeout(() => {
      popup.close();
      finish("cancelled");
    }, MCP_OAUTH_TIMEOUT_MS);
    channel.onmessage = (event: MessageEvent) => {
      if ((event.data as { type?: string } | null)?.type !== "mcp-oauth-complete") return;
      finish("connected");
    };
  });
}
