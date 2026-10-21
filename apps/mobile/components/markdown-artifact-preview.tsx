import { ChatMarkdown } from "@rakazo/chat-ui/native";
import type { MessageBlock } from "@rakazo/contracts";
import { useEffect, useState } from "react";
import { Alert, Modal, SafeAreaView, ScrollView, Text, View } from "react-native";
import { rpc } from "../lib/api";
import { mobileTokens } from "../lib/appearance";
import {
  type MobileArtifactTarget,
  openMobileArtifact,
  readMobileArtifactText,
} from "../lib/artifact-open";
import { useI18n } from "../lib/i18n";
import { useResolvedAppearance } from "../lib/native";
import { iosAtLeast } from "../lib/native-controls";
import { errorText } from "../lib/user-error";
import { GlassIconButton } from "./glass-icon-button";

export type MarkdownArtifactPreviewTarget = {
  artifactId: string;
  name: string;
  mimeType: string;
  preview?: Extract<MessageBlock, { kind: "file" }>["preview"];
  messageId?: string;
};

export function MarkdownArtifactPreview({
  threadTarget,
  target,
  onClose,
}: {
  threadTarget: MobileArtifactTarget;
  target: MarkdownArtifactPreviewTarget;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const colorScheme = useResolvedAppearance();
  const tokens = mobileTokens();
  const previewKey = JSON.stringify([threadTarget, target]);
  const [state, setState] = useState<
    | { key: string; status: "ready"; text: string }
    | { key: string; status: "error"; message: string }
    | null
  >(null);
  const current =
    target.preview?.source === null
      ? { status: "error" as const, message: t("Source unavailable") }
      : state?.key === previewKey
        ? state
        : null;
  const targetBotId = "botId" in threadTarget ? threadTarget.botId : undefined;
  const targetGroupId = "groupId" in threadTarget ? threadTarget.groupId : undefined;

  useEffect(() => {
    let cancelled = false;
    const requestTarget: MobileArtifactTarget =
      targetBotId !== undefined ? { botId: targetBotId } : { groupId: targetGroupId! };
    async function read() {
      if (!target.preview)
        return readMobileArtifactText(requestTarget, target.artifactId, target.mimeType);
      if (!target.preview.source) throw new Error("Source unavailable");
      const source = await rpc<{ kind: "text"; text: string } | { kind: "report" }>(
        "recruiting/readSource",
        target.preview.source,
      );
      if (source.kind !== "text") throw new Error("Source unavailable");
      return source.text;
    }
    void read()
      .then((text) => {
        if (!cancelled) setState({ key: previewKey, status: "ready", text });
      })
      .catch((error) => {
        if (cancelled) return;
        setState({
          key: previewKey,
          status: "error",
          message: target.preview
            ? t("Source unavailable")
            : errorText(error, t("Could not load this file.")),
        });
      });
    return () => {
      cancelled = true;
    };
  }, [targetBotId, targetGroupId, target.artifactId, target.mimeType, previewKey]);

  return (
    <Modal animationType="fade" presentationStyle="fullScreen" onRequestClose={onClose}>
      <SafeAreaView style={{ flex: 1, backgroundColor: tokens.background }}>
        <View
          style={{
            height: 54,
            flexDirection: "row",
            alignItems: "center",
            borderBottomWidth: iosAtLeast(26) ? 0 : 1,
            borderBottomColor: tokens.border,
            paddingHorizontal: 12,
          }}
        >
          <Text
            numberOfLines={1}
            style={{ flex: 1, color: tokens.foreground, fontSize: 15, fontWeight: "500" }}
          >
            {target.preview?.label ?? target.name}
          </Text>
          <View style={{ flexDirection: "row", gap: 8 }}>
            {!target.preview ? (
              <GlassIconButton
                accessibilityLabel={t("Share {name}", { name: target.name })}
                ios="square.and.arrow.up"
                android="share-social-outline"
                onPress={() =>
                  void openMobileArtifact(
                    threadTarget,
                    target.artifactId,
                    target.name,
                    target.mimeType,
                  ).catch((error) =>
                    Alert.alert(t("Could not share file"), errorText(error, t("Try again."))),
                  )
                }
              />
            ) : null}
            <GlassIconButton
              accessibilityLabel={t("Close preview")}
              ios="xmark"
              android="close"
              onPress={onClose}
            />
          </View>
        </View>
        <ScrollView contentContainerStyle={{ paddingHorizontal: 24, paddingVertical: 28 }}>
          {!current ? (
            <Text style={{ color: tokens.mutedForeground, fontSize: 15 }}>
              {t("Loading preview…")}
            </Text>
          ) : current.status === "error" ? (
            <View
              style={{
                borderRadius: 14,
                borderWidth: 1,
                borderColor: tokens.destructive,
                backgroundColor: tokens.card,
                padding: 14,
              }}
            >
              <Text style={{ color: tokens.destructive, fontSize: 15 }}>{current.message}</Text>
            </View>
          ) : target.preview ? (
            <Text selectable style={{ color: tokens.foreground, fontSize: 15, lineHeight: 23 }}>
              {current.text}
            </Text>
          ) : (
            <ChatMarkdown palette={tokens} colorScheme={colorScheme}>
              {current.text}
            </ChatMarkdown>
          )}
        </ScrollView>
      </SafeAreaView>
    </Modal>
  );
}
