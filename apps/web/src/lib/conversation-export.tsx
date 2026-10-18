import { ChatMarkdownDocument } from "@rakazo/chat-ui/web";
import type { ThreadMessage } from "@rakazo/contracts";
import { selectedAskActionLabel, userVisibleMessages } from "@rakazo/core";
import tokens from "@rakazo/ui-tokens/css?inline";
import { renderToStaticMarkup } from "react-dom/server";
import { downloadArtifactBytes } from "./artifact-open";
import { rpc, selectedSpaceId } from "./rpc";

type ConversationTarget = { botId: string } | { groupId: string };

export async function loadConversationMessages(
  target: ConversationTarget,
): Promise<ThreadMessage[]> {
  const spaceId = selectedSpaceId();
  const messages = new Map<string, ThreadMessage>();
  let threadId: string | undefined;
  let before: number | undefined;
  for (;;) {
    if (spaceId !== selectedSpaceId()) throw new Error("The workspace changed during export");
    const page = await rpc.threads.messages({
      ...target,
      ...(before === undefined ? {} : { before }),
    });
    if (spaceId !== selectedSpaceId() || (threadId && threadId !== page.threadId)) {
      throw new Error("The conversation changed during export");
    }
    threadId = page.threadId;
    for (const message of page.messages) messages.set(message.id, message);
    if (page.olderCursor === null) break;
    if (before !== undefined && page.olderCursor >= before)
      throw new Error("History pagination did not advance");
    before = page.olderCursor;
  }
  return userVisibleMessages([...messages.values()].sort((a, b) => a.seq - b.seq));
}

function exportedBlock(block: ThreadMessage["blocks"][number]): string {
  switch (block.kind) {
    case "text":
      return block.text;
    case "ask":
      if (block.input === "secret" || block.credential || block.purpose) return block.text;
      return [
        block.text,
        ...(block.actions ?? []).map((action) => `- ${action.label}`),
        block.answer ? selectedAskActionLabel(block.answer, block.actions) : undefined,
      ]
        .filter(Boolean)
        .join("\n\n");
    case "choice":
      return [
        block.question,
        ...block.options.map(
          (option) =>
            `${option.id === block.answerId ? "✓ " : ""}${option.letter}. ${option.label}`,
        ),
      ].join("\n\n");
    case "image":
    case "file":
      return block.name;
    case "channel_message":
      return `${block.fromLabel}: ${block.text}`;
    default:
      return "";
  }
}

export function conversationDocument({
  title,
  messages,
  userName,
  agentName,
  locale,
}: {
  title: string;
  messages: ThreadMessage[];
  userName: string;
  agentName: (botId?: string) => string;
  locale: string;
}): string {
  return `<!doctype html>${renderToStaticMarkup(
    <html lang={locale} data-theme="light">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width,initial-scale=1" />
        <meta
          httpEquiv="Content-Security-Policy"
          content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'"
        />
        <title>{title}</title>
        <style>{`${tokens}
          body{margin:0;background:var(--background);color:var(--foreground);font:16px/1.65 system-ui,sans-serif}
          main{max-width:900px;margin:auto;padding:32px 24px}h1{font-size:26px}article{border-top:1px solid var(--border);padding:24px 0;overflow-wrap:anywhere}
          h2{font-size:15px;margin:0}time{font-size:12px;color:var(--muted-foreground)}blockquote{border-left:3px solid var(--border);padding-left:16px}
          a{color:inherit;text-decoration:underline}table{border-collapse:collapse;width:100%;font-size:14px}th,td{border:1px solid var(--border);padding:8px;text-align:start;vertical-align:top}
          pre{white-space:pre-wrap;background:var(--muted);padding:12px}code{font-family:ui-monospace,monospace}p{white-space:pre-wrap}li p{margin:0}
          @media print{main{max-width:none;padding:0}a{text-decoration:none}thead{display:table-header-group}tr{break-inside:avoid}h2,time{break-after:avoid}}
        `}</style>
      </head>
      <body>
        <main>
          <h1>{title}</h1>
          {messages
            .filter((m) => m.role === "user" || m.role === "bot")
            .map((message) => {
              const text = message.blocks.map(exportedBlock).filter(Boolean).join("\n\n");
              if (!text) return null;
              return (
                <article key={message.id}>
                  <h2>{message.role === "user" ? userName : agentName(message.botId)}</h2>
                  <time dateTime={message.createdAt}>
                    {new Date(message.createdAt).toLocaleString(locale)}
                  </time>
                  {message.replyQuote ? <blockquote>{message.replyQuote}</blockquote> : null}
                  <ChatMarkdownDocument>{text}</ChatMarkdownDocument>
                </article>
              );
            })}
        </main>
      </body>
    </html>,
  )}`;
}

export async function downloadConversation(
  input: Omit<Parameters<typeof conversationDocument>[0], "messages"> & {
    target: ConversationTarget;
  },
): Promise<void> {
  const messages = await loadConversationMessages(input.target);
  const html = conversationDocument({ ...input, messages });
  const name =
    input.title
      .replace(/[\p{Cc}<>:"/\\|?*]/gu, "-")
      .trim()
      .slice(0, 80) || "conversation";
  downloadArtifactBytes(`${name}.html`, "text/html;charset=utf-8", new TextEncoder().encode(html));
}
