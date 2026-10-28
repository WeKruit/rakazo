import { setupI18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import type { ThreadMessage } from "@rakazo/contracts";
import { messages as translations } from "../../src/locales/en/messages.po";
import { Transcript } from "../../src/pages/shell/Transcript";
import "../../src/styles.css";
import { useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { TranscriptWindow } from "../../src/pages/shell/TranscriptWindow";

function Fixture() {
  const scrollRef = useRef<HTMLDivElement>(null);
  const following = useRef(true);
  const [jump, setJump] = useState<string>();
  const [stream, setStream] = useState(false);
  return (
    <>
      <button
        type="button"
        onClick={() => {
          following.current = false;
          setJump("0");
        }}
      >
        Jump first
      </button>
      <button
        type="button"
        onClick={() => {
          following.current = true;
          setJump(undefined);
          if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
        }}
      >
        Follow tail
      </button>
      <button type="button" onClick={() => setStream(true)}>
        Stream
      </button>
      <div ref={scrollRef} id="viewport" style={{ height: 700, overflow: "auto" }}>
        <TranscriptWindow
          items={Array.from({ length: 1000 }, (_, index) => String(index))}
          itemKey={(id) => id}
          containsMessage={(id, target) => id === target}
          scrollRef={scrollRef}
          following={following}
          jumpMessageId={jump}
          renderItem={(id) => (
            <div style={{ minHeight: Number(id) % 3 ? 80 : 160 }}>
              <button type="button">Message {id}</button>
              {stream && id === "999" ? (
                <div style={{ height: 600 }}>Streaming synthetic content</div>
              ) : null}
            </div>
          )}
        />
      </div>
    </>
  );
}
const syntheticMessages: ThreadMessage[] = Array.from({ length: 1000 }, (_, index) => ({
  id: `synthetic-${index}`,
  threadId: "synthetic-thread",
  seq: index,
  role: "user",
  createdAt: "2026-01-01T00:00:00Z",
  blocks: [{ kind: "text", text: `Synthetic message ${index}` }],
}));
const noop = () => undefined;
const asyncNoop = async () => undefined;
function RealFixture() {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [jump, setJump] = useState<{ messageId: string; nonce: number } | null>(null);
  const [rows, setRows] = useState(syntheticMessages);
  return (
    <main style={{ height: 800, display: "flex", flexDirection: "column" }}>
      <button
        type="button"
        onClick={() => setJump({ messageId: "synthetic-0", nonce: Date.now() })}
      >
        Jump first
      </button>
      <button
        type="button"
        onClick={() =>
          setRows((rows) => [
            ...rows,
            {
              ...syntheticMessages[0]!,
              id: "streaming",
              role: "bot",
              blocks: [{ kind: "text", text: "Streaming synthetic text ".repeat(100) }],
            },
          ])
        }
      >
        Append
      </button>
      <Transcript
        narrow={false}
        visible
        scrollRef={scrollRef}
        scrollRequest={jump}
        onScrollRequestHandled={() => setJump(null)}
        artifactTarget={{ botId: "synthetic-bot" }}
        messages={rows}
        showToolActivity={false}
        olderCursor={rows[0]?.seq === 0 ? 1 : null}
        loadingOlder={false}
        answerableAskMessageIds={[]}
        running={false}
        tailPhase={null}
        workingBots={[]}
        workRuns={[]}
        onLoadOlder={async () => {
          const previousHeight = scrollRef.current?.scrollHeight ?? 0;
          setRows((current) => [
            ...Array.from({ length: 30 }, (_, index) => ({
              ...syntheticMessages[0]!,
              id: `older-${index}`,
              seq: index - 30,
              blocks: [{ kind: "text" as const, text: `Older synthetic message ${index}` }],
            })),
            ...current,
          ]);
          requestAnimationFrame(() => {
            if (scrollRef.current)
              scrollRef.current.scrollTop += scrollRef.current.scrollHeight - previousHeight;
          });
        }}
        onOpenBot={noop}
        onAnswer={asyncNoop}
        onReply={noop}
        onQuote={noop}
        onReact={asyncNoop}
        onJumpToMessage={noop}
        onOpenPeerMessages={noop}
        peerBot={() => undefined}
        onRefresh={asyncNoop}
        onBotChanged={asyncNoop}
        onAddRoutine={noop}
        voiceReady={false}
        speakingMessageId={null}
        onSpeak={noop}
        onOpenComputer={noop}
      />
    </main>
  );
}
const i18n = setupI18n({ locale: "en", messages: { en: translations } });
createRoot(document.getElementById("root")!).render(
  <I18nProvider i18n={i18n}>{location.search ? <RealFixture /> : <Fixture />}</I18nProvider>,
);
