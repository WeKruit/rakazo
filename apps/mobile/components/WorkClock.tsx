import type { WorkSession } from "@rakazo/core";
import { formatWorkClock, workSessionElapsedMs } from "@rakazo/core";
import { useEffect, useState } from "react";
import { Text } from "react-native";
import { useMobileTokens } from "../lib/native";

/** How long the current turn has been working; the footer's label carries the state. */
export function WorkClock({ session }: { session: WorkSession }) {
  const tokens = useMobileTokens();
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  return (
    <Text
      accessibilityElementsHidden
      importantForAccessibility="no"
      style={{
        color: tokens.mutedForeground,
        fontSize: 13,
        fontVariant: ["tabular-nums"],
        marginLeft: 8,
      }}
    >
      {formatWorkClock(workSessionElapsedMs(session, now))}
    </Text>
  );
}
