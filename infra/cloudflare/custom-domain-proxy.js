// Cloudflare Worker that serves a Modal-hosted deployment on a custom domain.
// Modal Servers route by their own hostname, so the Worker forwards each request
// (including WebSocket upgrades and redirects) to UPSTREAM_ORIGIN unchanged otherwise.
// Set UPSTREAM_ORIGIN as a Worker variable and RAKAZO_PUBLIC_ORIGIN in the Modal Secret.
export default {
  async fetch(request, env) {
    const upstream = new URL(env.UPSTREAM_ORIGIN);
    const url = new URL(request.url);
    const publicHost = url.host;
    url.protocol = upstream.protocol;
    url.host = upstream.host;
    const headers = new Headers(request.headers);
    headers.set("x-forwarded-host", publicHost);
    return fetch(new Request(url, new Request(request, { headers, redirect: "manual" })));
  },
};
