import { useLingui } from "@lingui/react/macro";
import type {
  AgentSkillCatalogEntry,
  Bot,
  ComputerStatus,
  Routine,
  TaughtSkill,
  ThreadMessage,
  ThreadSnapshot,
  VoiceStatus,
} from "@rakazo/contracts";
import { speechFromBlocks } from "@rakazo/core";
import type { Dispatch, RefObject, SetStateAction } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { Panel } from "../../lib/right-panel-state";
import { rpc } from "../../lib/rpc";
import { clearActiveThreadRuns } from "../../lib/thread-events";
import { speaker } from "../../lib/tts";
import { errorText } from "../../lib/user-error";
import type { RoutineDraftState } from "../routine-draft";
import { emptyRoutineDraft } from "../routine-draft";

export function useShellAgentActions({
  showToolActivity,
  active,
  snapshot,
  callBotId,
  sending,
  sendingRef,
  setSending,
  activeBotId,
  activeGroupId,
  setSendError,
  updateSnapshot,
  refreshThreadRef,
  refreshGroupThreadRef,
  computerRef,
  commitComputer,
  teachBusy,
  taughtSkills,
  taughtSkillsBotId,
  setTeachBusy,
  setComputerOpen,
  setTaughtSkills,
  setTaughtSkillsBotId,
  setRoutineDraft,
  setRoutineWebhookSecret,
  setEditingRoutine,
  setPanel,
}: {
  showToolActivity: boolean;
  active: Bot | undefined;
  snapshot: ThreadSnapshot | null;
  callBotId: string | undefined;
  sending: boolean;
  sendingRef: RefObject<boolean>;
  setSending: Dispatch<SetStateAction<boolean>>;
  activeBotId: RefObject<string | undefined>;
  activeGroupId: RefObject<string | undefined>;
  setSendError: Dispatch<SetStateAction<string | null>>;
  updateSnapshot: (update: (prev: ThreadSnapshot | null) => ThreadSnapshot | null) => void;
  refreshThreadRef: RefObject<(id: string) => Promise<ThreadSnapshot>>;
  refreshGroupThreadRef: RefObject<(id: string) => Promise<ThreadSnapshot>>;
  computerRef: RefObject<ComputerStatus | null>;
  commitComputer: (next: ComputerStatus | null) => void;
  teachBusy: boolean;
  taughtSkills: TaughtSkill[];
  taughtSkillsBotId: string | null;
  setTeachBusy: Dispatch<SetStateAction<boolean>>;
  setComputerOpen: Dispatch<SetStateAction<boolean>>;
  setTaughtSkills: Dispatch<SetStateAction<TaughtSkill[]>>;
  setTaughtSkillsBotId: Dispatch<SetStateAction<string | null>>;
  setRoutineDraft: Dispatch<SetStateAction<RoutineDraftState>>;
  setRoutineWebhookSecret: Dispatch<SetStateAction<string | null>>;
  setEditingRoutine: Dispatch<SetStateAction<Routine | null>>;
  setPanel: (next: Panel | ((current: Panel) => Panel)) => void;
}) {
  const { t } = useLingui();
  const [agentSkills, setAgentSkills] = useState<AgentSkillCatalogEntry[]>([]);

  const [voiceStatus, setVoiceStatus] = useState<VoiceStatus | null>(null);
  const [speakingMessageId, setSpeakingMessageId] = useState<string | null>(null);

  const autoSpoken = useRef<string | null>(null);
  const autoSpokenBotId = useRef<string | null>(null);
  useEffect(() => {
    if (!showToolActivity) return;
    let cancelled = false;
    void rpc.agentSkills
      .list()
      .then((skills) => {
        if (!cancelled) setAgentSkills(skills);
      })
      .catch(() => {
        if (!cancelled) setAgentSkills([]);
      });
    return () => {
      cancelled = true;
    };
  }, [showToolActivity]);

  const refreshAgentSkills = useCallback(() => {
    void rpc.agentSkills
      .list()
      .then(setAgentSkills)
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    void rpc.voice
      .status()
      .then(setVoiceStatus)
      .catch(() => undefined);
    const unsubSpeech = speaker.subscribe((state) => {
      setSpeakingMessageId(state.status === "idle" ? null : (state.messageId ?? null));
    });
    return () => {
      unsubSpeech();
    };
  }, []);

  useEffect(() => {
    if (!active || !snapshot || snapshot.botId !== active.id) return;
    const lastBot = [...snapshot.messages].reverse().find((message) => message.role === "bot");
    if (autoSpokenBotId.current !== active.id) {
      autoSpokenBotId.current = active.id;
      autoSpoken.current = lastBot?.id ?? null;
      return;
    }
    if (callBotId === active.id || !active.autoSpeak) {
      autoSpoken.current = lastBot?.id ?? null;
      return;
    }
    if (snapshot.run && ["running", "queued", "leased"].includes(snapshot.run.status)) return;
    if (!lastBot || lastBot.id === autoSpoken.current) return;
    const text = speechFromBlocks(lastBot.blocks);
    if (!text) return;
    autoSpoken.current = lastBot.id;
    void speaker.speak(text, { botId: active.id, messageId: lastBot.id });
  }, [
    snapshot?.messages,
    snapshot?.run?.status,
    snapshot?.botId,
    active?.autoSpeak,
    active?.id,
    callBotId,
  ]);

  const stopRun = useCallback(
    async (runId?: string, scope: "turn" | "all" = "turn") => {
      if (sending) return;
      sendingRef.current = true;
      setSending(true);
      try {
        const botTarget = activeBotId.current;
        const groupTarget = activeGroupId.current;
        if (groupTarget) {
          setSendError(null);
          try {
            await rpc.threads.stop({
              groupId: groupTarget,
              scope,
              ...(runId !== undefined ? { runId } : {}),
            });
          } catch (error) {
            if (activeGroupId.current === groupTarget) {
              setSendError(errorText(error, t`Failed to stop`));
            }
            return;
          }
          // Clear run UI ahead of the run.cancelled event so refresh races with in-flight gets.
          if (activeGroupId.current === groupTarget && (runId !== undefined || scope === "all")) {
            updateSnapshot((prev) =>
              prev && prev.groupId === groupTarget ? clearActiveThreadRuns(prev, runId) : prev,
            );
          }
          await refreshGroupThreadRef.current(groupTarget).catch(() => undefined);
          return;
        }
        if (!botTarget) return;
        setSendError(null);
        try {
          await rpc.threads.stop({
            botId: botTarget,
            scope,
            ...(runId !== undefined ? { runId } : {}),
          });
        } catch (error) {
          if (activeBotId.current === botTarget) {
            setSendError(errorText(error, t`Failed to stop`));
          }
          return;
        }
        // Clear local run/busy immediately rather than waiting for run.cancelled so a
        // superseded in-flight refresh (older cursor) cannot leave Stop enabled / Take control
        // blocked while the API is already idle.
        if (activeBotId.current === botTarget && (runId !== undefined || scope === "all")) {
          updateSnapshot((prev) =>
            !prev || (prev.botId !== botTarget && prev.botId)
              ? prev
              : clearActiveThreadRuns(prev, runId),
          );
          const currentComputer = computerRef.current;
          if (runId === undefined && currentComputer?.busyBotName) {
            commitComputer({ ...currentComputer, busyBotName: null });
          }
        }
        await refreshThreadRef.current(botTarget).catch(() => undefined);
      } finally {
        sendingRef.current = false;
        setSending(false);
      }
    },
    [sending, t],
  );
  const stopTeaching = useCallback(async () => {
    const id = activeBotId.current;
    if (!id || teachBusy) return;
    const recording = taughtSkills.find(
      (skill) => skill.status === "recording" && taughtSkillsBotId === id,
    );
    if (!recording) return;
    setTeachBusy(true);
    try {
      await rpc.skills.stop({ skillId: recording.id });
      await refreshThreadRef.current(id);
      setComputerOpen(false);
    } finally {
      setTeachBusy(false);
    }
  }, [teachBusy, taughtSkills, taughtSkillsBotId]);
  // Transcript and MessageView are memoized; these must stay referentially stable or every
  // Shell state change re-renders the whole transcript.
  const refreshActiveThread = useCallback(async () => {
    const groupId = activeGroupId.current;
    if (groupId) {
      await refreshGroupThreadRef.current(groupId);
      return;
    }
    const id = activeBotId.current;
    if (!id) return;
    await refreshThreadRef.current(id);
  }, []);
  // Teach chrome needs skills applied before this resolves — refreshThread only
  // kicks skills.list off in the background, so Stop teaching would never mount
  // if that background call failed or lagged behind local recovery.
  const refreshActiveTeaching = useCallback(async () => {
    const id = activeBotId.current;
    if (!id) return;
    await refreshThreadRef.current(id);
    const skills = await rpc.skills.list({ botId: id });
    if (activeBotId.current !== id) return;
    setTaughtSkills(skills);
    setTaughtSkillsBotId(id);
  }, []);
  const addSkillRoutine = useCallback((name: string, prompt: string) => {
    setRoutineDraft({ ...emptyRoutineDraft(), name, prompt });
    setRoutineWebhookSecret(null);
    setEditingRoutine(null);
    setPanel("routine");
  }, []);
  const speakingMessageIdRef = useRef(speakingMessageId);
  speakingMessageIdRef.current = speakingMessageId;
  const speakMessage = useCallback((message: ThreadMessage) => {
    if (speakingMessageIdRef.current === message.id) {
      speaker.stop();
      return;
    }
    const text = speechFromBlocks(message.blocks);
    const id = message.botId ?? activeBotId.current;
    if (text && id) void speaker.speak(text, { botId: id, messageId: message.id });
  }, []);

  return {
    agentSkills,
    setAgentSkills,
    voiceStatus,
    setVoiceStatus,
    speakingMessageId,
    refreshAgentSkills,
    stopRun,
    stopTeaching,
    refreshActiveThread,
    refreshActiveTeaching,
    addSkillRoutine,
    speakMessage,
  };
}
