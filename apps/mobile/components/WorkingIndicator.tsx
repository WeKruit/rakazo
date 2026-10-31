import type { WorkSession, WorkStageKind, WorkStep } from "@rakazo/core";
import {
  formatWorkClock,
  formatWorkDuration,
  workActivityLabel,
  workProgressLabel,
  workSessionElapsedMs,
  workSessionStages,
  workStageLabel,
} from "@rakazo/core";
import { useEffect, useState } from "react";
import { Pressable, Text, View } from "react-native";
import type { SharedValue } from "react-native-reanimated";
import Animated, {
  cancelAnimation,
  Easing,
  interpolate,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withRepeat,
  withTiming,
} from "react-native-reanimated";
import { useI18n } from "../lib/i18n";
import { useMobileTokens } from "../lib/native";
import { NativeActionButton } from "./native-action-button";

const CYCLE_MS = 1100;
const DOTS = [0, 1, 2];

function Dot({
  progress,
  offset,
  color,
  size,
  still,
}: {
  progress: SharedValue<number>;
  offset: number;
  color: string;
  size: number;
  still: boolean;
}) {
  const style = useAnimatedStyle(() => {
    if (still) return { opacity: 0.55, transform: [{ scale: 1 }] };
    const phase = (progress.value + offset) % 1;
    return {
      opacity: interpolate(phase, [0, 0.5, 1], [0.25, 1, 0.25]),
      transform: [{ scale: interpolate(phase, [0, 0.5, 1], [0.85, 1.15, 0.85]) }],
    };
  });
  return (
    <Animated.View
      style={[{ width: size, height: size, borderRadius: size / 2, backgroundColor: color }, style]}
    />
  );
}

const LIVE_STEP_WINDOW = 6;

function StepClock({ startedAt }: { startedAt: string }) {
  const tokens = useMobileTokens();
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  return (
    <Text style={{ color: tokens.mutedForeground, fontSize: 12, fontVariant: ["tabular-nums"] }}>
      {formatWorkClock(now - Date.parse(startedAt))}
    </Text>
  );
}

function StepRows({ steps }: { steps: readonly WorkStep[] }) {
  const tokens = useMobileTokens();
  const { t } = useI18n();
  return steps.map((step, index) => (
    <Text key={index} style={{ color: tokens.mutedForeground, fontSize: 13 }}>
      <Text
        accessibilityLabel={
          step.status === "failed"
            ? t("Step failed")
            : step.status === "paused"
              ? t("Paused")
              : undefined
        }
        style={{ color: step.status ? tokens.warning : tokens.success }}
      >
        {step.status ? "! " : "✓ "}
      </Text>
      {t(workActivityLabel(step.activity))}
      {step.count > 1 ? ` ×${step.count}` : ""}
      {step.peopleWithEmail !== undefined
        ? ` · ${t(step.peopleWithEmail === 1 ? "{count} person with email" : "{count} people with email", { count: step.peopleWithEmail })}`
        : ""}
      {step.durationMs !== undefined ? ` · ${formatWorkDuration(step.durationMs)}` : ""}
    </Text>
  ));
}

