import { t } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import { ChatMarkdown } from "@rakazo/chat-ui/web-lazy";
import type {
  AskAnswer,
  AskConnection,
  AskFormContent,
  AskFormResponse,
  ConnectionAskAnswer,
  ThreadMessage,
} from "@rakazo/contracts";
import { commandVariableName, parseAskFormResponse } from "@rakazo/contracts";
import {
  askFormContent,
  askFormDefaults,
  askFormOptions,
  isApprovalAskBlock,
  isSecretAskBlock,
  selectedAskActionLabel,
} from "@rakazo/core";
import { Button, Input, Textarea } from "@rakazo/ui-web";
import { Plug } from "lucide-react";
import { useId, useState } from "react";
import { connectMcpOauth } from "../lib/mcp-connect";
import { errorText } from "../lib/user-error";
import { SuccessPop } from "./ai/primitives";

export type AskBlock = Extract<ThreadMessage["blocks"][number], { kind: "ask" }>;

function formatAnsweredState(
  answer: string | undefined,
  approval: boolean,
  secret: boolean,
  outcome?: "created" | "cancelled",
  actions?: AskBlock["actions"],
): string {
  if (secret) return t`Saved`;
  if (!answer) return t`Answered`;
  if (!approval) return t`Answered: ${selectedAskActionLabel(answer, actions)}`;
  if (outcome === "created") return t`Created`;
  if (outcome === "cancelled") return t`Cancelled`;
  const label = actions?.find((action) => action.id === answer)?.label;
  if (answer === "allow" && (label === undefined || label === "Allow once")) return t`Allowed once`;
  if (
    answer === "always" &&
    (label === undefined || label === "Always allow this tool" || label === "Always allow")
  )
    return t`Always allowed`;
  if (answer === "deny" && (label === undefined || label === "Deny")) return t`Denied`;
  return t`Answered: ${label === undefined ? selectedAskActionLabel(answer, actions) : approvalActionLabel(answer, label)}`;
}

function approvalActionLabel(
  id: string,
  fallback: string,
  outcome?: "created" | "cancelled",
): string {
  if (outcome === "created") return t`Create space`;
  if (outcome === "cancelled") return t`Cancel`;
  if (id === "allow" && fallback === "Allow once") return t`Allow once`;
  if (id === "always" && (fallback === "Always allow this tool" || fallback === "Always allow"))
    return t`Always allow this tool`;
  if (id === "deny" && fallback === "Deny") return t`Deny`;
  if (id === "allow" && fallback === "Confirm and send") return t`Confirm and send`;
  if (id === "always" && fallback === "Send when I say send") return t`Send when I say send`;
  if (id === "deny" && fallback === "Cancel") return t`Cancel`;
  if (id === "allow" && fallback === "Looks good, start searching")
    return t`Looks good, start searching`;
  if (id === "deny" && fallback === "Needs changes") return t`Needs changes`;
  return fallback;
}

/** Translates recruiting approval titles; the exact target after "→" stays as sent. */
function approvalTitle(text: string): string {
  const [action, ...rest] = text.split(" → ");
  const target = rest.length ? ` → ${rest.join(" → ")}` : "";
  const titles: Record<string, string> = {
    "Confirm sending the first email": t`Confirm sending the first email`,
    "Confirm reply": t`Confirm reply`,
    "Confirm requirements": t`Confirm requirements`,
    "Role requirements": t`Role requirements`,
    "Approve documents": t`Approve documents`,
    "Approve calibration": t`Approve calibration`,
    "Confirm sending email": t`Confirm sending email`,
    "Confirm forwarding email": t`Confirm forwarding email`,
    "Confirm adding candidates to the campaign": t`Confirm adding candidates to the campaign`,
    "Confirm interview booking": t`Confirm interview booking`,
    "Confirm interview change": t`Confirm interview change`,
    "Confirm interview cancellation": t`Confirm interview cancellation`,
  };
  const title = action === undefined ? undefined : titles[action];
  return title ? title + target : text;
}

function secretFieldLabel(purpose: AskBlock["purpose"]): string {
  if (purpose === "password") return t`Password`;
  if (purpose === "api_key") return t`API key`;
  return t`Code`;
}

export function AskCard({
  block,
  canAnswer,
  onAnswer,
}: {
  block: AskBlock;
  canAnswer: boolean;
  onAnswer: (text: AskAnswer, username?: string) => Promise<void>;
}) {
  if (block.connection) {
    return (
      <ConnectionAskCard
        connection={block.connection}
        answer={block.status === "answered" ? block.answer : undefined}
        canAnswer={canAnswer}
        onAnswer={onAnswer}
      />
    );
  }
  return <QuestionAskCard block={block} canAnswer={canAnswer} onAnswer={onAnswer} />;
}

