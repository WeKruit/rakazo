import type { Prisma, SessionInputPayload } from "@rakazo/db";
import { submitConversationInput, submitConversationWakeOnce } from "@rakazo/db";

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
    /** A retried request with the same key submits nothing. */
    wakeKey?: string;
  },
): Promise<{ sessionId: string } | null> {
  const payload: SessionInputPayload = { text: fired.prompt, routineId: fired.routineId };
  if (fired.model.modelProvider && fired.model.modelId)
    payload.modelPin = {
      modelProvider: fired.model.modelProvider,
      modelId: fired.model.modelId,
      thinkingLevel: fired.model.thinkingLevel,
    };
  const key = {
    spaceId: fired.spaceId,
    userId: fired.userId,
    threadId: fired.threadId,
    botId: fired.botId,
  };
  if (fired.wakeKey)
    return submitConversationWakeOnce(tx, key, {
      kind: "message",
      trigger: "routine",
      payload: { ...payload, wakeKey: fired.wakeKey },
    });
  const { sessionId } = await submitConversationInput(tx, key, {
    kind: "message",
    trigger: "routine",
    payload,
  });
  return { sessionId };
}
