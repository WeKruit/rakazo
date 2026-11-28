import type { JobPublisher } from "@rakazo/adapter-kit";
import { isTicketCompletedStatus, TicketStatusSchema } from "@rakazo/contracts";
import type { PrismaClient, ThreadEvents } from "@rakazo/db";
import { submitConversationInput, wakeSessions } from "@rakazo/db";

/** Assignment wakes only its current owner, without posting a chat message. */
export async function wakeTicketAssignee(
  deps: {
    prisma: PrismaClient;
    jobs: Pick<JobPublisher, "enqueue">;
    events?: Partial<Pick<ThreadEvents, "wakeSessions">>;
    ticketBoardEnabled?: boolean;
  },
  input: { spaceId: string; ticketId: string; botId: string },
): Promise<void> {
  if (!deps.ticketBoardEnabled) return;
  const sessionId = await deps.prisma.$transaction(async (tx) => {
    const ticket = await tx.ticket.findFirst({
      where: { id: input.ticketId, spaceId: input.spaceId, assigneeBotId: input.botId },
      include: { board: { select: { ticketPrefix: true } } },
    });
    if (!ticket) return null;
    const status = TicketStatusSchema.safeParse(ticket.status);
    if (!status.success || isTicketCompletedStatus(status.data)) return null;
    const bot = await tx.bot.findFirst({
      where: { id: input.botId, spaceId: input.spaceId, archivedAt: null },
      select: { id: true, userId: true, thread: { select: { id: true } } },
    });
    if (!bot?.thread) return null;
    const submitted = await submitConversationInput(
      tx,
      { spaceId: input.spaceId, userId: bot.userId, threadId: bot.thread.id, botId: bot.id },
      {
        kind: "message",
        trigger: "tickets",
        payload: {
          text: `Ticket ${ticket.board.ticketPrefix}-${ticket.number} is assigned to you.`,
          internal: true,
        },
      },
    );
    return submitted.sessionId;
  });
  if (!sessionId) return;
  // Without realtime here the owner finds the input at its next lease renewal.
  if (deps.events?.wakeSessions) await deps.events.wakeSessions([sessionId]);
  else await wakeSessions({ jobs: deps.jobs }, [sessionId]);
}