/** Work handed to a teammate: one row named for its purpose that opens to its own steps. */
function StageRow({
  label,
  running,
  steps,
  onOpen,
  onCancel,
}: {
  label: string;
  running: boolean;
  steps: readonly WorkStep[];
  onOpen?: () => void;
  onCancel?: () => void;
}) {
  const tokens = useMobileTokens();
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const status = running ? t("Working…") : t("Done");
  return (
    <View style={{ gap: 4 }}>
      <Pressable
        disabled={!steps.length}
        onPress={() => setOpen((value) => !value)}
        accessibilityRole="button"
        accessibilityLabel={`${label}, ${status}`}
        accessibilityState={{ expanded: steps.length ? open : undefined }}
        hitSlop={8}
        style={{ flexDirection: "row", alignItems: "center", gap: 6, alignSelf: "flex-start" }}
      >
        <Text style={{ color: running ? tokens.warning : tokens.success, fontSize: 13 }}>
          {running ? "◷" : "✓"}
        </Text>
        <Text style={{ color: running ? tokens.foreground : tokens.mutedForeground, fontSize: 13 }}>
          {label}
        </Text>
        {steps.length ? (
          <Text style={{ color: tokens.mutedForeground, fontSize: 13 }}>{open ? "▾" : "▸"}</Text>
        ) : null}
      </Pressable>
      {open ? (
        <View
          style={{
            marginLeft: 6,
            paddingLeft: 12,
            borderLeftWidth: 1,
            borderLeftColor: tokens.border,
            gap: 4,
          }}
        >
          <StepRows steps={running ? steps.slice(-LIVE_STEP_WINDOW) : steps} />
        </View>
      ) : null}
      {onOpen || (running && onCancel) ? (
        <View style={{ flexDirection: "row", gap: 8 }}>
          {onOpen ? (
            <NativeActionButton label={t("View")} onPress={onOpen} prominence="plain" />
          ) : null}
          {running && onCancel ? (
            <NativeActionButton label={t("Cancel task")} onPress={onCancel} prominence="plain" />
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

function Stages({
  session,
  stageKind,
  onOpenStage,
  onCancelStage,
}: {
  session: WorkSession | null;
  stageKind: (botId: string) => WorkStageKind;
  onOpenStage?: (botId: string) => void;
  onCancelStage?: (botId: string) => void;
}) {
  const { t } = useI18n();
  return workSessionStages(session).stages.map((stage) => (
    <StageRow
      key={stage.botId}
      label={t(workStageLabel(stageKind(stage.botId)))}
      running={stage.running}
      steps={stage.steps}
      onOpen={onOpenStage ? () => onOpenStage(stage.botId) : undefined}
      onCancel={onCancelStage ? () => onCancelStage(stage.botId) : undefined}
    />
  ));
}

/**
 * A bot is working: dots pulsing in sequence, matching the web's shimmer moment.
 * `compact` is a single dot for list rows — decorative there, so the row's own
 * accessibility label carries the state instead.
 */
export function WorkingIndicator({
  compact = false,
  tint,
  session,
  stageKind = () => "other",
  label: feedbackLabel,
  onOpenStage,
  onCancelStage,
}: {
  compact?: boolean;
  tint?: string;
  session?: WorkSession | null;
  /** What each handed-off stage is for, from the member doing it. */
  stageKind?: (botId: string) => WorkStageKind;
  label?: string;
  onOpenStage?: (botId: string) => void;
  onCancelStage?: (botId: string) => void;
}) {
  const tokens = useMobileTokens();
  const { t } = useI18n();
  const reducedMotion = useReducedMotion();
  const progress = useSharedValue(0);
  const workProgress = session?.progress;
  const label =
    feedbackLabel ??
    (workProgress
      ? t(workProgressLabel(workProgress))
      : session?.current
        ? `${t(workActivityLabel(session.current))}…`
        : t("Working…"));

  useEffect(() => {
    if (reducedMotion || session?.endedAt) return;
    progress.value = withRepeat(
      withTiming(1, { duration: CYCLE_MS, easing: Easing.linear }),
      -1,
      false,
    );
    return () => cancelAnimation(progress);
  }, [progress, reducedMotion, session?.endedAt]);

  if (compact) {
    return (
      <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
        <Dot
          progress={progress}
          offset={0}
          size={8}
          still={reducedMotion}
          color={tint || tokens.mutedForeground}
        />
      </View>
    );
  }
  if (session?.endedAt) {
    return (
      <View style={{ gap: 4, marginTop: 8 }}>
        <Text style={{ color: tokens.mutedForeground, fontSize: 13 }}>
          {t("Worked for {duration}", {
            duration: formatWorkDuration(workSessionElapsedMs(session, Date.now())),
          })}
        </Text>
        <Stages
          session={session}
          stageKind={stageKind}
          onOpenStage={onOpenStage}
          onCancelStage={onCancelStage}
        />
      </View>
    );
  }
  // ponytail: cap live rows like web; completed history remains in the shared session.
  const steps = workSessionStages(session ?? null).own.slice(-LIVE_STEP_WINDOW);
  return (
    <View style={{ flexShrink: 1, gap: 4 }}>
      <StepRows steps={steps} />
      <Stages
        session={session ?? null}
        stageKind={stageKind}
        onOpenStage={onOpenStage}
        onCancelStage={onCancelStage}
      />
      <View
        accessibilityLabel={label}
        accessibilityRole="text"
        accessibilityLiveRegion="polite"
        style={{
          alignSelf: "flex-start",
          flexShrink: 1,
          flexDirection: "row",
          alignItems: "center",
          gap: 6,
          backgroundColor: tokens.muted,
          paddingHorizontal: 14,
          paddingVertical: 12,
          borderRadius: 20,
        }}
      >
        {DOTS.map((index) => (
          <Dot
            key={index}
            progress={progress}
            offset={index / DOTS.length}
            size={7}
            still={reducedMotion}
            color={tokens.mutedForeground}
          />
        ))}
        {session ? (
          <Text style={{ color: tokens.mutedForeground, fontSize: 13, flexShrink: 1 }}>
            {label}
          </Text>
        ) : null}
        {session?.currentStartedAt ? <StepClock startedAt={session.currentStartedAt} /> : null}
      </View>
    </View>
  );
}
