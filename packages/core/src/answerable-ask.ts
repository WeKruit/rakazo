import type {
  AskFormContent,
  AskFormField,
  AskFormResponse,
  AskRequestedSchema,
} from "@rakazo/contracts";

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
    if (message.blocks.some((block) => block.kind === "ask" && block.status !== "answered")) {
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
