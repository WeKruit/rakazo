import { GOOGLE_CALENDAR_ENDPOINT } from "@rakazo/core";
import type { PrismaClient } from "@rakazo/db";

const CAL_ENDPOINT = "https://mcp.cal.com/mcp";

export const CAL_PLAN_NEXT_STEP =
  "Build the plan with operation prepare: read the candidate's email with get_email and the calendar with get_availability in this conversation, then call recruiting_scheduling with operation prepare, emailId, candidate {candidateKey,name,timeZone}, interviewer {name,email,timeZone}, start and lengthInMinutes of one returned slot. Then book with operation book and the returned planId; its card is the approval.";
export const GOOGLE_CALENDAR_NEXT_STEP =
  "This calendar books without a plan: read the candidate's email with get_email for the times they offered, find openings inside those times with suggest_time (attendeeEmails primary and the interviewer, the interviewer's time zone), then call create_event once with summary, startTime, endTime, timeZone and every guest in attendees with email and displayName (the candidate and the interviewer; ask the recruiter for a guest's address you do not have before booking). Its card is the approval, and the calendar sends the invitations; read the event back afterwards. An email may say an invitation was sent only after create_event returned the event.";
export const NO_CALENDAR_NEXT_STEP =
  "No calendar is connected for booking: call request_connection with provider Google Calendar and keep the times and guests for afterwards.";

const address = (endpoint: string | null) => {
  const url = endpoint ? URL.parse(endpoint) : null;
  return url ? `${url.origin}${url.pathname.replace(/\/$/, "")}` : null;
};

/**
 * The booking path for the calendar this bot actually holds: a Cal.com calendar books through a
 * saved scheduling plan, the recruiter's own Google Calendar through its event tools; with neither
 * connected, the connection comes first. One flow, the provider read from the connection.
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
  if (holds(CAL_ENDPOINT, "create_booking")) return CAL_PLAN_NEXT_STEP;
  if (holds(GOOGLE_CALENDAR_ENDPOINT, "create_event")) return GOOGLE_CALENDAR_NEXT_STEP;
  return NO_CALENDAR_NEXT_STEP;
}
