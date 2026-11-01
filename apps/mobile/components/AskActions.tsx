import { multiSelectAskAnswer } from "@rakazo/core";
import { useState } from "react";
import type { ViewProps } from "react-native";
import { Alert, Pressable, Text, TextInput, View } from "react-native";
import { mobileTokens } from "../lib/appearance";
import { useI18n } from "../lib/i18n";
import { native } from "../lib/native";
import { errorText } from "../lib/user-error";
import { NativeActionButton } from "./native-action-button";
import { NativeSwitch } from "./native-switch";

type AskAction = { id: string; label: string };

const KNOWN_ASK_ACTION_LABELS: Record<string, string> = {
  "Allow once": "Allow once",
  "Always allow": "Always allow",
  "Always allow this tool": "Always allow",
  Deny: "Deny",
};

export function AskActions({
  actions,
  disabled,
  allowCustomAnswer,
  multiple,
  onAnswer,
  accessibilityActions,
  onAccessibilityAction,
}: {
  actions: AskAction[];
  disabled?: boolean;
  allowCustomAnswer?: boolean;
  /** Options are switches; the answer is every picked option plus any typed text. */
  multiple?: boolean;
  onAnswer: (answer: string) => Promise<void>;
  accessibilityActions?: ViewProps["accessibilityActions"];
  onAccessibilityAction?: ViewProps["onAccessibilityAction"];
}) {
  const { t } = useI18n();
  const tokens = mobileTokens();
  const [pendingAction, setPendingAction] = useState<string | null>(null);
  const [answer, setAnswer] = useState("");
  const [picked, setPicked] = useState<string[]>([]);
  const submitting = pendingAction !== null;
  const typedAnswer = multiple
    ? multiSelectAskAnswer(
        actions.filter((action) => picked.includes(action.id)).map((action) => action.label),
        answer,
      )
    : answer;

  async function submit(answer: string) {
    if (disabled || submitting || !answer.trim()) return;
    setPendingAction(answer);
    try {
      await onAnswer(answer);
    } catch (error) {
      Alert.alert(t("Could not submit answer"), errorText(error, t("Please try again.")));
    } finally {
      setPendingAction(null);
    }
  }

  return (
    <View style={{ marginTop: 12, gap: 6 }}>
      {multiple
        ? actions.map((action) => (
            <View
              key={action.id}
              style={{
                flexDirection: "row",
                alignItems: "center",
                gap: 8,
                borderRadius: 12,
                paddingHorizontal: 14,
                paddingVertical: 8,
                backgroundColor: native.fill,
              }}
            >
              <Text style={{ color: tokens.foreground, fontSize: 15, flex: 1 }}>
                {action.label}
              </Text>
              <NativeSwitch
                accessibilityLabel={action.label}
                disabled={disabled || submitting}
                value={picked.includes(action.id)}
                onValueChange={(checked) =>
                  setPicked((current) =>
                    checked ? [...current, action.id] : current.filter((id) => id !== action.id),
                  )
                }
              />
            </View>
          ))
        : null}
      {(multiple ? [] : actions).map((action) => {
        const emphasized = action.id === "allow" || action.id === "always";
        return (
          <Pressable
            key={action.id}
            accessibilityActions={accessibilityActions}
            onAccessibilityAction={onAccessibilityAction}
            disabled={disabled || submitting}
            onPress={() => void submit(action.id)}
            style={{
              alignSelf: "stretch",
              borderRadius: 12,
              paddingHorizontal: 14,
              paddingVertical: 12,
              backgroundColor: emphasized ? native.fillPressed : native.fill,
              opacity: disabled || submitting ? 0.5 : 1,
            }}
          >
            <Text
              style={{
                color: tokens.foreground,
                fontSize: 15,
                fontWeight: emphasized ? "600" : "400",
              }}
            >
              {pendingAction === action.id
                ? t("Sending…")
                : Object.hasOwn(KNOWN_ASK_ACTION_LABELS, action.label)
                  ? t(KNOWN_ASK_ACTION_LABELS[action.label]!)
                  : action.label}
            </Text>
          </Pressable>
        );
      })}
      {allowCustomAnswer || multiple ? (
        <>
          <TextInput
            accessibilityLabel={t("Answer")}
            value={answer}
            onChangeText={setAnswer}
            placeholder={t("Type your answer")}
            placeholderTextColor={tokens.mutedForeground}
            multiline
            editable={!disabled && !submitting}
            style={{
              minHeight: 42,
              borderRadius: 12,
              borderWidth: 1,
              borderColor: tokens.border,
              color: tokens.foreground,
              paddingHorizontal: 12,
              paddingVertical: 9,
            }}
          />
          <NativeActionButton
            label={t("Send answer")}
            disabled={disabled || !typedAnswer.trim()}
            busy={submitting}
            fill={false}
            onPress={() => void submit(typedAnswer)}
            style={{ alignSelf: "flex-end" }}
          />
        </>
      ) : null}
    </View>
  );
}
