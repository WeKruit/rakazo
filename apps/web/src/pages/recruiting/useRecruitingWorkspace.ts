import { useLingui } from "@lingui/react/macro";
import { ORPCError } from "@orpc/client";
import type { ListRecruitingCandidatesOutput, RecruitingCandidate } from "@rakazo/contracts";
import { RecruitingEmploymentRuleSchema } from "@rakazo/contracts";
import { recruitingBriefClarifications } from "@rakazo/core";
import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { retryTransientRead } from "../../lib/read-retry";
import { clearRecruitingReads, rememberRecruitingRead } from "../../lib/recruiting-read-cache";
import type { RecruitingPanelState } from "../../lib/right-panel-state";
import {
  readRecruitingPanelState,
  rightPanelStorageKey,
  writeRecruitingPanelState,
} from "../../lib/right-panel-state";
import { rpc } from "../../lib/rpc";
import type { CriteriaEdit } from "../recruiting/CriteriaEditor";
import { criteriaDraft, searchFilterDraft } from "../recruiting/CriteriaEditor";
import { useArrivals } from "../recruiting/shared";
import type { CandidateDiscussionContext, Props, Snapshot } from "../recruiting/workspace-types";

export function useRecruitingWorkspace({
  shortlistWeekFilter,
  onClearShortlistWeekFilter,
  userId,
  threadId,
  botId,
  groupId,
  readCache,
  readCacheScope,
  refreshSignal,
  onClose,
  onBrowseCandidates,
  onRevealMessage,
  onDiscussCandidate,
  onCandidateFeedback,
  candidateFeedbackRecipients,
  showDiagnostics = false,
  presentation = "panel",
  summary,
  view = "results",
  tab,
  onTabChange,
}: Props & { userId?: string }) {
  const { t } = useLingui();
  const shortlistFilterId = useId();
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const workspaceCacheKey = readCacheScope ? `${readCacheScope}:workspace` : undefined;
  const [workspaceSnapshot, setWorkspaceSnapshot] = useState<Pick<Snapshot, "workspace"> | null>(
    () =>
      workspaceCacheKey
        ? ((readCache?.entries.get(workspaceCacheKey) as Pick<Snapshot, "workspace"> | undefined) ??
          null)
        : null,
  );
  const initialStorageKey =
    workspaceSnapshot?.workspace && userId
      ? `${rightPanelStorageKey(userId, workspaceSnapshot.workspace.role.spaceId, botId ? "bot" : "group", threadId)}:recruiting:${workspaceSnapshot.workspace.role.id}`
      : null;
  const [refresh, setRefresh] = useState(0);
  const workspaceReadKey = JSON.stringify([threadId, refresh, refreshSignal]);
  const [validatedWorkspaceRead, setValidatedWorkspaceRead] = useState<string>();
  const [feedbackRefresh, setFeedbackRefresh] = useState(0);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [confirmationFailed, setConfirmationFailed] = useState(false);
  const [candidateList, setCandidateList] = useState(() =>
    readRecruitingPanelState(initialStorageKey),
  );
  const activeTab = tab ?? (presentation === "workspace" ? "evidence" : candidateList.tab);
  const contactsView = presentation === "workspace" && view === "contacts";
  const shortlistView = presentation === "workspace" && view === "shortlist";
  const candidateWorkspace =
    presentation === "workspace" && !showDiagnostics && activeTab === "evidence" && !summary;
  const requestedTab = useRef(tab);
  requestedTab.current = tab;
  useEffect(() => {
    if (tab) setCandidateList((current) => (current.tab === tab ? current : { ...current, tab }));
  }, [tab]);
  useEffect(() => {
    if (workspaceSnapshot) onTabChange?.(activeTab);
  }, [activeTab, workspaceSnapshot, onTabChange]);
  const [candidateStorageKey, setCandidateStorageKey] = useState<string | null>(initialStorageKey);
  const tabsList = useRef<HTMLDivElement>(null);
  const {
    candidateView: storedCandidateView,
    filters: storedCandidateFilters,
    detailOpen: candidateDetailOpen,
  } = candidateList;
  const candidateView = contactsView ? "table" : storedCandidateView;
  const filteredShortlistWeek = Boolean(shortlistWeekFilter);
  const candidateFilters = useMemo(
    () =>
      filteredShortlistWeek
        ? { shortlisted: true as const, sort: storedCandidateFilters.sort }
        : presentation === "workspace" && view === "shortlist"
          ? { ...storedCandidateFilters, shortlisted: true as const }
          : storedCandidateFilters,
    [presentation, view, storedCandidateFilters, filteredShortlistWeek],
  );
  // Every returned candidate keeps Autumn's own result fields in the workspace table.
  const candidateTableDetails = presentation === "workspace" && !contactsView;
  const [selection, setSelection] = useState<RecruitingCandidate | null>(null);
  const candidateTrigger = useRef<HTMLButtonElement>(null);
  const candidateClose = useRef<HTMLButtonElement>(null);
  const candidateHandoff = useRef<(() => void) | null>(null);
  const [candidatePage, setCandidatePage] = useState<ListRecruitingCandidatesOutput | null>(null);
  const candidateKeys = useMemo(
    () => candidatePage?.items.map((item) => item.candidateKey),
    [candidatePage],
  );
  const arrival = useArrivals(candidateKeys);
  function setCandidateFilters(
    update: (current: RecruitingPanelState["filters"]) => RecruitingPanelState["filters"],
  ) {
    candidateGeneration.current++;
    setCandidatePage(null);
    setCandidateList((current) => ({ ...current, filters: update(current.filters), pageCount: 1 }));
  }
  function setCandidateDetailOpen(detailOpen: boolean) {
    setCandidateList((current) => ({ ...current, detailOpen }));
  }
  const [candidateLoading, setCandidateLoading] = useState(false);
  const [candidateFailed, setCandidateFailed] = useState(false);
  const [shortlistPending, setShortlistPending] = useState<string | null>(null);
  const [shortlistFailed, setShortlistFailed] = useState<string | null>(null);
  const shortlistMutation = useRef<object | null>(null);
  const [selectedEvidence, setSelectedEvidence] = useState<{
    key: string;
    value: Awaited<ReturnType<typeof rpc.recruiting.getAssessment>>;
  } | null>(null);
  const [evidenceFailed, setEvidenceFailed] = useState(false);
  const candidateGeneration = useRef(0);
  const candidateReadAbort = useRef<AbortController | null>(null);
  const previousCandidateSearch = useRef<{ scope: string; query?: string } | undefined>(undefined);
  const loadingMore = useRef(false);
  const readEpoch = useRef(0);
  const candidateValidation = useRef<number | undefined>(undefined);
  const candidateValidatedRead = useRef<string | undefined>(undefined);
  const displayedCandidateQuery = useRef<string | undefined>(undefined);
  const denyAccess = useCallback(
    (error: unknown) => {
      console.error(
        "Recruiting request failed",
        JSON.stringify({
          name: error instanceof Error ? error.name : undefined,
          code: error instanceof ORPCError ? error.code : undefined,
          message: error instanceof Error ? error.message : undefined,
        }),
      );
      if (
        !(error instanceof ORPCError) ||
        !["UNAUTHORIZED", "FORBIDDEN", "NOT_FOUND"].includes(error.code)
      )
        return;
      readEpoch.current++;
      clearRecruitingReads(readCache, readCacheScope);
      candidateGeneration.current++;
      setSnapshot(null);
      setWorkspaceSnapshot(null);
      setCandidatePage(null);
      setSelection(null);
      setCandidateList((current) => ({
        ...current,
        selectedCandidateKey: null,
        detailOpen: false,
      }));
      candidateHandoff.current = null;
      setSelectedEvidence(null);
      setCriteriaEdit(null);
      shortlistMutation.current = null;
      setShortlistPending(null);
      setFailed(true);
      editScope.current.roleId = null;
      editScope.current.generation++;
    },
    [readCache, readCacheScope],
  );
  const [criteriaEdit, setCriteriaEdit] = useState<CriteriaEdit | null>(null);
  const [savingCriteria, setSavingCriteria] = useState(false);
  const [criteriaFailed, setCriteriaFailed] = useState(false);
  const editScope = useRef({
    active: true,
    roleId: workspaceSnapshot?.workspace?.role.id ?? (null as string | null),
    generation: 0,
  });
  useEffect(() => {
    editScope.current.active = true;
    return () => {
      editScope.current.active = false;
      editScope.current.generation++;
      candidateHandoff.current = null;
    };
  }, []);
  useEffect(() => {
    let cancelled = false;
    const epoch = readEpoch.current;
    let cacheEpoch = readCache?.epoch;
    setLoading(true);
    setFailed(false);
    const updateEditScope = (workspace: Snapshot["workspace"]) => {
      const roleId = workspace?.role.id ?? null;
      if (editScope.current.roleId === roleId) return;
      const changingRole = editScope.current.roleId !== null;
      if (changingRole) {
        clearRecruitingReads(readCache, readCacheScope);
        cacheEpoch = readCache?.epoch;
      }
      editScope.current.roleId = roleId;
      editScope.current.generation++;
      candidateGeneration.current++;
      setCriteriaEdit(null);
      setSavingCriteria(false);
      setCriteriaFailed(false);
      const key =
        userId && workspace
          ? `${rightPanelStorageKey(userId, workspace.role.spaceId, botId ? "bot" : "group", threadId)}:recruiting:${roleId}`
          : null;
      setCandidateStorageKey(key);
      const saved = readRecruitingPanelState(key);
      setCandidateList((current) => ({
        ...saved,
        tab: requestedTab.current ?? (changingRole ? current.tab : saved.tab),
      }));
      setCandidatePage(null);
      setSelection(null);
      candidateHandoff.current = null;
      setSelectedEvidence(null);
      shortlistMutation.current = null;
      setShortlistPending(null);
      setShortlistFailed(null);
    };
    const onReadError = (error: unknown): never => {
      if (!cancelled && epoch === readEpoch.current) denyAccess(error);
      throw error;
    };
    const abort = new AbortController();
    /** Retries a deploy's or an edge's transient failure before reporting it. */
    const read = <T>(call: () => Promise<T>) =>
      retryTransientRead(call, abort.signal).catch(onReadError);
    async function load() {
      try {
        let workspace = await read(() => rpc.recruiting.getWorkspace({ threadId }));
        while (!cancelled && epoch === readEpoch.current) {
          updateEditScope(workspace);
          setSnapshot((current) =>
            current?.workspace?.role.id !== workspace?.role.id ||
            current?.workspace?.revision.id !== workspace?.revision.id
              ? null
              : current,
          );
          setWorkspaceSnapshot((current) =>
            current && JSON.stringify(current.workspace) === JSON.stringify(workspace)
              ? current
              : { workspace },
          );
          rememberRecruitingRead(readCache, workspaceCacheKey, { workspace }, cacheEpoch);
          setValidatedWorkspaceRead(workspaceReadKey);
          if (summary) return;
          const roleId = workspace?.role.id;
          const [assessments, research, questions, documents] = await Promise.all([
            roleId && !candidateWorkspace
              ? read(() => rpc.recruiting.listAssessments({ roleId }))
              : Promise.resolve([]),
            roleId
              ? read(() => rpc.recruiting.listResearch({ roleId }))
              : Promise.resolve({ tasks: [], actions: [], observations: [] }),
            roleId && !candidateWorkspace
              ? read(() => rpc.recruiting.listQuestions({ threadId, roleId }))
              : Promise.resolve({ questions: [] }),
            candidateWorkspace
              ? Promise.resolve([])
              : Promise.all([
                  read(() => rpc.memory.list({ scope: "user" })),
                  ...(botId ? [read(() => rpc.memory.list({ scope: "bot", botId }))] : []),
                ]).then((lists) => lists.flat()),
          ]);
          if (cancelled || epoch !== readEpoch.current) return;
          const verified = await read(() => rpc.recruiting.getWorkspace({ threadId }));
          if (cancelled || epoch !== readEpoch.current) return;
          if (
            workspace?.role.id !== verified?.role.id ||
            workspace?.revision.id !== verified?.revision.id
          ) {
            workspace = verified;
            continue;
          }
          setSnapshot({
            workspace,
            assessments,
            research,
            questions: questions.questions,
            documents,
          });
          return;
        }
      } catch {
        if (!cancelled) setFailed(true);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    void load();
    return () => {
      cancelled = true;
      abort.abort();
    };
  }, [
    userId,
    threadId,
    botId,
    refresh,
    refreshSignal,
    denyAccess,
    summary,
    candidateWorkspace,
    readCache,
    workspaceCacheKey,
    workspaceReadKey,
  ]);
  const workspace = workspaceSnapshot?.workspace;
  const criteria = workspace?.revision.criteria ?? [];
  const brief = workspace?.revision.brief;
  const briefClarifications = brief ? recruitingBriefClarifications(brief) : [];
  const briefFieldLabels: Record<string, string> = {
    salary_range: t`Salary range`,
    location: t`Location`,
    company_deck: t`Company deck`,
  };
  const unphrasedBriefFields = (brief?.fields ?? []).filter(
    (field) =>
      briefClarifications.some(({ fieldKey }) => fieldKey === field.key) &&
      !Object.hasOwn(briefFieldLabels, field.key) &&
      !brief?.questions.some(
        (question) => question.fieldKey === field.key && !question.answeredBySourceRefId,
      ),
  );
  const roleQuestions = [
    ...new Set([
      ...briefClarifications.flatMap(({ fieldKey, question }) => {
        const saved = brief?.questions.find(
          (item) => item.fieldKey === fieldKey && !item.answeredBySourceRefId,
        );
        if (saved) return [saved.question];
        if (fieldKey === "salary_range") return [t`What salary range may be stated in outreach?`];
        if (fieldKey === "location") return [t`What location or remote work scope applies?`];
        if (fieldKey === "company_deck") return [t`Is a company deck available?`];
        // ponytail: arbitrary keys have no display label; only saved prose identifies the question.
        return showDiagnostics ? [question] : [];
      }),
      ...(workspace?.revision.definitionQuestions ?? []),
      ...criteria.flatMap((criterion) => criterion.definitionQuestions),
    ]),
  ];
  const roleSources = [
    ...new Map(
      [
        ...(workspace?.revision.sourceRefs ?? []),
        ...criteria.flatMap((criterion) => criterion.sourceRefs),
      ].map((source) => [source.id, source]),
    ).values(),
  ];
  const assessments = snapshot?.assessments ?? [];
  const showInternalAssessments =
    showDiagnostics ||
    assessments.length > 0 ||
    (candidateWorkspace &&
      ((candidatePage?.counts.assessed ?? 0) > 0 ||
        candidateFilters.assessmentState !== undefined ||
        candidateFilters.verdict !== undefined));
  const retainInternalAssessmentFilters =
    candidateWorkspace || showInternalAssessments || !snapshot;
  const candidateRequestFilters = useMemo(() => {
    if (
      retainInternalAssessmentFilters ||
      (candidateFilters.assessmentState === undefined && candidateFilters.verdict === undefined)
    )
      return candidateFilters;
    const { assessmentState: _, verdict: __, ...filters } = candidateFilters;
    return filters;
  }, [candidateFilters, retainInternalAssessmentFilters]);
  const selectedKey =
    selection && selection.roleId === workspace?.role.id
      ? JSON.stringify([
          selection.roleId,
          selection.candidateKey,
          selection.latestAssessment?.version,
        ])
      : null;
  const selected = selectedEvidence?.key === selectedKey ? selectedEvidence.value : null;
  const assessment = selected?.assessment;
  const roleId = workspace?.role.id;
  const roleRevisionId = workspace?.revision.id;
  const candidateQueryKey = JSON.stringify([
    userId,
    threadId,
    roleId,
    roleRevisionId,
    candidateRequestFilters,
  ]);
  const candidateFresh =
    !candidateLoading &&
    !candidateFailed &&
    validatedWorkspaceRead === workspaceReadKey &&
    candidateValidatedRead.current === `${workspaceReadKey}:${candidateQueryKey}` &&
    (!readCache || candidateValidation.current === readCache.epoch);
  const candidatesCacheKey =
    readCacheScope && roleId && roleRevisionId
      ? `${readCacheScope}:candidates:${JSON.stringify([roleId, roleRevisionId, candidateRequestFilters])}`
      : undefined;
  useEffect(() => {
    const list = tabsList.current;
    const selectedTab = list?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]');
    if (!list || !selectedTab) return;
    const listBounds = list.getBoundingClientRect();
    const tabBounds = selectedTab.getBoundingClientRect();
    const left =
      tabBounds.left < listBounds.left
        ? tabBounds.left - listBounds.left
        : Math.max(0, tabBounds.right - listBounds.right);
    if (left) list.scrollBy({ left });
  }, [activeTab, roleId]);
  useEffect(() => {
    if (candidateStorageKey) writeRecruitingPanelState(candidateStorageKey, candidateList);
  }, [candidateStorageKey, candidateList]);
  const showCrm = Boolean(
    candidatePage?.crmTarget || candidatePage?.items.some((item) => item.crm),
  );
  const selectedPageCandidate = candidatePage?.items.find(
    (item) => item.candidateKey === selection?.candidateKey,
  );
  const selectedCrm = selectedPageCandidate?.crm ?? null;
  const selectedCrmTarget = selectedPageCandidate
    ? (selectedCrm?.target ?? candidatePage?.crmTarget?.target)
    : undefined;
  const candidateQuery = useRef({ ...candidateList, roleRevisionId, selection });
  candidateQuery.current = {
    ...candidateList,
    filters: candidateRequestFilters,
    roleRevisionId,
    selection,
  };
  const userSortRef = useRef(candidateList.userSort === true);
  userSortRef.current = candidateList.userSort === true;
  const resetUnavailableCandidateSort = useCallback(
    (page: ListRecruitingCandidatesOutput, filters: RecruitingPanelState["filters"]) => {
      const sort = filters.sort ?? "score";
      // A list that was sorted by a fallback returns to score order once scores exist.
      if (!userSortRef.current && sort !== "score" && page.sortAvailability.score) {
        setCandidatePage(null);
        setCandidateList((current) => ({
          ...current,
          filters: { ...current.filters, sort: "score" },
          pageCount: 1,
        }));
        return true;
      }
      if (
        (sort === "rank" || sort === "tier" || sort === "score") &&
        !page.sortAvailability[sort]
      ) {
        // Keep the provider's ordering when one exists: score, then rank, then tier, then name.
        const fallback =
          (["score", "rank", "tier"] as const).find((key) => page.sortAvailability[key]) ?? "name";
        setCandidatePage(null);
        setCandidateList((current) => ({
          ...current,
          filters: { ...current.filters, sort: fallback },
          pageCount: 1,
        }));
        return true;
      }
      return false;
    },
    [],
  );
  useEffect(() => {
    let cancelled = false;
    const generation = ++candidateGeneration.current;
    const epoch = readEpoch.current;
    const cacheEpoch = readCache?.epoch;
    const isCurrent = () =>
      !cancelled &&
      generation === candidateGeneration.current &&
      epoch === readEpoch.current &&
      (!readCache || cacheEpoch === readCache.epoch);
    loadingMore.current = false;
    setCandidateLoading(!!roleId && validatedWorkspaceRead === workspaceReadKey);
    setCandidateFailed(false);
    const retainCandidatePage = displayedCandidateQuery.current === candidateQueryKey;
    setCandidatePage(
      (current) =>
        (candidatesCacheKey
          ? (readCache?.entries.get(candidatesCacheKey) as
              | ListRecruitingCandidatesOutput
              | undefined)
          : undefined) ?? (retainCandidatePage ? current : null),
    );
    displayedCandidateQuery.current = candidateQueryKey;
    if (!roleId || summary || validatedWorkspaceRead !== workspaceReadKey) return;
    const query = candidateQuery.current;
    const abort = new AbortController();
    candidateReadAbort.current = abort;
    const scope = JSON.stringify([userId, threadId, roleId, roleRevisionId]);
    const queryChanged =
      previousCandidateSearch.current?.scope === scope &&
      previousCandidateSearch.current.query !== candidateRequestFilters.query;
    previousCandidateSearch.current = { scope, query: candidateRequestFilters.query };
    const load = async () => {
      let page = await rpc.recruiting.listCandidates(
        {
          roleId,
          limit: 30,
          ...candidateRequestFilters,
        },
        { signal: abort.signal },
      );
      if (!isCurrent()) return;
      if (page.roleId !== roleId || page.roleRevisionId !== roleRevisionId) {
        setRefresh((value) => value + 1);
        return;
      }
      if (resetUnavailableCandidateSort(page, candidateRequestFilters)) return;
      const verified = await rpc.recruiting.getWorkspace({ threadId });
      if (!isCurrent()) return;
      if (verified?.role.id !== roleId || verified?.revision.id !== roleRevisionId) {
        setRefresh((value) => value + 1);
        return;
      }
      candidateValidation.current = cacheEpoch;
      candidateValidatedRead.current = `${workspaceReadKey}:${candidateQueryKey}`;
      setCandidatePage(page);
      rememberRecruitingRead(
        readCache,
        candidatesCacheKey,
        { ...page, crmTarget: null, items: page.items.map((item) => ({ ...item, crm: null })) },
        cacheEpoch,
      );
      setCandidateList((current) => ({ ...current, pageCount: 1 }));
      let pageCount = 1;
      // ponytail: replay saved page depth with fresh cursors; cached rows are display-only until verified.
      for (let index = 1; index < query.pageCount && page.nextCursor; index++) {
        if (!isCurrent()) return;
        const next = await rpc.recruiting.listCandidates(
          {
            roleId,
            limit: 30,
            ...candidateRequestFilters,
            cursor: page.nextCursor,
          },
          { signal: abort.signal },
        );
        if (!isCurrent()) return;
        if (
          next.roleId !== roleId ||
          next.roleRevisionId !== roleRevisionId ||
          next.crmTarget?.bindingEffectId !== page.crmTarget?.bindingEffectId
        ) {
          setCandidatePage(null);
          setRefresh((value) => value + 1);
          return;
        }
        if (resetUnavailableCandidateSort(next, candidateRequestFilters)) return;
        page = { ...next, items: page.items.concat(next.items) };
        pageCount++;
        setCandidatePage(page);
        rememberRecruitingRead(
          readCache,
          candidatesCacheKey,
          { ...page, crmTarget: null, items: page.items.map((item) => ({ ...item, crm: null })) },
          cacheEpoch,
        );
        setCandidateList((current) => ({ ...current, pageCount }));
      }
      const selectedCandidateKey = candidateQuery.current.selectedCandidateKey;
      const { sourceEffectId, actionId } = candidateRequestFilters;
      const explicitSource = sourceEffectId !== undefined || actionId !== undefined;
      let restored = page.items.find((item) => item.candidateKey === selectedCandidateKey);
      if (
        !restored &&
        selectedCandidateKey &&
        (!candidateQuery.current.selection || explicitSource)
      ) {
        let cursor: string | undefined;
        do {
          const selectedPage = await rpc.recruiting.listCandidates(
            {
              roleId,
              limit: 30,
              query: selectedCandidateKey,
              ...(sourceEffectId !== undefined ? { sourceEffectId } : {}),
              ...(actionId !== undefined ? { actionId } : {}),
              ...(cursor ? { cursor } : {}),
            },
            { signal: abort.signal },
          );
          if (!isCurrent()) return;
          if (selectedPage.roleId !== roleId || selectedPage.roleRevisionId !== roleRevisionId) {
            setRefresh((value) => value + 1);
            return;
          }
          restored = selectedPage.items.find((item) => item.candidateKey === selectedCandidateKey);
          cursor = selectedPage.nextCursor ?? undefined;
        } while (!restored && cursor);
      }
      setSelection((current) =>
        current?.roleId === roleId
          ? (page.items.find((item) => item.candidateKey === current.candidateKey) ??
            (current.candidateKey === selectedCandidateKey
              ? (restored ?? (explicitSource ? null : current))
              : current))
          : (restored ?? null),
      );
    };
    const start = () =>
      void load()
        .catch((error: unknown) => {
          if (
            cancelled ||
            generation !== candidateGeneration.current ||
            epoch !== readEpoch.current
          )
            return;
          denyAccess(error);
          if (generation === candidateGeneration.current && epoch === readEpoch.current)
            setCandidateFailed(true);
        })
        .finally(() => {
          if (
            !cancelled &&
            generation === candidateGeneration.current &&
            epoch === readEpoch.current
          )
            setCandidateLoading(false);
        });
    const timer = queryChanged ? setTimeout(start, 250) : undefined;
    if (timer === undefined) start();
    return () => {
      cancelled = true;
      clearTimeout(timer);
      abort.abort();
    };
  }, [
    roleId,
    roleRevisionId,
    candidateRequestFilters,
    feedbackRefresh,
    workspaceSnapshot,
    threadId,
    denyAccess,
    resetUnavailableCandidateSort,
    summary,
    candidatesCacheKey,
    candidateQueryKey,
    readCache,
    workspaceReadKey,
    validatedWorkspaceRead,
  ]);
  useEffect(() => {
    let cancelled = false;
    const epoch = readEpoch.current;
    setSelectedEvidence(null);
    setEvidenceFailed(false);
    if (!selection || !selectedKey || !selection.latestAssessment) return;
    void rpc.recruiting
      .getAssessment({
        roleId: selection.roleId,
        candidateKey: selection.candidateKey,
        version: selection.latestAssessment.version,
      })
      .then((value) => {
        if (!cancelled && epoch === readEpoch.current)
          setSelectedEvidence({ key: selectedKey, value });
      })
      .catch((error: unknown) => {
        if (!cancelled && epoch === readEpoch.current) {
          denyAccess(error);
          setEvidenceFailed(true);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [selectedKey, snapshot, denyAccess]);
  function selectCandidate(candidate: RecruitingCandidate, trigger: HTMLButtonElement) {
    candidateHandoff.current = null;
    candidateTrigger.current = trigger;
    setSelection(candidate);
    setCandidateList((current) => ({
      ...current,
      selectedCandidateKey: candidate.candidateKey,
      detailOpen: true,
    }));
  }
  function discussCandidate(
    candidate: RecruitingCandidate,
    intent: CandidateDiscussionContext["intent"],
  ) {
    if (
      !workspace ||
      !onDiscussCandidate ||
      !candidateFresh ||
      (readCache && candidateValidation.current !== readCache.epoch)
    )
      return;
    onDiscussCandidate({
      threadId,
      roleTitle: workspace.role.title,
      roleId: workspace.role.id,
      roleRevisionId: workspace.revision.id,
      roleVersion: workspace.revision.revision,
      candidateKey: candidate.candidateKey,
      name: candidate.name,
      title: candidate.title,
      company: candidate.company,
      linkedinUrl: candidate.linkedinUrl,
      resumeUrl: candidate.resumeUrl,
      intent,
    });
  }
  const revealCandidateMessage: Props["onRevealMessage"] = onRevealMessage
    ? (target) => {
        candidateHandoff.current = () => onRevealMessage(target);
        setCandidateDetailOpen(false);
      }
    : undefined;
  async function loadMoreCandidates() {
    if (!candidatePage?.nextCursor || !roleId || loadingMore.current) return;
    const generation = candidateGeneration.current;
    const epoch = readEpoch.current;
    const signal = candidateReadAbort.current?.signal;
    loadingMore.current = true;
    setCandidateLoading(true);
    setCandidateFailed(false);
    try {
      const page = await rpc.recruiting.listCandidates(
        {
          roleId,
          limit: 30,
          ...candidateRequestFilters,
          cursor: candidatePage.nextCursor,
        },
        { signal },
      );
      if (
        signal?.aborted ||
        generation !== candidateGeneration.current ||
        epoch !== readEpoch.current
      )
        return;
      if (
        page.roleId !== roleId ||
        page.roleRevisionId !== roleRevisionId ||
        page.crmTarget?.bindingEffectId !== candidatePage.crmTarget?.bindingEffectId
      ) {
        setCandidatePage(null);
        setRefresh((value) => value + 1);
        return;
      }
      if (resetUnavailableCandidateSort(page, candidateRequestFilters)) return;
      setCandidatePage((current) =>
        current ? { ...page, items: current.items.concat(page.items) } : page,
      );
      setCandidateList((current) => ({ ...current, pageCount: current.pageCount + 1 }));
    } catch (error) {
      if (
        !signal?.aborted &&
        generation === candidateGeneration.current &&
        epoch === readEpoch.current
      ) {
        denyAccess(error);
        setCandidateFailed(true);
      }
    } finally {
      if (
        !signal?.aborted &&
        generation === candidateGeneration.current &&
        epoch === readEpoch.current
      ) {
        loadingMore.current = false;
        setCandidateLoading(false);
      }
    }
  }
  async function setShortlist(candidate: RecruitingCandidate, shortlisted: boolean) {
    if (
      shortlistMutation.current ||
      !candidateFresh ||
      (readCache && candidateValidation.current !== readCache.epoch)
    )
      return;
    const mutation = {};
    shortlistMutation.current = mutation;
    const roleGeneration = editScope.current.generation;
    const epoch = readEpoch.current;
    const isCurrent = () =>
      shortlistMutation.current === mutation &&
      editScope.current.active &&
      editScope.current.generation === roleGeneration &&
      editScope.current.roleId === candidate.roleId &&
      epoch === readEpoch.current;
    setShortlistPending(candidate.candidateKey);
    setShortlistFailed(null);
    try {
      const saved = await rpc.recruiting.setCandidateShortlist({
        threadId,
        roleId: candidate.roleId,
        candidateKey: candidate.candidateKey,
        expectedRevision: candidate.revision,
        shortlisted,
      });
      if (!isCurrent()) return;
      if (
        saved.roleId !== candidate.roleId ||
        saved.candidateKey !== candidate.candidateKey ||
        saved.shortlisted !== shortlisted
      )
        throw new Error("Shortlist receipt does not match the submitted candidate");
      clearRecruitingReads(readCache, readCacheScope);
      setCandidatePage((current) =>
        current
          ? {
              ...current,
              items: current.items.map((item) =>
                item.candidateKey === saved.candidateKey ? { ...item, ...saved } : item,
              ),
            }
          : current,
      );
      setSelection((current) =>
        current?.candidateKey === saved.candidateKey ? { ...current, ...saved } : current,
      );
      // Reuse the role-verified loader for authoritative counts after this saved change.
      setRefresh((value) => value + 1);
    } catch (error) {
      if (isCurrent()) {
        denyAccess(error);
        setShortlistFailed(candidate.candidateKey);
      }
    } finally {
      if (isCurrent()) {
        shortlistMutation.current = null;
        setShortlistPending(null);
      }
    }
  }
  const normalizedCriteria =
    criteriaEdit?.criteria.map((criterion) => ({
      ...criterion,
      atoms: criterion.atoms.map((atom) =>
        "employmentRule" in atom
          ? {
              ...atom,
              employmentRule: {
                ...atom.employmentRule,
                qualificationDefinition: atom.employmentRule.qualificationDefinition.trim(),
              },
            }
          : { ...atom, statement: atom.statement.trim() },
      ),
    })) ?? [];
  const originalCriteria = criteriaEdit ? criteriaDraft(criteriaEdit.revision) : [];
  const criteriaChanges = normalizedCriteria.filter(
    (criterion, index) =>
      JSON.stringify(criteriaEdit?.criteria[index]) !== JSON.stringify(originalCriteria[index]) &&
      JSON.stringify(criterion) !== JSON.stringify(originalCriteria[index]),
  );
  const searchFiltersChanged = Boolean(
    criteriaEdit &&
      JSON.stringify(criteriaEdit.searchFilters) !==
        JSON.stringify(searchFilterDraft(criteriaEdit.revision)),
  );
  const invalidSearchFilters =
    criteriaEdit?.searchFilters.some((filter) => !filter.statement.trim()) ?? false;
  const invalidCriteria = normalizedCriteria.some((criterion) =>
    criterion.atoms.some((atom) =>
      "employmentRule" in atom
        ? !RecruitingEmploymentRuleSchema.safeParse(atom.employmentRule).success
        : !atom.statement,
    ),
  );
  async function saveCriteria() {
    if (
      loading ||
      failed ||
      !criteriaEdit ||
      savingCriteria ||
      invalidCriteria ||
      invalidSearchFilters ||
      (!criteriaChanges.length && !searchFiltersChanged)
    )
      return;
    const submitted = criteriaEdit;
    const generation = editScope.current.generation;
    const isCurrent = () =>
      editScope.current.active &&
      editScope.current.generation === generation &&
      editScope.current.roleId === submitted.roleId;
    setSavingCriteria(true);
    setCriteriaFailed(false);
    try {
      const saved = await rpc.recruiting.editCriteria({
        threadId,
        roleId: submitted.roleId,
        expectedRevision: submitted.revision.revision,
        criteria: criteriaChanges.length ? criteriaChanges : originalCriteria,
        ...(searchFiltersChanged ? { searchFilters: submitted.searchFilters } : {}),
      });
      if (!isCurrent()) return;
      setCriteriaEdit((current) =>
        current === submitted ? null : current ? { ...current, revision: saved.revision } : null,
      );
      setRefresh((value) => value + 1);
    } catch {
      if (isCurrent()) setCriteriaFailed(true);
    } finally {
      if (isCurrent()) setSavingCriteria(false);
    }
  }
  return {
    shortlistWeekFilter,
    onClearShortlistWeekFilter,
    threadId,
    botId,
    groupId,
    readCache,
    readCacheScope,
    refreshSignal,
    onClose,
    onBrowseCandidates,
    onRevealMessage,
    onDiscussCandidate,
    onCandidateFeedback,
    candidateFeedbackRecipients,
    showDiagnostics,
    presentation,
    summary,
    view,
    tab,
    onTabChange,
    t,
    shortlistFilterId,
    snapshot,
    workspaceSnapshot,
    refresh,
    setRefresh,
    feedbackRefresh,
    setFeedbackRefresh,
    loading,
    failed,
    confirming,
    setConfirming,
    confirmationFailed,
    setConfirmationFailed,
    setCandidateList,
    activeTab,
    contactsView,
    shortlistView,
    tabsList,
    candidateDetailOpen,
    candidateView,
    filteredShortlistWeek,
    candidateFilters,
    candidateTableDetails,
    selection,
    candidateTrigger,
    candidateClose,
    candidateHandoff,
    candidatePage,
    arrival,
    setCandidateFilters,
    setCandidateDetailOpen,
    candidateLoading,
    candidateFailed,
    shortlistPending,
    shortlistFailed,
    selectedEvidence,
    evidenceFailed,
    candidateValidation,
    denyAccess,
    criteriaEdit,
    setCriteriaEdit,
    savingCriteria,
    criteriaFailed,
    setCriteriaFailed,
    workspace,
    criteria,
    brief,
    briefClarifications,
    briefFieldLabels,
    unphrasedBriefFields,
    roleQuestions,
    roleSources,
    assessments,
    showInternalAssessments,
    selectedKey,
    selected,
    assessment,
    roleId,
    roleRevisionId,
    candidateFresh,
    showCrm,
    selectedCrm,
    selectedCrmTarget,
    selectCandidate,
    discussCandidate,
    revealCandidateMessage,
    loadMoreCandidates,
    setShortlist,
    criteriaChanges,
    searchFiltersChanged,
    invalidSearchFilters,
    invalidCriteria,
    saveCriteria,
  };
}
