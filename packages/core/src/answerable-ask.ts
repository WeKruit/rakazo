import type {
  AskAnswer,
  AskFormContent,
  AskFormField,
  AskFormResponse,
  AskRequestedSchema,
  MessageBlock,
} from "@rakazo/contracts";
import { parseAskFormResponse } from "@rakazo/contracts";

type AskBlock = Extract<MessageBlock, { kind: "ask" }>;

/** Still waiting for a person. A card closed when its wait expired is not. */
export function isOpenAskBlock(block: { kind: string; status?: string }): boolean {
  return block.kind === "ask" && block.status !== "answered" && block.status !== "expired";
}

export type ClosedAskAnswer = {
  /** The person's answer as an ordinary message. */
  text: string;
  /** Recorded on the card, as a live answer would record it. */
  recorded: string;
  formResponse?: AskFormResponse;
};

/** One message per closed card, however often a stale card is pressed. */
export function closedAskClientNonce(messageId: string): string {
  return `closed-ask:${messageId}`;
}

/**
 * A press on a card whose run already ended becomes an ordinary message, so the work starts
 * the way any message starts it. Approvals, secrets and connection cards stay on their own gates:
 * a stale consent is never replayed, and a secret is never message text.
 */
export function closedAskAnswer(block: AskBlock, answer: AskAnswer): ClosedAskAnswer | null {
  if (block.status === "answered") return null;
  if (block.approvalEffectId || block.input === "secret" || block.credential || block.connection)
    return null;
  if (block.requestedSchema) {
    let formResponse: AskFormResponse;
    try {
      formResponse = parseAskFormResponse(block.requestedSchema, answer);
    } catch {
      return null;
    }
    if (formResponse.action !== "accept") return null;
    const text = askFormAnswerText(block.requestedSchema, formResponse);
    return { text, recorded: text, formResponse };
  }
  if (typeof answer !== "string" || !answer.trim()) return null;
  const choice = resolveAskChoice(answer, block.actions);
  return { text: choice?.label ?? answer, recorded: choice?.id ?? answer };
}

export function askFormAnswerText(schema: AskRequestedSchema, response: AskFormResponse): string {
  if (response.action === "cancel") return "Cancelled";
  if (response.action === "decline") return "Declined";
  return (
    Object.entries(response.content)
      .map(([name, value]) => {
        const field = schema.properties[name]!;
        const options = askFormOptions(field);
        const display = (item: string | number | boolean) =>
          options?.find((option) => option.value === item)?.label ?? String(item);
        return `${field.title ?? name}: ${Array.isArray(value) ? value.map(display).join(", ") : display(value)}`;
      })
      .join("\n") || "Submitted"
  );
}

export function askFormOptions(
  field: AskFormField,
): { value: string; label: string }[] | undefined {
  const choices = field.type === "array" ? field.items : field;
  const labels = field.type === "string" && "enumNames" in field ? field.enumNames : undefined;
  if ("enum" in choices)
    return choices.enum.map((value, index) => ({ value, label: labels?.[index] ?? value }));
  const titled =
    "oneOf" in choices ? choices.oneOf : "anyOf" in choices ? choices.anyOf : undefined;
  return titled?.map((option) => ({ value: option.const, label: option.title }));
}

export function askFormDefaults(schema: AskRequestedSchema): AskFormContent {
  return Object.fromEntries(
    Object.entries(schema.properties).flatMap(([name, field]) => {
      const value =
        field.default ??
        (schema.required?.includes(name)
          ? field.type === "boolean"
            ? false
            : field.type === "array"
              ? []
              : undefined
          : undefined);
      return value === undefined ? [] : [[name, value]];
    }),
  );
}

/** Native inputs keep numeric drafts as text; only submission converts them to schema values. */
export function askFormContent(schema: AskRequestedSchema, values: AskFormContent): AskFormContent {
  return Object.fromEntries(
    Object.entries(values).flatMap(([name, value]) => {
      const field = schema.properties[name];
      if (
        field &&
        !schema.required?.includes(name) &&
        ((Array.isArray(value) && value.length === 0) ||
          (value === "" && !askFormOptions(field)?.some((option) => option.value === "")))
      )
        return [];
      if (field?.type !== "number" && field?.type !== "integer") return [[name, value]];
      return typeof value === "string" && !value.trim()
        ? []
        : [[name, typeof value === "string" ? Number(value) : value]];
    }),
  );
}

type AskSnapshot = {
  messages: readonly {
    id: string;
    runId?: string | null;
    blocks: readonly { kind: string; status?: string }[];
  }[];
  run?: { id: string; status: string } | null;
  activeRuns?: readonly { id: string; status: string }[];
};

export function latestAnswerableAskMessageId(snapshot: AskSnapshot | null): string | null {
  return answerableAskMessageIds(snapshot).at(-1) ?? null;
}

/** Each waiting run retains its own original answer card, including in multi-agent groups. */
export function answerableAskMessageIds(snapshot: AskSnapshot | null): string[] {
  if (!snapshot) return [];
  const waitingRunIds = new Set(
    (snapshot.activeRuns ?? (snapshot.run ? [snapshot.run] : []))
      .filter((run) => run.status === "waiting_input")
      .map((run) => run.id),
  );
  const ids: string[] = [];
  for (let index = snapshot.messages.length - 1; index >= 0; index -= 1) {
    const message = snapshot.messages[index];
    if (!message?.runId || !waitingRunIds.has(message.runId)) continue;
    if (message.blocks.some(isOpenAskBlock)) {
      ids.unshift(message.id);
      waitingRunIds.delete(message.runId);
    }
  }
  return ids;
}

export function selectedAskActionLabel(
  answer: string,
  actions?: readonly { id: string; label: string }[],
): string {
  return resolveAskChoice(answer, actions)?.label ?? answer;
}

export function resolveAskChoice(
  answer: string,
  actions?: readonly { id: string; label: string }[],
): { id: string; label: string } | undefined {
  if (!actions?.length) return undefined;
  const trimmed = answer.trim();
  if (!trimmed) return undefined;
  const byId = actions.find((action) => action.id === trimmed);
  if (byId) return byId;
  const lower = trimmed.toLowerCase();
  return actions.find((action) => action.label.trim().toLowerCase() === lower);
}

/** Pending approval metadata takes precedence over ordinary clarification cards. */
export function pendingInputAttention(blocks: unknown): "approval" | "question" | null {
  if (!Array.isArray(blocks)) return null;
  const pending = blocks.filter((block) => block?.kind === "ask" && block.status === "pending");
  if (pending.some((block) => typeof block.approvalEffectId === "string")) return "approval";
  return pending.length ? "question" : null;
}
