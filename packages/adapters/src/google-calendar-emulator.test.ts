import type {
  OAuthClientInformationMixed,
  OAuthClientProvider,
  StoredOAuthTokens,
} from "@modelcontextprotocol/client";
import { auth, Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { describe, expect, it } from "vitest";
import { ThirdPartyConnectorEmulator } from "./third-party-connector-emulator.js";

const ENDPOINT = new URL("https://calendarmcp.googleapis.com/mcp/v1");
const REDIRECT = "https://app.example.test/mcp/oauth/callback";

/** A recruiter's sign-in, kept in memory: the SDK's own discovery, registration and exchange. */
function signIn(thirdParties: ThirdPartyConnectorEmulator) {
  let client: OAuthClientInformationMixed | undefined;
  let tokens: StoredOAuthTokens | undefined;
  let verifier = "";
  let consentUrl: URL | undefined;
  const provider: OAuthClientProvider = {
    redirectUrl: REDIRECT,
    clientMetadata: {
      client_name: "test",
      redirect_uris: [REDIRECT],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    },
    clientInformation: () => client,
    saveClientInformation: (value) => {
      client = value;
    },
    tokens: () => tokens,
    saveTokens: (value) => {
      tokens = value;
    },
    redirectToAuthorization: (url) => {
      consentUrl = url;
    },
    saveCodeVerifier: (value) => {
      verifier = value;
    },
    codeVerifier: () => verifier,
  };
  const fetchFn = (input: string | URL | Request, init?: RequestInit) =>
    thirdParties.fetch(input, init);
  return {
    provider,
    fetchFn,
    async connect() {
      expect(await auth(provider, { serverUrl: ENDPOINT, fetchFn })).toBe("REDIRECT");
      const back = new URL(thirdParties.googleCalendar.consent(consentUrl!.toString()));
      expect(
        await auth(provider, {
          serverUrl: ENDPOINT,
          fetchFn,
          authorizationCode: back.searchParams.get("code")!,
        }),
      ).toBe("AUTHORIZED");
      const mcp = new Client({ name: "test", version: "1" });
      await mcp.connect(
        new StreamableHTTPClientTransport(ENDPOINT, { authProvider: provider, fetch: fetchFn }),
      );
      return async (name: string, args: Record<string, unknown>) =>
        (await mcp.callTool({ name, arguments: args })).structuredContent as Record<
          string,
          unknown
        >;
    },
  };
}

describe("GoogleCalendarEmulator", () => {
  it("connects through the calendar's own sign-in and refuses a call without it", async () => {
    const thirdParties = new ThirdPartyConnectorEmulator();
    const unsigned = await thirdParties.fetch(ENDPOINT, {
      method: "POST",
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(unsigned.status).toBe(401);
    const call = await signIn(thirdParties).connect();
    expect(await call("list_events", {})).toMatchObject({ events: [] });
  });

  it("books, moves and cancels an event with every guest, and keeps free time honest", async () => {
    const thirdParties = new ThirdPartyConnectorEmulator();
    const call = await signIn(thirdParties).connect();
    const free = await call("suggest_time", {
      attendeeEmails: ["primary", "priya@client.example.test"],
      startTime: "2026-12-01T13:00:00",
      endTime: "2026-12-01T17:00:00",
      timeZone: "America/Chicago",
      durationMinutes: 30,
      preferences: { pageSize: 2 },
    });
    expect(free.timeSlots).toEqual([
      {
        start: { dateTime: "2026-12-01T19:00:00.000Z", timeZone: "America/Chicago" },
        end: { dateTime: "2026-12-01T19:30:00.000Z", timeZone: "America/Chicago" },
      },
      {
        start: { dateTime: "2026-12-01T19:30:00.000Z", timeZone: "America/Chicago" },
        end: { dateTime: "2026-12-01T20:00:00.000Z", timeZone: "America/Chicago" },
      },
    ]);
    const event = await call("create_event", {
      summary: "Ethan Park · Senior Data Engineer",
      startTime: "2026-12-01T14:00:00",
      endTime: "2026-12-01T14:30:00",
      timeZone: "America/Chicago",
      attendees: [
        { email: "ethan@candidate.example.test" },
        { email: "priya@client.example.test" },
      ],
    });
    expect(event.start).toEqual({
      dateTime: "2026-12-01T20:00:00.000Z",
      timeZone: "America/Chicago",
    });
    expect((event.attendees as { email: string }[]).map((guest) => guest.email)).toEqual([
      "recruiter1@calendar.example.test",
      "ethan@candidate.example.test",
      "priya@client.example.test",
    ]);
    // The booked half hour is no longer offered.
    const after = await call("suggest_time", {
      attendeeEmails: ["primary"],
      startTime: "2026-12-01T14:00:00",
      endTime: "2026-12-01T15:00:00",
      timeZone: "America/Chicago",
    });
    expect(
      (after.timeSlots as { start: { dateTime: string } }[]).map((slot) => slot.start.dateTime),
    ).toEqual(["2026-12-01T20:30:00.000Z"]);
    const moved = await call("update_event", {
      eventId: event.id,
      startTime: "2026-12-02T20:00:00Z",
      endTime: "2026-12-02T20:30:00Z",
    });
    expect(moved.start).toMatchObject({ dateTime: "2026-12-02T20:00:00.000Z" });
    await call("delete_event", { eventId: event.id });
    expect(await call("list_events", {})).toMatchObject({ events: [] });
    expect(thirdParties.googleCalendar.events()).toMatchObject([{ status: "cancelled" }]);
  });

  it("gives each sign-in its own calendar", async () => {
    const thirdParties = new ThirdPartyConnectorEmulator();
    const first = await signIn(thirdParties).connect();
    const second = await signIn(thirdParties).connect();
    await first("create_event", {
      summary: "Interview",
      startTime: "2026-12-01T20:00:00Z",
      endTime: "2026-12-01T20:30:00Z",
    });
    expect(await second("list_events", {})).toMatchObject({ events: [] });
  });
});
