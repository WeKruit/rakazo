import type { Prisma, SessionInputPayload } from "@rakazo/db";
import { submitConversationInput } from "@rakazo/db";

/**
 * A routine that fires is one input into the session of its agent in its conversation, in the
 * claim's transaction: the lane runs it now when idle and steers it into the live run otherwise.
 */
export async function submitRoutineInput(
  tx: Prisma.TransactionClient,
  fired: {
    routineId: string;
    spaceId: string;
    userId: string;
    threadId: string;
    botId: string;
    /** The routine's saved prompt, skill references expanded. */
    prompt: string;
    model: { modelProvider: string | null; modelId: string | null; thinkingLevel: string | null };
  },
): Promise<{ sessionId: string }> {
  const payload: SessionInputPayload = { text: fired.prompt, routineId: fired.routineId };
  if (fired.model.modelProvider && fired.model.modelId)
    payload.modelPin = {
      modelProvider: fired.model.modelProvider,
      modelId: fired.model.modelId,
      thinkingLevel: fired.model.thinkingLevel,
    };
  const { sessionId } = await submitConversationInput(
    tx,
    { spaceId: fired.spaceId, userId: fired.userId, threadId: fired.threadId, botId: fired.botId },
    { kind: "message", trigger: "routine", payload },
  );
  return { sessionId };
}
