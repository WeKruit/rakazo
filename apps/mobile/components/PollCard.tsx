import type { MessageBlock } from "@rakazo/contracts";
import { formatWorkDuration, pollTally } from "@rakazo/core";
import { useEffect, useState } from "react";
import { Alert, Pressable, StyleSheet, Text, View } from "react-native";
import { rpc } from "../lib/api";
import { useI18n } from "../lib/i18n";
import { native, useMobileTokens } from "../lib/native";
import { useThreadReadOnly } from "../lib/thread-read-only";
import { errorText } from "../lib/user-error";
import { NativeActionButton } from "./native-action-button";

const styles = StyleSheet.create({
  card: { borderRadius: 18, paddingHorizontal: 16, paddingVertical: 14, gap: 10 },
  question: { fontSize: 15, fontWeight: "600" },
  option: {
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth,
    flexDirection: "row",
    justifyContent: "space-between",
    overflow: "hidden",
    paddingHorizontal: 12,
    paddingVertical: 9,
  },
  bar: { bottom: 0, left: 0, position: "absolute", top: 0 },
  label: { flexShrink: 1, fontSize: 14 },
  count: { fontSize: 14, fontVariant: ["tabular-nums"] },
  footer: { fontSize: 12.5 },
});

/** The asker keeps working; counts are live and the person's own pick is outlined. */
export function PollCard({
  target,
  block,
}: {
  target: { botId: string } | { groupId: string };
  block: Extract<MessageBlock, { kind: "poll" }>;
}) {
  const { t } = useI18n();
  const readOnly = useThreadReadOnly();
  const tokens = useMobileTokens();
  const [now, setNow] = useState(Date.now);
  const [picked, setPicked] = useState<string[] | null>(null);
  const [busy, setBusy] = useState(false);
  const remaining = Math.max(0, Date.parse(block.closesAt) - now);
  const open = block.status === "open" && remaining > 0 && !readOnly;
  const slow = remaining > 3_600_000;
  useEffect(() => {
    if (!open) return;
    const timer = setInterval(() => setNow(Date.now()), slow ? 30_000 : 1_000);
    return () => clearInterval(timer);
  }, [open, slow]);
  const mine = block.votes.find((vote) => vote.voter === "user")?.optionIds ?? [];
  const selected = picked ?? mine;
  const total = block.votes.length;
  const changed =
    picked !== null && (picked.length !== mine.length || picked.some((id) => !mine.includes(id)));

  async function submit(optionIds: string[]) {
    if (busy || optionIds.length === 0) return;
    setBusy(true);
    try {
      await rpc("threads/votePoll", { ...target, pollId: block.pollId, optionIds });
      setPicked(null);
    } catch (reason) {
      setPicked(null);
      Alert.alert(t("Could not record your vote"), errorText(reason, t("Please try again.")));
    } finally {
      setBusy(false);
    }
  }

  function choose(id: string) {
    if (!open || busy) return;
    if (!block.multiple) {
      setPicked([id]);
      void submit([id]);
      return;
    }
    setPicked(selected.includes(id) ? selected.filter((x) => x !== id) : [...selected, id]);
  }

  return (
    <View style={[styles.card, { backgroundColor: native.fill }]}>
      <Text style={[styles.question, { color: tokens.foreground }]}>{block.question}</Text>
      {pollTally(block).map((row) => {
        const chosen = selected.includes(row.id);
        return (
          <Pressable
            key={row.id}
            accessibilityRole="button"
            accessibilityState={{ selected: chosen, disabled: !open || busy }}
            accessibilityLabel={`${row.label}, ${row.count}`}
            disabled={!open || busy}
            onPress={() => choose(row.id)}
            style={[styles.option, { borderColor: chosen ? tokens.primary : native.separator }]}
          >
            <View
              style={[
                styles.bar,
                {
                  backgroundColor: native.fillPressed,
                  width: `${total ? Math.round((row.count / total) * 100) : 0}%`,
                },
              ]}
            />
            <Text style={[styles.label, { color: tokens.foreground }]}>{row.label}</Text>
            <Text style={[styles.count, { color: tokens.mutedForeground }]}>{row.count}</Text>
          </Pressable>
        );
      })}
      {block.multiple && open && changed ? (
        <NativeActionButton
          label={t("Vote")}
          fill={false}
          disabled={busy || selected.length === 0}
          onPress={() => void submit(selected)}
        />
      ) : null}
      <Text style={[styles.footer, { color: tokens.mutedForeground }]}>
        {block.status === "open" && remaining > 0
          ? t("Closes in {time}", { time: formatWorkDuration(remaining) })
          : t("Closed")}
      </Text>
    </View>
  );
}