type ConnectionState = "idle" | "connecting" | "connected" | "failed";

/** Asks the user to connect an integration through the existing MCP OAuth flow,
 * then answers the same ask so the waiting run continues. */
function ConnectionAskCard({
  connection,
  answer,
  canAnswer,
  onAnswer,
}: {
  connection: AskConnection;
  answer: string | undefined;
  canAnswer: boolean;
  onAnswer: (text: AskAnswer) => Promise<void>;
}) {
  const { t } = useLingui();
  const [state, setState] = useState<ConnectionState>("idle");
  const [declining, setDeclining] = useState(false);
  const busy = state === "connecting" || declining;
  const { name } = connection;

  async function connect() {
    if (busy) return;
    setState("connecting");
    try {
      const result = await connectMcpOauth(connection.serverId);
      if (result === "cancelled") {
        setState("failed");
        return;
      }
      setState("connected");
      await onAnswer("connected" satisfies ConnectionAskAnswer);
    } catch {
      setState("failed");
    }
  }

  async function decline() {
    if (busy) return;
    setDeclining(true);
    try {
      await onAnswer("not_connected" satisfies ConnectionAskAnswer);
    } catch {
      setState("failed");
    } finally {
      setDeclining(false);
    }
  }

  const connected = answer === "connected" || (answer === undefined && state === "connected");
  return (
    <fieldset
      data-testid="connection-ask-card"
      aria-label={t`Connect ${name}`}
      className="min-w-0 w-full max-w-md rounded-2xl border border-border bg-card px-4 py-3.5"
    >
      <div className="flex items-center gap-3">
        {connection.iconUrl ? (
          <img
            src={connection.iconUrl}
            alt=""
            className="h-10 w-10 shrink-0 rounded-[10px] bg-muted object-contain p-1"
          />
        ) : (
          <span className="grid h-10 w-10 shrink-0 place-items-center rounded-[10px] bg-muted text-foreground">
            <Plug size={18} strokeWidth={1.8} aria-hidden />
          </span>
        )}
        <span className="min-w-0 flex-1">
          <span className="block text-[15px] font-medium text-foreground">
            <Trans>Connect {name}</Trans>
          </span>
          <span className="block text-[13px] text-muted-foreground">{connection.reason}</span>
        </span>
      </div>
      {connected ? (
        <div className="mt-3">
          <SuccessPop label={t`Connected`} />
        </div>
      ) : answer !== undefined ? (
        <div className="mt-3 text-[13px] text-muted-foreground">
          <Trans>Not now</Trans>
        </div>
      ) : !canAnswer ? (
        <div className="mt-3 text-[13.5px] font-medium text-muted-foreground">
          <Trans>No longer active</Trans>
        </div>
      ) : (
        <>
          {state === "failed" ? (
            <p className="mt-3 text-[13px] text-destructive">
              <Trans>Could not connect. Try again.</Trans>
            </p>
          ) : null}
          <div className="mt-3 flex gap-2">
            <Button className="rounded-full" disabled={busy} onClick={() => void connect()}>
              {state === "connecting" ? <Trans>Connecting…</Trans> : <Trans>Connect</Trans>}
            </Button>
            <Button
              variant="ghost"
              className="rounded-full text-muted-foreground"
              disabled={busy}
              onClick={() => void decline()}
            >
              <Trans>Not now</Trans>
            </Button>
          </div>
        </>
      )}
    </fieldset>
  );
}

