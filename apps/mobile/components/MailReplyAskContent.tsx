import type { AskAnswer, MailReply } from "@rakazo/contracts";
import { MailReplySendAnswerSchema } from "@rakazo/contracts";
import { useEffect, useRef, useState } from "react";
import { StyleSheet, Text, TextInput, View } from "react-native";
import { dateLocaleForUi, useI18n } from "../lib/i18n";
import { useMobileTokens } from "../lib/native";
import { NativeActionButton } from "./native-action-button";

/** Content of the existing Ask approval card; Send uses its one existing answer callback. */
export function MailReplyAskContent({
  reply,
  canAnswer,
  pending,
  onAnswer,
}: {
  reply: MailReply;
  canAnswer: boolean;
  pending: boolean;
  onAnswer: (answer: AskAnswer) => Promise<void>;
}) {
  const tokens = useMobileTokens();
  const { t, locale } = useI18n();
  const [body, setBody] = useState(reply.body);
  const [cc, setCc] = useState(reply.cc.join(", "));
  const [submitting, setSubmitting] = useState<"send" | "deny" | null>(null);
  const busy = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);
  const compact = reply.status !== "needs_approval";
  useEffect(() => {
    setBody(reply.body);
    setCc(reply.cc.join(", "));
  }, [reply.body, reply.cc.join(", ")]);
  const editing = canAnswer && pending && reply.status === "needs_approval" && !submitting;
  const parsed = MailReplySendAnswerSchema.safeParse({
    action: "send",
    body,
    cc: cc
      .split(/[,;\n]/)
      .map((value) => value.trim())
      .filter(Boolean),
  });
  const labels = {
    needs_approval: t("Needs approval"),
    sending: t("Sending…"),
    sent: t("Sent"),
    discarded: t("Discarded"),
    failed: t("Failed"),
    unknown: t("Send not confirmed"),
  };
  const status =
    submitting === "send"
      ? labels.sending
      : submitting === "deny"
        ? t("Discarding…")
        : labels[reply.status];
  async function submit(action: "send" | "deny") {
    if (!editing || busy.current || (action === "send" && !parsed.success)) return;
    busy.current = true;
    setSubmitting(action);
    setError(null);
    try {
      await onAnswer(action === "send" && parsed.success ? parsed.data : "deny");
    } catch {
      setError(
        action === "send" ? t("Could not send this reply.") : t("Could not discard this draft."),
      );
    } finally {
      busy.current = false;
      setSubmitting(null);
    }
  }
  const sentAt =
    reply.status === "sent" && reply.sentAt
      ? new Date(reply.sentAt).toLocaleString(dateLocaleForUi(locale))
      : null;
  return (
    <View style={styles.content}>
      <View style={styles.header}>
        <Text accessibilityRole="header" style={[styles.title, { color: tokens.foreground }]}>
          {t("Reply draft")}
        </Text>
        <Text
          accessibilityLiveRegion="polite"
          style={{
            color: reply.status === "failed" ? tokens.destructive : tokens.mutedForeground,
            fontSize: 12,
          }}
        >
          {status}
        </Text>
      </View>
      {!compact || expanded ? (
        <>
          <View style={[styles.anchor, { backgroundColor: tokens.muted }]}>
            <Text style={{ color: tokens.mutedForeground, fontSize: 12 }}>
              {t("Original email")}
            </Text>
            {reply.inReplyTo.subject ? (
              <Text selectable style={{ color: tokens.foreground, fontWeight: "600" }}>
                {reply.inReplyTo.subject}
              </Text>
            ) : null}
            {reply.inReplyTo.sender ? (
              <Text selectable style={{ color: tokens.mutedForeground, fontSize: 13 }}>
                {reply.inReplyTo.sender}
              </Text>
            ) : null}
          </View>
          <View style={styles.field}>
            <Text style={[styles.label, { color: tokens.mutedForeground }]}>{t("From")}</Text>
            <Text selectable style={{ color: tokens.foreground }}>
              {reply.from ?? t("Not provided")}
            </Text>
          </View>
          <View style={styles.field}>
            <Text style={[styles.label, { color: tokens.mutedForeground }]}>{t("To")}</Text>
            <Text selectable style={{ color: tokens.foreground }}>
              {reply.to.join(", ") || t("Not provided")}
            </Text>
          </View>
          <View style={styles.field}>
            <Text style={[styles.label, { color: tokens.mutedForeground }]}>{t("Cc")}</Text>
            <TextInput
              accessibilityLabel={t("Cc")}
              value={cc}
              onChangeText={setCc}
              editable={editing}
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="email-address"
              multiline
              maxLength={25_500}
              placeholder={t("Add Cc recipients")}
              placeholderTextColor={tokens.mutedForeground}
              style={[styles.input, { borderColor: tokens.border, color: tokens.foreground }]}
            />
          </View>
          {reply.bcc.length ? (
            <View style={styles.field}>
              <Text style={[styles.label, { color: tokens.mutedForeground }]}>{t("Bcc")}</Text>
              <Text selectable style={{ color: tokens.foreground }}>
                {reply.bcc.join(", ")}
              </Text>
            </View>
          ) : null}
          <View style={styles.field}>
            <Text style={[styles.label, { color: tokens.mutedForeground }]}>{t("Subject")}</Text>
            <Text selectable style={{ color: tokens.foreground, fontWeight: "600" }}>
              {reply.subject}
            </Text>
          </View>
          <TextInput
            accessibilityLabel={t("Reply message")}
            value={body}
            onChangeText={setBody}
            editable={editing}
            multiline
            scrollEnabled
            textAlignVertical="top"
            maxLength={20_000}
            style={[
              styles.input,
              styles.body,
              { borderColor: tokens.border, color: tokens.foreground },
            ]}
          />
        </>
      ) : (
        <View style={styles.field}>
          <Text selectable style={{ color: tokens.foreground }}>
            {reply.to.join(", ")}
          </Text>
          <Text selectable style={{ color: tokens.foreground, fontWeight: "600" }}>
            {reply.subject}
          </Text>
        </View>
      )}
      {compact ? (
        <NativeActionButton
          label={expanded ? t("Hide email") : t("View email")}
          prominence="quiet"
          onPress={() => setExpanded((value) => !value)}
        />
      ) : null}
      {sentAt ? (
        <Text style={{ color: tokens.mutedForeground, fontSize: 12 }}>
          {t("Sent at {time}", { time: sentAt })}
        </Text>
      ) : null}
      {reply.status === "failed" || reply.status === "unknown" ? (
        <Text accessibilityLiveRegion="polite" style={{ color: tokens.destructive, fontSize: 13 }}>
          {reply.status === "failed"
            ? t("This reply could not be sent.")
            : t("Delivery is not confirmed. Check the conversation before trying again.")}
        </Text>
      ) : null}
      {error ? (
        <Text accessibilityRole="alert" style={{ color: tokens.destructive, fontSize: 13 }}>
          {error}
        </Text>
      ) : null}
      {canAnswer && pending && reply.status === "needs_approval" ? (
        <View style={styles.actions}>
          <NativeActionButton
            label={t("Discard")}
            prominence="secondary"
            disabled={Boolean(submitting)}
            busy={submitting === "deny"}
            onPress={() => void submit("deny")}
            style={styles.action}
          />
          <NativeActionButton
            label={t("Send")}
            disabled={Boolean(submitting) || !parsed.success}
            busy={submitting === "send"}
            onPress={() => void submit("send")}
            style={styles.action}
          />
        </View>
      ) : null}
    </View>
  );
}
const styles = StyleSheet.create({
  content: { gap: 12 },
  header: {
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 8,
  },
  title: { fontSize: 16, fontWeight: "600" },
  anchor: { borderRadius: 10, padding: 10, gap: 4 },
  field: { gap: 5 },
  label: { fontSize: 12 },
  input: {
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 10,
    paddingVertical: 9,
    fontSize: 15,
    lineHeight: 22,
  },
  body: { minHeight: 136, maxHeight: 320 },
  actions: { flexDirection: "row", flexWrap: "wrap", gap: 8, marginTop: 2 },
  action: { flex: 1 },
});
