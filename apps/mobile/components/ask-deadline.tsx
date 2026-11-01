import { formatWorkDuration } from "@rakazo/core";
import { useEffect, useState } from "react";
import { Text } from "react-native";
import { mobileTokens } from "../lib/appearance";
import { useI18n } from "../lib/i18n";

export function AskDeadline({ expiresAt }: { expiresAt: string }) {
  const { t } = useI18n();
  const tokens = mobileTokens();
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);
  const remaining = Math.max(0, Date.parse(expiresAt) - now);
  const time = formatWorkDuration(Math.ceil(remaining / 60_000) * 60_000);
  return (
    <Text
      testID="ask-deadline"
      style={{ marginTop: 8, color: tokens.mutedForeground, fontSize: 12 }}
    >
      {remaining > 0 ? t("Expires in {time}", { time }) : t("Expired")}
    </Text>
  );
}