function QuestionAskCard({
  block,
  canAnswer,
  onAnswer,
}: {
  block: AskBlock;
  canAnswer: boolean;
  onAnswer: (text: AskAnswer, username?: string) => Promise<void>;
}) {
  const { t } = useLingui();
  const [answer, setAnswer] = useState("");
  const [username, setUsername] = useState("");
  const [pendingAction, setPendingAction] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [formValues, setFormValues] = useState<AskFormContent>(() =>
    block.requestedSchema ? askFormDefaults(block.requestedSchema) : {},
  );
  const formId = useId();
  const submitting = pendingAction !== null;
  const approvalActions = isApprovalAskBlock(block) ? block.actions : undefined;
  const askActions = block.actions;
  const secretInput = isSecretAskBlock(block);
  const loginInput = secretInput && block.credential?.auth.type === "login";
  const secretLabel = loginInput ? t`Password` : secretFieldLabel(block.purpose);

  async function submitAnswer(value: string) {
    if (submitting) return;
    if (secretInput ? value.length === 0 : !value.trim()) return;
    const submitUsername = loginInput ? username.trim() : undefined;
    if (loginInput && !submitUsername) return;
    const submitValue = value;
    setPendingAction(secretInput ? "submit" : submitValue);
    setError(null);
    if (secretInput) {
      setAnswer("");
      setUsername("");
    }
    try {
      await onAnswer(submitValue, submitUsername);
    } catch (err) {
      // A secret answer's failure may echo the secret, so never show its message.
      setError(
        secretInput
          ? t`Could not submit this answer`
          : errorText(err, t`Could not submit this answer`),
      );
    } finally {
      setPendingAction(null);
    }
  }

  async function submitForm(action: AskFormResponse["action"]) {
    if (submitting || !block.requestedSchema) return;
    setError(null);
    try {
      const response = parseAskFormResponse(
        block.requestedSchema,
        action === "accept"
          ? { action, content: askFormContent(block.requestedSchema, formValues) }
          : { action },
      );
      setPendingAction(action);
      await onAnswer(response);
    } catch (cause) {
      setError(errorText(cause, t`Could not submit this answer`));
    } finally {
      setPendingAction(null);
    }
  }

  return (
    <fieldset
      data-testid={secretInput ? "secret-ask-card" : undefined}
      aria-label={block.text}
      className="min-w-0 w-full max-w-2xl rounded-2xl border border-border bg-card px-5 py-4"
    >
      <div className="text-base leading-relaxed text-foreground">
        <ChatMarkdown>
          {block.approvalEffectId ? approvalTitle(block.text) : block.text}
        </ChatMarkdown>
      </div>
      {secretInput && block.credential ? (
        <div
          data-testid="secret-ask-destination"
          className="mt-2 break-all text-[13px] text-muted-foreground"
        >
          {block.credential.auth.type === "command"
            ? `${t`Command variable`} · $${commandVariableName(block.credential.name)}`
            : block.credential.origin}
        </div>
      ) : null}
      {block.detail && !secretInput ? (
        <pre className="mt-3 max-h-72 overflow-auto whitespace-pre-wrap break-words rounded-xl bg-muted px-3.5 py-3 font-sans text-sm leading-relaxed text-foreground">
          {block.detail}
        </pre>
      ) : null}
      {block.status === "answered" ? (
        <div className="mt-3.5 whitespace-pre-wrap text-[13.5px] font-medium text-success">
          {formatAnsweredState(
            block.answer,
            Boolean(block.approvalEffectId),
            secretInput,
            askActions?.find((action) => action.id === block.answer)?.outcome,
            askActions,
          )}
        </div>
      ) : !canAnswer ? (
        <div className="mt-3.5 text-[13.5px] font-medium text-muted-foreground">
          <Trans>No longer active</Trans>
        </div>
      ) : block.requestedSchema ? (
        <form
          className="mt-3.5 flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            void submitForm("accept");
          }}
        >
          {Object.entries(block.requestedSchema.properties).map(([name, field], index) => {
            const id = `${formId}-${index}`;
            const label = field.title ?? name;
            const required = block.requestedSchema!.required?.includes(name);
            const options = askFormOptions(field);
            const value = formValues[name];
            const setValue = (next: AskFormContent[string] | undefined) =>
              setFormValues((current) => {
                const values = { ...current };
                if (next === undefined) delete values[name];
                else values[name] = next;
                return values;
              });
            return (
              <fieldset key={name} className="min-w-0 space-y-2" disabled={submitting}>
                <legend className="text-sm font-medium">
                  {label}
                  {required ? " *" : ""}
                </legend>
                {field.description ? (
                  <p id={`${id}-description`} className="text-sm text-muted-foreground">
                    {field.description}
                  </p>
                ) : null}
                {field.type === "array" ? (
                  options?.map((option) => (
                    <label key={option.value} className="flex items-center gap-2 text-sm">
                      <input
                        type="checkbox"
                        aria-label={option.label}
                        aria-describedby={field.description ? `${id}-description` : undefined}
                        checked={Array.isArray(value) && value.includes(option.value)}
                        onChange={(event) =>
                          setValue(
                            event.target.checked
                              ? [...(Array.isArray(value) ? value : []), option.value]
                              : (Array.isArray(value) ? value : []).filter(
                                  (item) => item !== option.value,
                                ),
                          )
                        }
                      />
                      {option.label}
                    </label>
                  ))
                ) : field.type === "boolean" ? (
                  <label className="flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      aria-label={label}
                      checked={value === true}
                      onChange={(event) => setValue(event.target.checked)}
                    />
                    {label}
                  </label>
                ) : options ? (
                  <select
                    id={id}
                    aria-label={label}
                    aria-required={required}
                    required={required}
                    aria-describedby={field.description ? `${id}-description` : undefined}
                    className="h-10 w-full rounded-md border border-input bg-background px-3 text-base"
                    value={
                      value === undefined
                        ? ""
                        : String(options.findIndex((option) => option.value === value))
                    }
                    onChange={(event) =>
                      setValue(
                        event.target.value === ""
                          ? undefined
                          : options[Number(event.target.value)]?.value,
                      )
                    }
                  >
                    <option value=""></option>
                    {options.map((option, optionIndex) => (
                      <option key={option.value} value={String(optionIndex)}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                ) : field.type === "string" && !("format" in field && field.format) ? (
                  <Textarea
                    id={id}
                    aria-label={label}
                    aria-required={required}
                    required={required && "minLength" in field && (field.minLength ?? 0) > 0}
                    aria-describedby={field.description ? `${id}-description` : undefined}
                    value={typeof value === "string" ? value : ""}
                    onChange={(event) => setValue(event.target.value)}
                  />
                ) : (
                  <Input
                    id={id}
                    aria-label={label}
                    aria-required={required}
                    // JSON Schema permits an explicitly empty plain string unless constrained.
                    required={
                      required &&
                      (field.type === "number" ||
                        field.type === "integer" ||
                        ("format" in field && Boolean(field.format)) ||
                        ("minLength" in field && (field.minLength ?? 0) > 0))
                    }
                    aria-describedby={field.description ? `${id}-description` : undefined}
                    type={
                      field.type === "number" || field.type === "integer"
                        ? "number"
                        : "format" in field
                          ? field.format === "uri"
                            ? "url"
                            : field.format === "email"
                              ? "email"
                              : field.format === "date"
                                ? "date"
                                : "text"
                          : "text"
                    }
                    step={field.type === "integer" ? 1 : "any"}
                    min={"minimum" in field ? field.minimum : undefined}
                    max={"maximum" in field ? field.maximum : undefined}
                    value={typeof value === "string" || typeof value === "number" ? value : ""}
                    onChange={(event) => setValue(event.target.value)}
                  />
                )}
              </fieldset>
            );
          })}
          <div className="flex flex-wrap gap-2">
            <Button type="submit" disabled={submitting}>
              {pendingAction === "accept" ? <Trans>Sending…</Trans> : <Trans>Send answer</Trans>}
            </Button>
            <Button
              type="button"
              variant="outline"
              disabled={submitting}
              onClick={() => void submitForm("decline")}
            >
              <Trans>Decline</Trans>
            </Button>
            <Button
              type="button"
              variant="ghost"
              disabled={submitting}
              onClick={() => void submitForm("cancel")}
            >
              <Trans>Cancel</Trans>
            </Button>
          </div>
        </form>
      ) : askActions?.length ? (
        <div className="mt-3.5 space-y-1.5">
          {askActions.map((action) => (
            <Button
              key={action.id}
              variant={approvalActions && action.id === "allow" ? "default" : "outline"}
              className="h-auto w-full justify-start whitespace-normal px-3.5 py-3 text-start text-base font-normal"
              disabled={submitting}
              onClick={() => void submitAnswer(action.id)}
            >
              {pendingAction === action.id ? (
                <Trans>Sending…</Trans>
              ) : approvalActions ? (
                approvalActionLabel(action.id, action.label, action.outcome)
              ) : (
                action.label
              )}
            </Button>
          ))}
        </div>
      ) : secretInput ? (
        <form
          className="mt-3.5 flex flex-col gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            void submitAnswer(answer);
          }}
        >
          {loginInput ? (
            <Input
              aria-label={t`Username`}
              autoComplete="off"
              spellCheck={false}
              disabled={submitting}
              value={username}
              onChange={(event) => setUsername(event.target.value)}
              placeholder={t`Username`}
            />
          ) : null}
          <Input
            aria-label={secretLabel}
            type="password"
            autoComplete="off"
            spellCheck={false}
            disabled={submitting}
            value={answer}
            onChange={(event) => setAnswer(event.target.value)}
            placeholder={secretLabel}
          />
          <Button
            type="submit"
            className="self-start"
            disabled={answer.length === 0 || (loginInput && !username.trim()) || submitting}
          >
            {submitting ? <Trans>Saving…</Trans> : <Trans>Save</Trans>}
          </Button>
        </form>
      ) : null}
      {block.status !== "answered" &&
      canAnswer &&
      !secretInput &&
      !approvalActions &&
      !block.requestedSchema ? (
        <form
          className="mt-3.5 flex flex-col gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            void submitAnswer(answer);
          }}
        >
          <Textarea
            aria-label={t`Answer`}
            className="text-base leading-relaxed md:text-base"
            value={answer}
            disabled={submitting}
            onChange={(event) => setAnswer(event.target.value)}
            placeholder={t`Type your answer`}
          />
          <Button type="submit" className="self-start" disabled={!answer.trim() || submitting}>
            {submitting ? <Trans>Sending…</Trans> : <Trans>Send answer</Trans>}
          </Button>
        </form>
      ) : null}
      {error ? <p className="mt-3 text-[13px] text-destructive">{error}</p> : null}
    </fieldset>
  );
}
