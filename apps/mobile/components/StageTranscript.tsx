import { loadThreadHistory, workStageMessages } from "@rakazo/core";
import type { ReactNode } from "react";
import { useEffect, useState } from "react";
import { ActivityIndicator, Modal, Platform, ScrollView, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { MobileMessage, MobileMessagePage } from "../lib/api";
import { rpc } from "../lib/api";
import type { MobileArtifactTarget } from "../lib/artifact-open";
import { useI18n } from "../lib/i18n";
import { useMobileTokens } from "../lib/native";
import { NativeActionButton } from "./native-action-button";

export function StageTranscript({
  target,
  stage,
  liveMessages,
  renderMessage,
  showToolActivity = false,
  onClose,
}: {
  target: MobileArtifactTarget;
  stage: { botId: string; runIds: readonly string[]; sourceRunIds: readonly string[] };
  liveMessages: readonly MobileMessage[];
  renderMessage: (message: MobileMessage) => ReactNode;
  showToolActivity?: boolean;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const tokens = useMobileTokens();
  const insets = useSafeAreaInsets();
  const [history, setHistory] = useState<MobileMessage[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const groupId = "groupId" in target ? target.groupId : undefined;
  const botId = "botId" in target ? target.botId : undefined;
  useEffect(() => {
    const controller = new AbortController();
    setHistory(null);
    setFailed(false);
    void loadThreadHistory<MobileMessage>({
      signal: controller.signal,
      loadPage: (before, signal) =>
        rpc<MobileMessagePage>(
          "threads/messages",
          {
            ...(groupId ? { groupId } : { botId }),
            before,
            includePeerRuns: true,
          },
          { signal },
        ),
    })
      .then((messages) => {
        if (!controller.signal.aborted) setHistory(workStageMessages(messages, stage));
      })
      .catch(() => {
        if (!controller.signal.aborted) setFailed(true);
      });
    return () => controller.abort();
  }, [groupId, botId, stage, attempt]);
  const messages =
    history === null
      ? null
      : workStageMessages(
          [
            ...new Map(
              [...history, ...liveMessages].map((message) => [message.id, message]),
            ).values(),
          ].sort((a, b) => (a.seq ?? Number.MAX_SAFE_INTEGER) - (b.seq ?? Number.MAX_SAFE_INTEGER)),
          stage,
        );
  return (
    <Modal visible animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
      <View
        accessibilityViewIsModal
        style={{
          flex: 1,
          backgroundColor: tokens.background,
          paddingTop: Platform.OS === "ios" ? 12 : insets.top + 12,
          paddingBottom: insets.bottom,
        }}
      >
        <View
          style={{
            flexDirection: "row",
            alignItems: "center",
            justifyContent: "space-between",
            paddingHorizontal: 20,
          }}
        >
          <Text style={{ color: tokens.foreground, fontSize: 17, fontWeight: "600" }}>
            {t("Task transcript")}
          </Text>
          <NativeActionButton label={t("Close")} onPress={onClose} prominence="plain" />
        </View>
        {failed ? (
          <View style={{ padding: 20, gap: 8 }}>
            <Text style={{ color: tokens.foreground }}>{t("Could not load this task.")}</Text>
            <NativeActionButton
              label={t("Retry")}
              onPress={() => setAttempt((value) => value + 1)}
            />
          </View>
        ) : messages === null ? (
          <ActivityIndicator accessibilityLabel={t("Loading…")} />
        ) : (
          <ScrollView contentContainerStyle={{ padding: 20, gap: 12 }}>
            {messages.length === 0 ? (
              <Text style={{ color: tokens.mutedForeground }}>{t("No messages yet.")}</Text>
            ) : (
              messages.map((message) => {
                const brief = message.blocks.find(
                  (block) => block.kind === "handoff" && block.toBotId === stage.botId,
                );
                if (brief?.kind === "handoff" && !showToolActivity) return null;
                return renderMessage(
                  brief?.kind === "handoff"
                    ? { ...message, blocks: [{ kind: "text", text: brief.text }] }
                    : message,
                );
              })
            )}
          </ScrollView>
        )}
      </View>
    </Modal>
  );
}
