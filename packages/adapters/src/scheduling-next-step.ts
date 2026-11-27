import { GOOGLE_CALENDAR_ENDPOINT } from "@rakazo/core";
import type { PrismaClient } from "@rakazo/db";

const CAL_ENDPOINT = "https://mcp.cal.com/mcp";

/**
 * The one booking path, for either connected calendar: the plan is built from what was read in
 * this conversation (the candidate's email and the calendar's free times), and its card is the
 * approval. Anthropic's tool-writing guide: one schedule tool rather than separate list and
 * create steps the agent must chain.
 */
export const BOOKING_NEXT_STEP =
  "Book with recruiting_scheduling: when the candidate wrote, read their email with get_email for the times they offered; read the calendar's free times inside those times (get_availability with format range and duration on Cal.com, or suggest_time with attendeeEmails and durationMinutes on Google Calendar), then call recruiting_scheduling with operation prepare, emailId (or candidate.email, the address the recruiter gave, when they never wrote), candidate {name,timeZone, candidateKey when they are saved}, interviewer {name,email,timeZone}, guests (everyone else the recruiter wants invited, by address; ask the recruiter for an address you do not have before preparing), and start and lengthInMinutes of one returned slot. Then book with operation book and the returned planId; its card is the approval and the calendar sends the invitations. An email may say an invitation was sent only after the booking returned.";
export const NO_CALENDAR_NEXT_STEP =
  "No calendar is connected for booking: call request_connection with provider Google Calendar and keep the times and guests for afterwards.";

const address = (endpoint: string | null) => {
  const url = endpoint ? URL.parse(endpoint) : null;
  return url ? `${url.origin}${url.pathname.replace(/\/$/, "")}` : null;
};

/**
 * The booking path for the calendar this bot actually holds: either calendar books through a
 * saved scheduling plan; with neither connected, the connection comes first.
 */
export async function schedulingNextStep(
  prisma: PrismaClient,
  scope: { spaceId: string; userId: string; botId: string },
): Promise<string> {
  const grants = await prisma.botMcpServer.findMany({
    where: {
      ...scope,
      server: {
        spaceId: scope.spaceId,
        userId: scope.userId,
        enabled: true,
        secretId: { not: null },
        endpoint: { in: [CAL_ENDPOINT, GOOGLE_CALENDAR_ENDPOINT] },
      },
    },
    select: { allowAllTools: true, allowedTools: true, server: { select: { endpoint: true } } },
  });
  const holds = (endpoint: string, tool: string) =>
    grants.some(
      (grant) =>
        address(grant.server.endpoint) === endpoint &&
        (grant.allowAllTools ||
          (Array.isArray(grant.allowedTools) && grant.allowedTools.includes(tool))),
    );
  return holds(CAL_ENDPOINT, "create_booking") || holds(GOOGLE_CALENDAR_ENDPOINT, "create_event")
    ? BOOKING_NEXT_STEP
    : NO_CALENDAR_NEXT_STEP;
}
