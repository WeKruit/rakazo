import {
  CandidateAssessment,
  CandidateContactFields,
  CandidateCounts,
  CandidateCriteria,
  CandidateDecision,
  CandidateProfile,
  CandidateResearchMatch,
  CandidateSourceRound,
  CONTACT_STATUS_LABELS,
  CrmDetails,
  CrmStatus,
  ResearchActionStatus,
  SourcingCandidateCard,
} from "./recruiting/CandidatePresentation";
import type { CriteriaEdit } from "./recruiting/CriteriaEditor";
import {
  CriteriaExpression,
  CriteriaExpressionFields,
  criteriaDraft,
  EmploymentRuleSummary,
  expressionAtoms,
  searchFilterDraft,
} from "./recruiting/CriteriaEditor";
import { CrmRecruitingPanel } from "./recruiting/CrmWorkbench";
import {
  ArtifactReference,
  CandidateSources,
  MemoryDocumentView,
  ResearchResults,
  Sources,
} from "./recruiting/SourceDocuments";
import { VerdictLabel } from "./recruiting/VerdictLabel";
import type { CandidateDiscussionContext, Props, Snapshot } from "./recruiting/workspace-types";

export type {
  CandidateDiscussionContext,
  CandidateFeedback,
  CrmBrowseSelection,
  CrmReplyDraftContext,
} from "./recruiting/workspace-types";

import { Plural, Trans, useLingui } from "@lingui/react/macro";
import { ORPCError } from "@orpc/client";
import type {
  ListRecruitingCandidatesInput,
  ListRecruitingCandidatesOutput,
  RecruitingCandidate,
  Verdict,
} from "@rakazo/contracts";
import { RecruitingEmploymentRuleSchema } from "@rakazo/contracts";
import { recruitingBriefClarifications } from "@rakazo/core";
import {
  Button,
  Card,
  CardContent,
  Checkbox,
  Dialog,
  DialogClose,
  DialogContent,
  DialogTitle,
  Input,
  NativeSelect,
  NativeSelectOption,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  Textarea,
} from "@rakazo/ui-web";
import { BriefcaseBusiness, Building2, Check, LayoutGrid, List, RefreshCw, X } from "lucide-react";
import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { AskCard } from "../components/AskCard";
import { authClient } from "../lib/auth";
import { retryTransientRead } from "../lib/read-retry";
import { clearRecruitingReads, rememberRecruitingRead } from "../lib/recruiting-read-cache";
import type { RecruitingPanelState } from "../lib/right-panel-state";
import {
  readRecruitingPanelState,
  rightPanelStorageKey,
  writeRecruitingPanelState,
} from "../lib/right-panel-state";
import { rpc } from "../lib/rpc";
import { CandidateFeedbackForm, FeedbackHistory } from "./recruiting/CandidateFeedback";
import { ContactsTab } from "./recruiting/LazyViews";
import { RetryNotice } from "./recruiting/RetryNotice";
import { TabLoading, useArrivals } from "./recruiting/shared";

// Reset all fetched records when navigation changes the source thread, even before its reads finish.
export function RecruitingPanel(props: Props) {
  return props.crmBrowse ? (
    <CrmRecruitingPanel
      key={JSON.stringify([props.readCacheScope, props.threadId, props.crmBrowse.selection])}
      {...props}
      browse={props.crmBrowse}
      agent={props.roleConversation ? <RoleAgentSection {...props} /> : undefined}
    />
  ) : (
    <NativeRecruitingPanel {...props} />
  );
}

/**
 * The role conversation's own saved results for the current workbench tab. A CRM role and an
 * agent-created role share one workbench: CRM records render below this section when linked.
 */
function RoleAgentSection({ crmBrowse, roleConversation: _, correspondence, ...props }: Props) {
  const view = crmBrowse?.view;
  if (view === "brief" || view === "feedback")
    return <NativeRecruitingPanel {...props} presentation="workspace" summary={view} />;
  if (view === "sequence" || view === "inbox" || view === "interview") return <>{correspondence}</>;
  if (view === "conversation") return null;
  return (
    <NativeRecruitingPanel
      {...props}
      presentation="workspace"
      // Search results and CRM contacts are one list.
      view={view === "shortlist" ? view : view === "workflow" ? "results" : "contacts"}
      tab={view === "workflow" ? "dashboard" : "evidence"}
    />
  );
}

function NativeRecruitingPanel(props: Props) {
  const userId = authClient.useSession().data?.user.id;
  return (
    <RecruitingWorkspace
      key={`${userId}:${props.threadId}:${props.botId ?? "group"}`}
      {...props}
      userId={userId}
    />
  );
}

function RecruitingWorkspace({
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
    const read = <T,>(call: () => Promise<T>) =>
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
  if (summary) {
    const CriteriaBody = summary === "feedback" ? "details" : "div";
    return (
      <section
        className="hire-live-criteria"
        data-summary={summary}
        aria-label={summary === "brief" ? t`Search Criteria` : t`Client feedback`}
      >
        <div className="hire-panel-heading">
          {summary === "brief" ? (
            <BriefcaseBusiness size={18} aria-hidden />
          ) : (
            <Building2 size={18} aria-hidden />
          )}
          <div>
            <strong>
              {summary === "brief" ? (
                <Trans>Search Criteria</Trans>
              ) : (
                <Trans>Saved role summary</Trans>
              )}
            </strong>
            <span>
              {summary === "brief" ? (
                <Trans>From this role’s saved requirements</Trans>
              ) : (
                <Trans>Saved feedback for this role</Trans>
              )}
            </span>
          </div>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={summary === "brief" ? t`Refresh criteria` : t`Refresh`}
            disabled={loading}
            onClick={() => setRefresh((value) => value + 1)}
          >
            <RefreshCw size={15} aria-hidden />
          </Button>
        </div>
        {failed ? (
          <p role="alert" className="hire-source-hint">
            <Trans>Could not load recruiting. Refresh to try again.</Trans>
          </p>
        ) : loading && !workspaceSnapshot ? (
          <p role="status" className="hire-source-hint">
            <Trans>Loading…</Trans>
          </p>
        ) : workspace ? (
          <>
            {summary === "brief" ? (
              <div className="hire-jd-summary">
                <strong>{workspace.role.title}</strong>
              </div>
            ) : null}
            {summary === "feedback" ? (
              <FeedbackHistory
                key={workspace.role.id}
                roleId={workspace.role.id}
                refreshSignal={(refreshSignal ?? 0) + refresh}
                readCache={readCache}
                readCacheScope={readCacheScope}
                onAccessError={denyAccess}
                showEmpty
              />
            ) : null}
            <CriteriaBody className={summary === "feedback" ? "hire-criterion-row" : "contents"}>
              {summary === "feedback" ? (
                <>
                  <summary>
                    <Trans>Search Criteria</Trans>
                  </summary>
                  <div className="hire-criterion-row">
                    <strong>{workspace.role.title}</strong>
                  </div>
                </>
              ) : null}
              {brief?.fields
                .filter((field) => field.value !== null)
                .map((field) => (
                  <div className="hire-criterion-row" key={field.key}>
                    {Object.hasOwn(briefFieldLabels, field.key) ? (
                      <span>{briefFieldLabels[field.key]}</span>
                    ) : null}
                    <strong className="whitespace-pre-wrap">{field.value}</strong>
                    {field.state === "conflict" ? (
                      <span>
                        <Trans>Conflicting information</Trans>
                      </span>
                    ) : field.state !== "known" ? (
                      <span>
                        <Trans>Unknown</Trans>
                      </span>
                    ) : null}
                    {field.origin === "inferred" ? (
                      <span>
                        <Trans>Assumption</Trans>
                      </span>
                    ) : null}
                  </div>
                ))}
              {brief?.searchFilters.map((filter) => (
                <div className="hire-criterion-row" key={filter.id}>
                  <span>
                    {filter.mode === "include" ? (
                      <Trans>Include</Trans>
                    ) : filter.mode === "exclude" ? (
                      <Trans>Exclude</Trans>
                    ) : (
                      <Trans>Prefer</Trans>
                    )}
                  </span>
                  <strong>{filter.statement}</strong>
                </div>
              ))}
              {criteria.map((criterion) => (
                <div className="hire-criterion-row" key={criterion.id}>
                  <span>
                    {criterion.priority === "hard" ? (
                      <Trans>Required</Trans>
                    ) : (
                      <Trans>Preferred</Trans>
                    )}
                  </span>
                  <CriteriaExpression expression={criterion.expression} />
                </div>
              ))}
              {workspace.revision.preferences.length ? (
                <div className="hire-criterion-row">
                  <span>
                    <Trans>Preferences</Trans>
                  </span>
                  <ul>
                    {workspace.revision.preferences.map((preference) => (
                      <li key={preference}>{preference}</li>
                    ))}
                  </ul>
                </div>
              ) : null}
              {!brief?.fields.some((field) => field.value !== null) &&
              !brief?.searchFilters.length &&
              !criteria.length &&
              !workspace.revision.preferences.length ? (
                <p className="hire-source-hint">
                  <Trans>
                    Share the role requirements in the conversation to build this brief.
                  </Trans>
                </p>
              ) : null}
              {roleSources.length ? (
                <details className="hire-criterion-row">
                  <summary>
                    <Trans>Role sources</Trans>
                  </summary>
                  <Sources
                    sourceTarget={{ kind: "role", threadId, roleRevisionId: workspace.revision.id }}
                    sources={roleSources}
                    showDiagnostics={false}
                  />
                </details>
              ) : null}
            </CriteriaBody>
            <p className="hire-source-hint">
              <Check size={15} aria-hidden />
              <Trans>Requirements and feedback stay with this role.</Trans>
            </p>
          </>
        ) : (
          <p className="hire-source-hint">
            <Trans>No role linked yet. Describe the role in this conversation.</Trans>
          </p>
        )}
      </section>
    );
  }
  return (
    <section
      aria-label={t`Recruiting`}
      className={
        presentation === "workspace"
          ? "hire-recruiting-workspace space-y-4 text-sm"
          : "space-y-4 text-sm"
      }
    >
      {shortlistView || contactsView ? (
        <header className="hire-section-header">
          <h1>{shortlistView ? <Trans>Shortlist</Trans> : <Trans>Contacts</Trans>}</h1>
          {workspace ? <p>{workspace.role.title}</p> : null}
          {candidatePage ? (
            <p>
              <Plural
                value={candidatePage.counts.candidates}
                _1="# candidate in the pool"
                other="# candidates in the pool"
              />
            </p>
          ) : null}
        </header>
      ) : null}
      {presentation !== "workspace" ? (
        <div className="flex items-center justify-between gap-2">
          <h2 className="text-base font-medium">
            <Trans>Recruiting</Trans>
          </h2>
          <div className="flex gap-1">
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={t`Refresh`}
              disabled={candidateLoading || (loading && !workspaceSnapshot)}
              onClick={() => setRefresh((value) => value + 1)}
            >
              <RefreshCw size={16} aria-hidden />
            </Button>
            <Button variant="ghost" size="icon-sm" aria-label={t`Close panel`} onClick={onClose}>
              <X size={16} aria-hidden />
            </Button>
          </div>
        </div>
      ) : null}
      {failed ? (
        <RetryNotice onRetry={() => setRefresh((value) => value + 1)}>
          <Trans>Could not load recruiting</Trans>
        </RetryNotice>
      ) : loading &&
        (!workspaceSnapshot ||
          ["dashboard", "missing", "memory", "activity"].includes(activeTab)) ? (
        <TabLoading />
      ) : null}
      {workspaceSnapshot ? (
        <Tabs
          value={activeTab}
          onValueChange={(value) => {
            const tab = value as RecruitingPanelState["tab"];
            setCandidateList((current) => ({ ...current, tab }));
            onTabChange?.(tab);
          }}
          className="gap-4"
        >
          {presentation !== "workspace" ? (
            <TabsList
              ref={tabsList}
              variant="line"
              aria-label={t`Recruiting views`}
              className="no-scrollbar w-full overflow-x-auto justify-start"
            >
              <TabsTrigger value="role">
                <Trans>Role</Trans>
              </TabsTrigger>
              <TabsTrigger value="dashboard">
                <Trans>Dashboard</Trans>
              </TabsTrigger>
              <TabsTrigger value="evidence">
                <Trans>Evidence</Trans>
              </TabsTrigger>
              <TabsTrigger value="missing">
                <Trans>Missing info</Trans>
              </TabsTrigger>
              <TabsTrigger value="memory">
                <Trans>Memory</Trans>
              </TabsTrigger>
              <TabsTrigger value="activity">
                <Trans>Activity</Trans>
              </TabsTrigger>
            </TabsList>
          ) : null}
          <TabsContent value="dashboard" className="space-y-4">
            {workspace ? <h3 className="font-medium">{workspace.role.title}</h3> : null}
            {candidateFailed ? (
              <p role="alert">
                <Trans>Could not load candidates</Trans>
              </p>
            ) : candidatePage ? (
              <CandidateCounts counts={candidatePage.counts} />
            ) : candidateLoading ? (
              <p role="status">
                <Trans>Loading…</Trans>
              </p>
            ) : null}
            <h3 className="font-medium">
              <Trans>Research history</Trans>
            </h3>
            {snapshot &&
            !snapshot.research.tasks.length &&
            !snapshot.research.observations.length ? (
              <p className="text-muted-foreground">
                <Trans>No saved research</Trans>
              </p>
            ) : (
              snapshot?.research.tasks.map((task, index) => (
                <div key={task.id} className="space-y-2 border-s border-border ps-3">
                  <p>
                    {showDiagnostics ? task.id : <Trans>Search {index + 1}</Trans>} · {task.state}
                  </p>
                  {snapshot?.research.actions
                    .filter((action) => action.taskId === task.id)
                    .map((action) => (
                      <div key={action.id} className="space-y-1">
                        <p>
                          {showDiagnostics ? (
                            <>
                              {action.kind} · {action.deliveryState}
                              {action.observedProviderState
                                ? ` · ${action.observedProviderState}`
                                : ""}
                            </>
                          ) : (
                            <ResearchActionStatus action={action} />
                          )}
                        </p>
                        {showDiagnostics ? (
                          <details>
                            <summary className="cursor-pointer text-muted-foreground">
                              <Trans>Details</Trans>
                            </summary>
                            <p className="break-all text-xs">
                              {action.id} · {action.roleRevisionId}
                            </p>
                            {action.receiptArtifact ? (
                              <ArtifactReference
                                reference={action.receiptArtifact}
                                label={t`Receipt`}
                                showDiagnostics
                              />
                            ) : null}
                          </details>
                        ) : null}
                      </div>
                    ))}
                </div>
              ))
            )}
            {snapshot?.research.observations.length ? (
              <ul aria-label={t`Saved research results`} className="space-y-3">
                {snapshot?.research.observations.map((observation) => (
                  <li key={observation.effectId} className="space-y-1 border-s border-border ps-3">
                    <p>
                      {observation.rowCount === null ? (
                        <Trans>Saved results</Trans>
                      ) : (
                        <Trans>{observation.rowCount} saved source rows</Trans>
                      )}
                      {" · "}
                      <time dateTime={observation.observedAt}>
                        {new Date(observation.observedAt).toLocaleString(undefined, {
                          timeZone: "America/Los_Angeles",
                          timeZoneName: "short",
                        })}
                      </time>
                    </p>
                    {showDiagnostics ? (
                      <ArtifactReference
                        reference={observation.artifactRef}
                        label={t`Source Artifact`}
                        showDiagnostics
                      />
                    ) : null}
                    {showDiagnostics ? (
                      <details>
                        <summary className="cursor-pointer text-muted-foreground">
                          <Trans>Details</Trans>
                        </summary>
                        <dl className="break-all text-xs">
                          <dt>
                            <Trans>Provider task</Trans>
                          </dt>
                          <dd>{observation.providerTaskId}</dd>
                          <dt>
                            <Trans>Run</Trans>
                          </dt>
                          <dd>{observation.runId}</dd>
                          <dt>
                            <Trans>Role revision</Trans>
                          </dt>
                          <dd>{observation.roleRevisionId}</dd>
                        </dl>
                      </details>
                    ) : null}
                  </li>
                ))}
              </ul>
            ) : null}
          </TabsContent>
          <TabsContent key={workspace?.role.id} value="role" className="space-y-5">
            {workspace ? (
              <>
                {candidatePage ? <CandidateCounts counts={candidatePage.counts} /> : null}
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <h3 className="font-medium" dir="auto">
                      {workspace.role.title}
                    </h3>
                    <p className="text-xs text-muted-foreground">
                      <Trans>Version {workspace.revision.revision}</Trans>
                    </p>
                  </div>
                  {!criteriaEdit && criteria.length ? (
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => {
                        setCriteriaFailed(false);
                        setCriteriaEdit({
                          roleId: workspace.role.id,
                          revision: workspace.revision,
                          criteria: criteriaDraft(workspace.revision),
                          searchFilters: searchFilterDraft(workspace.revision),
                        });
                      }}
                    >
                      <Trans>Edit criteria</Trans>
                    </Button>
                  ) : null}
                </div>
                {workspace.revision.brief ? (
                  <div className="space-y-2">
                    <ul className="space-y-3 text-base leading-relaxed">
                      {workspace.revision.brief.fields
                        .filter((field) => field.value !== null)
                        .map((field) => (
                          <li key={field.key} className="space-y-1">
                            {Object.hasOwn(briefFieldLabels, field.key) ? (
                              <p className="text-xs text-muted-foreground">
                                {briefFieldLabels[field.key]}
                              </p>
                            ) : null}
                            <p className="whitespace-pre-wrap">{field.value}</p>
                            {field.state !== "known" ? (
                              <p className="text-xs text-muted-foreground">
                                {field.state === "conflict" ? (
                                  <Trans>Conflicting information</Trans>
                                ) : (
                                  <Trans>Unknown</Trans>
                                )}
                              </p>
                            ) : null}
                            {field.origin === "inferred" ? (
                              <p className="text-xs text-muted-foreground">
                                <Trans>Assumption</Trans>
                              </p>
                            ) : null}
                            <details>
                              <summary className="cursor-pointer text-xs text-muted-foreground">
                                <Trans>Sources</Trans>
                              </summary>
                              <div className="mt-2 space-y-2 text-sm">
                                {showDiagnostics ? <p>{field.key}</p> : null}
                                <p>
                                  {field.origin === "user_instruction" ? (
                                    <Trans>User instruction</Trans>
                                  ) : field.origin === "jd" ? (
                                    <Trans>JD</Trans>
                                  ) : field.origin === "hm" ? (
                                    <Trans>Hiring manager</Trans>
                                  ) : (
                                    <Trans>Assumption</Trans>
                                  )}
                                </p>
                                <Sources
                                  sourceTarget={{
                                    kind: "role",
                                    threadId,
                                    roleRevisionId: workspace.revision.id,
                                  }}
                                  showDiagnostics={showDiagnostics}
                                  sources={roleSources.filter((source) =>
                                    field.sourceRefIds.includes(source.id),
                                  )}
                                />
                              </div>
                            </details>
                          </li>
                        ))}
                    </ul>
                    {showDiagnostics &&
                    workspace.revision.brief.fields.some((field) => field.value === null) ? (
                      <details>
                        <summary className="cursor-pointer text-xs text-muted-foreground">
                          <Trans>Details</Trans>
                        </summary>
                        <dl>
                          {workspace.revision.brief.fields
                            .filter((field) => field.value === null)
                            .map((field) => (
                              <div key={field.key}>
                                <dt>{field.key}</dt>
                                <dd>
                                  {field.state} · {field.origin}
                                </dd>
                              </div>
                            ))}
                        </dl>
                      </details>
                    ) : null}
                    {workspace.revision.brief.confirmation?.revision !==
                      workspace.revision.revision &&
                      roleQuestions.map((question) => (
                        <p key={question} className="text-sm text-muted-foreground">
                          {question}
                        </p>
                      ))}
                    {workspace.revision.brief.confirmation?.revision ===
                    workspace.revision.revision ? (
                      <p>
                        <Trans>Brief confirmed</Trans>
                      </p>
                    ) : (
                      <Button
                        disabled={
                          loading ||
                          failed ||
                          confirming ||
                          briefClarifications.length > 0 ||
                          workspace.revision.criteria.some(
                            (criterion) =>
                              criterion.priority === "hard" &&
                              criterion.definitionQuestions.length > 0,
                          )
                        }
                        onClick={async () => {
                          setConfirming(true);
                          setConfirmationFailed(false);
                          try {
                            await rpc.recruiting.confirmBrief({
                              threadId,
                              roleId: workspace.role.id,
                              expectedRevision: workspace.revision.revision,
                            });
                            setRefresh((value) => value + 1);
                          } catch {
                            setConfirmationFailed(true);
                          } finally {
                            setConfirming(false);
                          }
                        }}
                      >
                        <Trans>Confirm brief</Trans>
                      </Button>
                    )}
                    {confirmationFailed ? (
                      <p role="alert">
                        <Trans>
                          Brief changed or could not be confirmed. Refresh and review it.
                        </Trans>
                      </p>
                    ) : null}
                  </div>
                ) : null}
                {workspace.revision.brief ? (
                  <section aria-label={t`Search filters`} className="space-y-3">
                    <div className="flex items-center justify-between gap-2">
                      <h4 className="font-medium">
                        <Trans>Search filters</Trans>
                      </h4>
                      {!criteriaEdit ? (
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => {
                            setCriteriaFailed(false);
                            setCriteriaEdit({
                              roleId: workspace.role.id,
                              revision: workspace.revision,
                              criteria: criteriaDraft(workspace.revision),
                              searchFilters: searchFilterDraft(workspace.revision),
                            });
                          }}
                        >
                          <Trans>Edit search filters</Trans>
                        </Button>
                      ) : null}
                    </div>
                    <p className="text-xs text-muted-foreground">
                      <Trans>Guide retrieval; qualification criteria stay unchanged.</Trans>
                    </p>
                    {criteriaEdit?.roleId === workspace.role.id ? (
                      <>
                        {criteriaEdit.searchFilters.map((filter, index) => (
                          <fieldset key={filter.id} className="space-y-2">
                            <legend className="sr-only">
                              <Trans>Search filter {index + 1}</Trans>
                            </legend>
                            <div className="flex items-start gap-2">
                              <NativeSelect
                                aria-label={t`Search filter mode`}
                                size="sm"
                                value={filter.mode}
                                onChange={(event) => {
                                  const mode = event.target.value as typeof filter.mode;
                                  setCriteriaEdit((current) =>
                                    current
                                      ? {
                                          ...current,
                                          searchFilters: current.searchFilters.map((item) =>
                                            item.id === filter.id ? { ...item, mode } : item,
                                          ),
                                        }
                                      : null,
                                  );
                                }}
                              >
                                <NativeSelectOption value="include">
                                  <Trans>Include</Trans>
                                </NativeSelectOption>
                                <NativeSelectOption value="exclude">
                                  <Trans>Exclude</Trans>
                                </NativeSelectOption>
                                <NativeSelectOption value="prefer">
                                  <Trans>Prefer</Trans>
                                </NativeSelectOption>
                              </NativeSelect>
                              <Button
                                size="sm"
                                variant="ghost"
                                aria-label={t`Remove filter`}
                                onClick={() =>
                                  setCriteriaEdit((current) =>
                                    current
                                      ? {
                                          ...current,
                                          searchFilters: current.searchFilters.filter(
                                            (item) => item.id !== filter.id,
                                          ),
                                        }
                                      : null,
                                  )
                                }
                              >
                                <X size={14} aria-hidden />
                              </Button>
                            </div>
                            <Textarea
                              aria-label={t`Search filter`}
                              value={filter.statement}
                              aria-invalid={!filter.statement.trim()}
                              onChange={(event) => {
                                const statement = event.target.value;
                                setCriteriaEdit((current) =>
                                  current
                                    ? {
                                        ...current,
                                        searchFilters: current.searchFilters.map((item) =>
                                          item.id === filter.id ? { ...item, statement } : item,
                                        ),
                                      }
                                    : null,
                                );
                              }}
                            />
                          </fieldset>
                        ))}
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() =>
                            setCriteriaEdit((current) =>
                              current
                                ? {
                                    ...current,
                                    searchFilters: [
                                      ...current.searchFilters,
                                      { id: crypto.randomUUID(), statement: "", mode: "include" },
                                    ],
                                  }
                                : null,
                            )
                          }
                        >
                          <Trans>Add filter</Trans>
                        </Button>
                      </>
                    ) : workspace.revision.brief.searchFilters.length ? (
                      <ul className="space-y-3">
                        {workspace.revision.brief.searchFilters.map((filter) => (
                          <li key={filter.id} className="space-y-1">
                            <p>
                              {filter.mode === "include" ? (
                                <Trans>Include</Trans>
                              ) : filter.mode === "exclude" ? (
                                <Trans>Exclude</Trans>
                              ) : (
                                <Trans>Prefer</Trans>
                              )}{" "}
                              · {filter.statement}
                            </p>
                            <p className="text-xs text-muted-foreground">
                              {filter.origin === "user_instruction" ? (
                                <Trans>User instruction</Trans>
                              ) : filter.origin === "jd" ? (
                                <Trans>JD</Trans>
                              ) : filter.origin === "hm" ? (
                                <Trans>Hiring manager</Trans>
                              ) : (
                                <Trans>Assumption</Trans>
                              )}
                            </p>
                            {filter.sourceRefIds.length ? (
                              <details>
                                <summary className="cursor-pointer text-xs text-muted-foreground">
                                  <Trans>Sources</Trans>
                                </summary>
                                <Sources
                                  sourceTarget={{
                                    kind: "role",
                                    threadId,
                                    roleRevisionId: workspace.revision.id,
                                  }}
                                  showDiagnostics={showDiagnostics}
                                  sources={[
                                    ...new Map(
                                      [
                                        ...workspace.revision.sourceRefs,
                                        ...workspace.revision.criteria.flatMap(
                                          (criterion) => criterion.sourceRefs,
                                        ),
                                      ].map((ref) => [ref.id, ref]),
                                    ).values(),
                                  ].filter((ref) => filter.sourceRefIds.includes(ref.id))}
                                />
                              </details>
                            ) : null}
                          </li>
                        ))}
                      </ul>
                    ) : (
                      <p className="text-muted-foreground">
                        <Trans>No additional search filters</Trans>
                      </p>
                    )}
                  </section>
                ) : null}
                {criteriaEdit?.roleId === workspace.role.id ? (
                  <div className="space-y-4">
                    {criteriaEdit.revision.criteria.map((criterion, index) => {
                      const draft = criteriaEdit.criteria[index]!;
                      return (
                        <fieldset key={criterion.id} className="space-y-2">
                          <legend className="sr-only">
                            <Trans>Criterion {index + 1}</Trans>
                          </legend>
                          <NativeSelect
                            aria-label={t`Priority`}
                            size="sm"
                            value={draft.priority}
                            onChange={(event) => {
                              const priority = event.target.value === "hard" ? "hard" : "preferred";
                              setCriteriaEdit((current) =>
                                current
                                  ? {
                                      ...current,
                                      criteria: current.criteria.map((item) =>
                                        item.criterionId === criterion.id
                                          ? { ...item, priority }
                                          : item,
                                      ),
                                    }
                                  : null,
                              );
                            }}
                          >
                            <NativeSelectOption value="hard">
                              <Trans>Hard</Trans>
                            </NativeSelectOption>
                            <NativeSelectOption value="preferred">
                              <Trans>Preferred</Trans>
                            </NativeSelectOption>
                          </NativeSelect>
                          <CriteriaExpressionFields
                            expression={criterion.expression}
                            atoms={draft.atoms}
                            onChange={(changedAtom) => {
                              setCriteriaEdit((current) =>
                                current
                                  ? {
                                      ...current,
                                      criteria: current.criteria.map((item) => ({
                                        ...item,
                                        atoms: item.atoms.map((atom) =>
                                          atom.atomId === changedAtom.atomId ? changedAtom : atom,
                                        ),
                                      })),
                                    }
                                  : null,
                              );
                            }}
                          />
                          <details>
                            <summary className="cursor-pointer text-xs text-muted-foreground">
                              <Trans>Sources</Trans>
                            </summary>
                            <div className="mt-2">
                              <Sources
                                sourceTarget={{
                                  kind: "role",
                                  threadId,
                                  roleRevisionId: workspace.revision.id,
                                }}
                                showDiagnostics={showDiagnostics}
                                sources={criterion.sourceRefs}
                              />
                            </div>
                          </details>
                          {criterion.definitionQuestions.map((question) => (
                            <p key={question} className="text-muted-foreground">
                              {question}
                            </p>
                          ))}
                        </fieldset>
                      );
                    })}
                    <div className="flex gap-2">
                      <Button
                        size="sm"
                        disabled={
                          loading ||
                          failed ||
                          savingCriteria ||
                          invalidCriteria ||
                          invalidSearchFilters ||
                          (!criteriaChanges.length && !searchFiltersChanged)
                        }
                        aria-busy={savingCriteria}
                        onClick={() => void saveCriteria()}
                      >
                        <Trans>Save</Trans>
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={savingCriteria}
                        onClick={() => {
                          setCriteriaEdit(null);
                          setCriteriaFailed(false);
                        }}
                      >
                        <Trans>Cancel</Trans>
                      </Button>
                    </div>
                    {criteriaFailed ? (
                      <p role="alert" className="text-destructive">
                        <Trans>Changes could not be saved.</Trans>
                      </p>
                    ) : null}
                  </div>
                ) : (
                  (["hard", "preferred"] as const).map((priority) => (
                    <div key={priority} className="space-y-2">
                      <h4 className="font-medium">
                        {priority === "hard" ? (
                          <Trans>Hard criteria</Trans>
                        ) : (
                          <Trans>Preferred criteria</Trans>
                        )}
                      </h4>
                      <ul className="space-y-3">
                        {criteria
                          .filter((criterion) => criterion.priority === priority)
                          .map((criterion) => (
                            <li key={criterion.id} className="space-y-2">
                              <CriteriaExpression expression={criterion.expression} />
                              {expressionAtoms(criterion.expression).map((atom) =>
                                "employmentRule" in atom ? (
                                  <EmploymentRuleSummary
                                    key={atom.atomId}
                                    rule={atom.employmentRule}
                                  />
                                ) : null,
                              )}
                              <details>
                                <summary className="cursor-pointer text-xs text-muted-foreground">
                                  <Trans>Sources</Trans>
                                </summary>
                                <div className="mt-2">
                                  <Sources
                                    sourceTarget={{
                                      kind: "role",
                                      threadId,
                                      roleRevisionId: workspace.revision.id,
                                    }}
                                    showDiagnostics={showDiagnostics}
                                    sources={criterion.sourceRefs}
                                  />
                                </div>
                              </details>
                            </li>
                          ))}
                      </ul>
                    </div>
                  ))
                )}
                {workspace.revision.preferences.length ? (
                  <div className="space-y-2">
                    <h4 className="font-medium">
                      <Trans>Preferences</Trans>
                    </h4>
                    <ul className="space-y-1">
                      {workspace.revision.preferences.map((preference) => (
                        <li key={preference}>{preference}</li>
                      ))}
                    </ul>
                  </div>
                ) : null}
                <details>
                  <summary className="cursor-pointer text-muted-foreground">
                    <Trans>Role sources</Trans>
                  </summary>
                  <div className="mt-2">
                    <Sources
                      sourceTarget={{
                        kind: "role",
                        threadId,
                        roleRevisionId: workspace.revision.id,
                      }}
                      sources={workspace.revision.sourceRefs}
                      showDiagnostics={showDiagnostics}
                    />
                  </div>
                </details>
              </>
            ) : (
              <p className="text-muted-foreground">
                <Trans>No role linked</Trans>
              </p>
            )}
          </TabsContent>
          <TabsContent value="evidence" className="space-y-4">
            {workspace ? (
              <>
                {showDiagnostics
                  ? snapshot?.research.tasks.flatMap((task) =>
                      snapshot?.research.actions
                        .filter(
                          (action) => action.taskId === task.id && action.outputArtifacts.length,
                        )
                        .map((action) => (
                          <ResearchResults
                            key={`${task.roleId}:${action.id}`}
                            task={task}
                            action={action}
                            isCurrent={action.roleRevisionId === workspace?.revision.id}
                          />
                        )),
                    )
                  : null}
                <div
                  className={
                    filteredShortlistWeek
                      ? "hidden"
                      : presentation === "workspace"
                        ? "hire-results-filters flex flex-wrap gap-2"
                        : "flex flex-wrap gap-2"
                  }
                >
                  <Input
                    aria-label={t`Search candidates`}
                    placeholder={t`Search candidates`}
                    value={candidateFilters.query ?? ""}
                    onChange={(event) =>
                      setCandidateFilters((current) => ({
                        ...current,
                        query: event.target.value || undefined,
                      }))
                    }
                  />
                  {showInternalAssessments ? (
                    <>
                      <NativeSelect
                        aria-label={t`Internal assessment`}
                        value={candidateFilters.assessmentState ?? "all"}
                        onChange={(event) =>
                          setCandidateFilters((current) => ({
                            ...current,
                            assessmentState:
                              event.target.value === "all"
                                ? undefined
                                : (event.target
                                    .value as ListRecruitingCandidatesInput["assessmentState"]),
                          }))
                        }
                      >
                        <NativeSelectOption value="all">
                          <Trans>All internal assessments</Trans>
                        </NativeSelectOption>
                        <NativeSelectOption value="unassessed">
                          <Trans>No internal assessment</Trans>
                        </NativeSelectOption>
                        <NativeSelectOption value="current">
                          <Trans>Internal assessment: current</Trans>
                        </NativeSelectOption>
                        <NativeSelectOption value="outdated">
                          <Trans>Internal assessment: outdated</Trans>
                        </NativeSelectOption>
                      </NativeSelect>
                      <NativeSelect
                        aria-label={t`Internal verdict`}
                        value={candidateFilters.verdict ?? "all"}
                        onChange={(event) =>
                          setCandidateFilters((current) => ({
                            ...current,
                            verdict:
                              event.target.value === "all"
                                ? undefined
                                : (event.target.value as Verdict),
                          }))
                        }
                      >
                        <NativeSelectOption value="all">
                          <Trans>All internal verdicts</Trans>
                        </NativeSelectOption>
                        <NativeSelectOption value="met">
                          <Trans>Internal verdict: met</Trans>
                        </NativeSelectOption>
                        <NativeSelectOption value="unmet">
                          <Trans>Internal verdict: unmet</Trans>
                        </NativeSelectOption>
                        <NativeSelectOption value="unknown">
                          <Trans>Internal verdict: unknown</Trans>
                        </NativeSelectOption>
                      </NativeSelect>
                    </>
                  ) : null}
                  {candidatePage ? (
                    <NativeSelect
                      aria-label={t`Candidate sort`}
                      value={candidateFilters.sort ?? "score"}
                      onChange={(event) => {
                        setCandidateFilters((current) => ({
                          ...current,
                          sort: event.target.value as ListRecruitingCandidatesInput["sort"],
                        }));
                        setCandidateList((current) => ({ ...current, userSort: true }));
                      }}
                    >
                      {candidatePage.sortAvailability.rank ? (
                        <NativeSelectOption value="rank">
                          {showDiagnostics ? <Trans>Autumn rank</Trans> : <Trans>Rank</Trans>}
                        </NativeSelectOption>
                      ) : null}
                      {candidatePage.sortAvailability.tier ? (
                        <NativeSelectOption value="tier">
                          <Trans>Match tier</Trans>
                        </NativeSelectOption>
                      ) : null}
                      {candidatePage.sortAvailability.score ? (
                        <NativeSelectOption value="score">
                          <Trans>Match score</Trans>
                        </NativeSelectOption>
                      ) : null}
                      <NativeSelectOption value="name">
                        <Trans>Name</Trans>
                      </NativeSelectOption>
                      <NativeSelectOption value="recent">
                        <Trans>Recently discovered</Trans>
                      </NativeSelectOption>
                    </NativeSelect>
                  ) : null}
                  <NativeSelect
                    aria-label={t`Research round`}
                    disabled={!snapshot}
                    value={
                      candidateFilters.sourceEffectId
                        ? `source:${candidateFilters.sourceEffectId}`
                        : candidateFilters.actionId
                          ? `action:${candidateFilters.actionId}`
                          : "all"
                    }
                    onChange={(event) => {
                      const value = event.target.value;
                      setCandidateFilters((current) => ({
                        ...current,
                        actionId: value.startsWith("action:") ? value.slice(7) : undefined,
                        sourceEffectId: value.startsWith("source:") ? value.slice(7) : undefined,
                      }));
                    }}
                  >
                    <NativeSelectOption value="all">
                      <Trans>All rounds</Trans>
                    </NativeSelectOption>
                    {snapshot?.research.actions.map((action, index) => (
                      <NativeSelectOption key={`action:${action.id}`} value={`action:${action.id}`}>
                        {showDiagnostics ? (
                          <>
                            {action.kind} · {action.id}
                          </>
                        ) : (
                          <Trans>Search update {index + 1}</Trans>
                        )}
                      </NativeSelectOption>
                    ))}
                    {snapshot?.research.observations.map((observation) => (
                      <NativeSelectOption
                        key={`source:${observation.effectId}`}
                        value={`source:${observation.effectId}`}
                      >
                        <Trans>Saved results</Trans>
                        {" · "}
                        {new Date(observation.observedAt).toLocaleString(undefined, {
                          timeZone: "America/Los_Angeles",
                          timeZoneName: "short",
                        })}
                      </NativeSelectOption>
                    ))}
                  </NativeSelect>
                  {!(presentation === "workspace" && view === "shortlist") ? (
                    <label htmlFor={shortlistFilterId} className="flex items-center gap-2">
                      <Checkbox
                        id={shortlistFilterId}
                        checked={candidateFilters.shortlisted === true}
                        onCheckedChange={(checked) =>
                          setCandidateFilters((current) => ({
                            ...current,
                            shortlisted: checked ? true : undefined,
                          }))
                        }
                      />
                      <Trans>Shortlisted only</Trans>
                    </label>
                  ) : null}
                </div>
                {!contactsView ? (
                  <fieldset
                    className={
                      presentation === "workspace" ? "hire-view-toggle flex gap-1" : "flex gap-1"
                    }
                    aria-label={t`Saved candidates`}
                  >
                    <Button
                      size="sm"
                      variant={candidateView === "cards" ? "secondary" : "ghost"}
                      aria-pressed={candidateView === "cards"}
                      onClick={() =>
                        setCandidateList((current) => ({ ...current, candidateView: "cards" }))
                      }
                    >
                      {presentation === "workspace" ? <LayoutGrid size={15} aria-hidden /> : null}
                      <Trans>Cards</Trans>
                    </Button>
                    <Button
                      size="sm"
                      variant={candidateView === "table" ? "secondary" : "ghost"}
                      aria-pressed={candidateView === "table"}
                      onClick={() =>
                        setCandidateList((current) => ({ ...current, candidateView: "table" }))
                      }
                    >
                      {presentation === "workspace" ? <List size={15} aria-hidden /> : null}
                      <Trans>Table</Trans>
                    </Button>
                  </fieldset>
                ) : null}
                {contactsView ? (
                  <ContactsTab
                    shortlistWeekFilter={shortlistWeekFilter}
                    onClearShortlistWeekFilter={onClearShortlistWeekFilter}
                    roleId={workspace.role.id}
                    spaceId={workspace.role.spaceId}
                    criterionRevision={workspace.revision}
                    conversation={groupId ? { groupId } : botId ? { botId } : undefined}
                    crmTarget={workspace.crmTarget?.target ?? null}
                    refreshSignal={(refreshSignal ?? 0) + refresh}
                    readCache={readCache}
                    readCacheScope={readCacheScope}
                    autumn={{
                      items: candidatePage?.items ?? [],
                      loading: candidateLoading && !candidatePage,
                      failed: candidateFailed,
                      retry: () => setFeedbackRefresh((value) => value + 1),
                      total: candidatePage?.total ?? null,
                      hasMore: Boolean(candidatePage?.nextCursor),
                      loadMore: () => void loadMoreCandidates(),
                      sortByScore: (candidateFilters.sort ?? "score") === "score",
                      includeCrm:
                        !candidateFilters.shortlisted &&
                        !candidateFilters.actionId &&
                        !candidateFilters.sourceEffectId &&
                        !candidateFilters.assessmentState &&
                        !candidateFilters.verdict,
                      query: candidateFilters.query,
                      selectedKey: selection?.candidateKey,
                      ready: candidateFresh && shortlistPending === null,
                      shortlistFailedKey: shortlistFailed,
                      setShortlist: (candidate, shortlisted) =>
                        void setShortlist(candidate, shortlisted),
                      sendEmail: onDiscussCandidate
                        ? (candidate) => discussCandidate(candidate, "email_draft")
                        : undefined,
                      findEmail: onDiscussCandidate
                        ? (candidate) => discussCandidate(candidate, "contact_lookup")
                        : undefined,
                      openEvidence: (candidate, trigger) =>
                        selectCandidate(candidate, trigger as HTMLButtonElement),
                    }}
                  />
                ) : candidateFailed ? (
                  <RetryNotice onRetry={() => setFeedbackRefresh((value) => value + 1)}>
                    <Trans>Could not load candidates</Trans>
                  </RetryNotice>
                ) : candidateLoading && !candidatePage ? (
                  <TabLoading />
                ) : null}
                {!contactsView && candidatePage ? (
                  <>
                    <p className="text-xs text-muted-foreground">
                      <Plural value={candidatePage.total} _1="# candidate" other="# candidates" />
                    </p>
                    {candidatePage.crmTarget ? (
                      <p className="text-xs text-muted-foreground">
                        <Trans>Pipeline</Trans> · {candidatePage.crmTarget.target.clientLabel} ·{" "}
                        {candidatePage.crmTarget.target.roleLabel}
                      </p>
                    ) : null}
                    {!candidatePage.items.length ? (
                      <div className="space-y-3 text-muted-foreground">
                        <p>
                          {shortlistView ? (
                            candidatePage.counts.shortlisted === 0 ? (
                              <Trans>No shortlisted candidates yet.</Trans>
                            ) : (
                              <Trans>No shortlisted candidates match these filters.</Trans>
                            )
                          ) : (
                            <Trans>No saved candidates</Trans>
                          )}
                        </p>
                        {shortlistView && onBrowseCandidates ? (
                          <>
                            <p>
                              <Trans>Shortlist people from search results to keep them here.</Trans>
                            </p>
                            <Button
                              variant="outline"
                              onClick={() => {
                                setCandidateFilters(() => readRecruitingPanelState(null).filters);
                                onBrowseCandidates();
                              }}
                            >
                              <Trans>Browse all candidates</Trans>
                            </Button>
                          </>
                        ) : null}
                      </div>
                    ) : candidateView === "cards" ? (
                      <ul
                        className={presentation === "workspace" ? "hire-card-grid" : "grid gap-2"}
                      >
                        {candidatePage.items.map((candidate) => (
                          <li key={candidate.candidateKey} {...arrival(candidate.candidateKey)}>
                            {presentation === "workspace" ? (
                              <SourcingCandidateCard
                                candidate={candidate}
                                selected={selection?.candidateKey === candidate.candidateKey}
                                triggerRef={
                                  selection?.candidateKey === candidate.candidateKey
                                    ? candidateTrigger
                                    : undefined
                                }
                                onOpen={(trigger) => selectCandidate(candidate, trigger)}
                                onShortlist={() =>
                                  void setShortlist(candidate, !candidate.shortlisted)
                                }
                                shortlistPending={shortlistPending !== null || !candidateFresh}
                                shortlistFailed={shortlistFailed === candidate.candidateKey}
                                onEmailDraft={
                                  onDiscussCandidate
                                    ? () => discussCandidate(candidate, "email_draft")
                                    : undefined
                                }
                              />
                            ) : (
                              <Card
                                size="sm"
                                className={
                                  selection?.candidateKey === candidate.candidateKey
                                    ? "ring-primary"
                                    : undefined
                                }
                              >
                                <CardContent className="space-y-2">
                                  <div className="flex items-start justify-between gap-2">
                                    <Button
                                      ref={
                                        selection?.candidateKey === candidate.candidateKey
                                          ? candidateTrigger
                                          : undefined
                                      }
                                      variant="link"
                                      className="h-auto justify-start whitespace-normal break-all p-0 text-left"
                                      aria-haspopup="dialog"
                                      aria-pressed={
                                        selection?.candidateKey === candidate.candidateKey
                                      }
                                      onClick={(event) =>
                                        selectCandidate(candidate, event.currentTarget)
                                      }
                                    >
                                      {candidate.name ??
                                        (showDiagnostics
                                          ? candidate.candidateKey
                                          : t`Unnamed candidate`)}
                                    </Button>
                                    <Checkbox
                                      aria-label={t`Shortlist ${candidate.name ?? (showDiagnostics ? candidate.candidateKey : t`Unnamed candidate`)}`}
                                      checked={candidate.shortlisted}
                                      disabled={shortlistPending !== null || !candidateFresh}
                                      onCheckedChange={(checked) =>
                                        void setShortlist(candidate, !!checked)
                                      }
                                    />
                                  </div>
                                  <p className="text-xs text-muted-foreground">
                                    {workspace?.role.title}
                                    <CandidateDecision decision={candidate.decision} />
                                  </p>
                                  {candidate.title || candidate.company ? (
                                    <p>
                                      {[candidate.title, candidate.company]
                                        .filter(Boolean)
                                        .join(" · ")}
                                    </p>
                                  ) : null}
                                  {candidate.location ? (
                                    <p className="text-muted-foreground">{candidate.location}</p>
                                  ) : null}
                                  <CandidateProfile
                                    candidate={candidate}
                                    showDiagnostics={showDiagnostics}
                                  />
                                  <CandidateResearchMatch
                                    candidate={candidate}
                                    roleRevisionId={workspace?.revision.id}
                                    showDiagnostics={showDiagnostics}
                                  />
                                  <CandidateAssessment candidate={candidate} />
                                  {showCrm ? (
                                    <p className="text-xs text-muted-foreground">
                                      <Trans>Pipeline</Trans> · <CrmStatus sync={candidate.crm} />
                                    </p>
                                  ) : null}
                                  <p className="text-xs text-muted-foreground">
                                    <Trans>{candidate.discoveryCount} saved discoveries</Trans>
                                  </p>
                                  {shortlistFailed === candidate.candidateKey ? (
                                    <p role="alert" className="text-destructive">
                                      <Trans>Could not save shortlist</Trans>
                                    </p>
                                  ) : null}
                                </CardContent>
                              </Card>
                            )}
                          </li>
                        ))}
                      </ul>
                    ) : (
                      <div
                        className={
                          presentation === "workspace"
                            ? "hire-table-wrap overflow-x-auto"
                            : "overflow-x-auto"
                        }
                      >
                        <table
                          className={
                            presentation === "workspace"
                              ? "hire-table w-full text-left text-sm [&_td]:align-top [&_th]:align-top"
                              : "w-full text-left text-sm [&_td]:align-top [&_th]:align-top"
                          }
                        >
                          <caption className="sr-only">
                            <Trans>Saved candidates</Trans>
                          </caption>
                          <thead>
                            <tr className="border-b border-border">
                              {[
                                t`Candidate`,
                                ...(presentation !== "workspace" ? [t`Role`] : []),
                                presentation === "workspace" ? t`Current role` : t`Title`,
                                t`Company`,
                                t`Location`,
                                ...(presentation !== "workspace" ? [t`Profile`] : []),
                                t`Research match`,
                                ...(candidateTableDetails ? [t`Criteria`] : []),
                                ...(showInternalAssessments ? [t`Internal assessment`] : []),
                                ...(candidateTableDetails ? [t`Research round`, t`Feedback`] : []),
                                ...(showCrm ? [t`Pipeline`] : []),
                                ...(candidateTableDetails ? [t`Provider status`] : []),
                                ...(presentation !== "workspace" ? [t`Discoveries`] : []),
                                t`Shortlist`,
                              ].map((label) => (
                                <th key={label} scope="col" className="py-2 pe-3 font-medium">
                                  {label}
                                </th>
                              ))}
                            </tr>
                          </thead>
                          <tbody>
                            {candidatePage.items.map((candidate) => (
                              <tr
                                key={candidate.candidateKey}
                                style={arrival(candidate.candidateKey).style}
                                className={`border-b border-border ${arrival(candidate.candidateKey).className ?? ""}`}
                              >
                                <th scope="row" className="min-w-32 py-2 pe-3">
                                  <Button
                                    ref={
                                      selection?.candidateKey === candidate.candidateKey
                                        ? candidateTrigger
                                        : undefined
                                    }
                                    variant="link"
                                    className="h-auto justify-start whitespace-normal p-0 text-left"
                                    aria-haspopup="dialog"
                                    aria-pressed={
                                      selection?.candidateKey === candidate.candidateKey
                                    }
                                    onClick={(event) =>
                                      selectCandidate(candidate, event.currentTarget)
                                    }
                                  >
                                    {candidate.name ??
                                      (showDiagnostics
                                        ? candidate.candidateKey
                                        : t`Unnamed candidate`)}
                                  </Button>
                                  {presentation === "workspace" ? (
                                    <CandidateProfile candidate={candidate} />
                                  ) : null}
                                </th>
                                {presentation !== "workspace" ? (
                                  <td className="py-2 pe-3">
                                    {workspace?.role.title}
                                    <CandidateDecision decision={candidate.decision} />
                                  </td>
                                ) : null}
                                <td className="py-2 pe-3">{candidate.title ?? "—"}</td>
                                <td className="py-2 pe-3">{candidate.company ?? "—"}</td>
                                <td className="py-2 pe-3">{candidate.location ?? "—"}</td>
                                {presentation !== "workspace" ? (
                                  <td className="py-2 pe-3">
                                    <CandidateProfile
                                      candidate={candidate}
                                      showDiagnostics={showDiagnostics}
                                    />
                                  </td>
                                ) : null}
                                <td className="min-w-48 py-2 pe-3">
                                  <CandidateResearchMatch
                                    candidate={candidate}
                                    roleRevisionId={workspace?.revision.id}
                                    showDiagnostics={showDiagnostics}
                                    compact
                                  />
                                </td>
                                {candidateTableDetails ? (
                                  <td className="min-w-48 py-2 pe-3 text-xs">
                                    <CandidateCriteria candidate={candidate} />
                                  </td>
                                ) : null}
                                {showInternalAssessments ? (
                                  <td className="py-2 pe-3">
                                    <CandidateAssessment candidate={candidate} />
                                  </td>
                                ) : null}
                                {candidateTableDetails ? (
                                  <>
                                    <td className="py-2 pe-3 text-xs">
                                      <CandidateSourceRound
                                        candidate={candidate}
                                        research={snapshot?.research}
                                      />
                                    </td>
                                    <td className="py-2 pe-3 text-xs">
                                      {candidate.decision ? (
                                        <>
                                          <CandidateDecision decision={candidate.decision} />
                                          {candidate.decisionReason ? (
                                            <p className="whitespace-pre-wrap">
                                              {candidate.decisionReason}
                                            </p>
                                          ) : null}
                                        </>
                                      ) : (
                                        "—"
                                      )}
                                    </td>
                                  </>
                                ) : null}
                                {showCrm ? (
                                  <td className="py-2 pe-3 text-xs">
                                    <CrmStatus sync={candidate.crm} />
                                  </td>
                                ) : null}
                                {candidateTableDetails ? (
                                  <td className="py-2 pe-3 text-xs">
                                    <CandidateContactFields
                                      candidate={candidate}
                                      contacts={[]}
                                      kind="status"
                                      labels={CONTACT_STATUS_LABELS}
                                    />
                                  </td>
                                ) : null}
                                {presentation !== "workspace" ? (
                                  <td className="py-2 pe-3 tabular-nums">
                                    {candidate.discoveryCount}
                                  </td>
                                ) : null}
                                <td className="py-2">
                                  <Checkbox
                                    aria-label={t`Shortlist ${candidate.name ?? (showDiagnostics ? candidate.candidateKey : t`Unnamed candidate`)}`}
                                    checked={candidate.shortlisted}
                                    disabled={shortlistPending !== null || !candidateFresh}
                                    onCheckedChange={(checked) =>
                                      void setShortlist(candidate, !!checked)
                                    }
                                  />
                                  {shortlistFailed === candidate.candidateKey ? (
                                    <p role="alert">
                                      <Trans>Could not save shortlist</Trans>
                                    </p>
                                  ) : null}
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    )}
                    {candidatePage.nextCursor ? (
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={candidateLoading}
                        onClick={() => void loadMoreCandidates()}
                      >
                        <Trans>Load more</Trans>
                      </Button>
                    ) : null}
                  </>
                ) : null}
              </>
            ) : (
              <p className="text-muted-foreground">
                <Trans>No role linked</Trans>
              </p>
            )}
          </TabsContent>
          <TabsContent value="missing" className="space-y-5">
            {snapshot?.questions.map((question) => {
              const candidateKey =
                question.target.kind === "candidate" ? question.target.candidateKey : null;
              const target = question.groupId
                ? { groupId: question.groupId }
                : { botId: question.botId };
              return (
                <div
                  key={`${question.effectId}:${question.messageId}:${question.askIndex}`}
                  className="space-y-2 [&>div]:max-w-full"
                >
                  <p className="text-xs text-muted-foreground">
                    {question.target.kind === "candidate" ? (
                      <>
                        {showDiagnostics
                          ? question.target.candidateKey
                          : (candidatePage?.items.find(
                              (candidate) => candidate.candidateKey === candidateKey,
                            )?.name ?? t`Candidate question`)}{" "}
                        ·{" "}
                      </>
                    ) : null}
                    {question.isCurrent ? <Trans>Current</Trans> : <Trans>Outdated</Trans>}
                  </p>
                  <AskCard
                    block={question.block}
                    canAnswer={question.canAnswer}
                    onAnswer={async (answer) => {
                      await rpc.threads.answer({
                        ...target,
                        runId: question.runId,
                        messageId: question.messageId,
                        answer,
                      });
                      setRefresh((value) => value + 1);
                    }}
                  />
                  {onRevealMessage ? (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => onRevealMessage({ ...target, messageId: question.messageId })}
                    >
                      <Trans>Open original question</Trans>
                    </Button>
                  ) : null}
                </div>
              );
            })}
            <div className="space-y-2">
              <h3 className="font-medium">
                <Trans>Role definition</Trans>
              </h3>
              {roleQuestions.map((question, index) => (
                <p key={`${index}:${question}`}>{question}</p>
              ))}
              {unphrasedBriefFields.length && workspace ? (
                <>
                  <p role="status">
                    <Trans>Role details needing clarification: {unphrasedBriefFields.length}</Trans>
                  </p>
                  <ul className="space-y-3">
                    {unphrasedBriefFields.map((field) => (
                      <li key={field.key} className="space-y-1">
                        <p>
                          {field.state === "conflict" ? (
                            <Trans>Conflicting information</Trans>
                          ) : field.state === "missing" ? (
                            <Trans>Missing info</Trans>
                          ) : (
                            <Trans>Assumption</Trans>
                          )}
                        </p>
                        {field.value !== null ? (
                          <p className="whitespace-pre-wrap">{field.value}</p>
                        ) : null}
                        {field.sourceRefIds.length ? (
                          <details>
                            <summary className="cursor-pointer text-xs text-muted-foreground">
                              <Trans>Sources</Trans>
                            </summary>
                            <div className="mt-2">
                              <Sources
                                sourceTarget={{
                                  kind: "role",
                                  threadId,
                                  roleRevisionId: workspace.revision.id,
                                }}
                                showDiagnostics={showDiagnostics}
                                sources={roleSources.filter((source) =>
                                  field.sourceRefIds.includes(source.id),
                                )}
                              />
                            </div>
                          </details>
                        ) : null}
                      </li>
                    ))}
                  </ul>
                  <p className="text-muted-foreground">
                    <Trans>Ask an agent to clarify in chat.</Trans>
                  </p>
                </>
              ) : null}
              {snapshot && !roleQuestions.length && !unphrasedBriefFields.length ? (
                <p className="text-muted-foreground">
                  <Trans>No saved questions</Trans>
                </p>
              ) : null}
            </div>
            <div className="space-y-3">
              <h3 className="font-medium">
                <Trans>Candidate facts</Trans>
              </h3>
              {!snapshot ? null : !assessments.length ? (
                <p className="text-muted-foreground">
                  <Trans>No saved assessments</Trans>
                </p>
              ) : (
                assessments.map(({ assessment, isCurrent }) => (
                  <div
                    key={`${assessment.candidateKey}:${assessment.version}`}
                    className="space-y-1"
                  >
                    <p className="text-xs text-muted-foreground">
                      {showDiagnostics
                        ? assessment.candidateKey
                        : (candidatePage?.items.find(
                            (candidate) => candidate.candidateKey === assessment.candidateKey,
                          )?.name ?? t`Unnamed candidate`)}{" "}
                      · {isCurrent ? <Trans>Current</Trans> : <Trans>Outdated</Trans>}
                    </p>
                    {[
                      ...assessment.questions,
                      ...assessment.judgments.criteria.flatMap((judgment) => judgment.missing),
                    ].map((question, index) => (
                      <p key={`${index}:${question}`}>{question}</p>
                    ))}
                  </div>
                ))
              )}
            </div>
          </TabsContent>
          <TabsContent value="memory" className="space-y-3">
            <div className="text-xs text-muted-foreground">
              <p>{botId ? <Trans>User and bot memory</Trans> : <Trans>User memory</Trans>}</p>
              {!botId ? (
                <p>
                  <Trans>Group bot memory is not included</Trans>
                </p>
              ) : null}
            </div>
            {snapshot?.documents.length === 0 ? (
              <p className="text-muted-foreground">
                <Trans>No saved memory in these scopes</Trans>
              </p>
            ) : (
              snapshot?.documents.map((document) => (
                <MemoryDocumentView
                  key={`${document.id}:${document.revision}`}
                  document={document}
                  showDiagnostics={showDiagnostics}
                />
              ))
            )}
          </TabsContent>
          <TabsContent value="activity" className="space-y-5">
            {workspace ? (
              <FeedbackHistory
                key={workspace.role.id}
                roleId={workspace.role.id}
                refreshSignal={(refreshSignal ?? 0) + feedbackRefresh}
                readCache={readCache}
                readCacheScope={readCacheScope}
                onAccessError={denyAccess}
              />
            ) : null}
            {snapshot?.research.tasks.length === 0 ? (
              <p className="text-muted-foreground">
                {snapshot?.research.observations.length ? (
                  <Trans>Results saved</Trans>
                ) : (
                  <Trans>No research activity</Trans>
                )}
              </p>
            ) : (
              snapshot?.research.tasks.map((task, index) => (
                <div key={task.id} className="space-y-3">
                  <div>
                    <h3 className="font-medium">
                      {showDiagnostics ? task.id : <Trans>Search {index + 1}</Trans>}
                    </h3>
                    <p className="text-xs text-muted-foreground">
                      {task.state}{" "}
                      {showDiagnostics && task.providerTaskId ? `· ${task.providerTaskId}` : ""}
                    </p>
                  </div>
                  {snapshot?.research.actions
                    .filter((action) => action.taskId === task.id)
                    .map((action) => (
                      <div key={action.id} className="space-y-2 border-s border-border ps-3">
                        <p>
                          {showDiagnostics ? (
                            <>
                              {action.kind} · {action.deliveryState}
                              {action.observedProviderState
                                ? ` · ${action.observedProviderState}`
                                : ""}
                            </>
                          ) : (
                            <ResearchActionStatus action={action} />
                          )}
                        </p>
                        {showDiagnostics ? (
                          <details>
                            <summary className="cursor-pointer text-xs text-muted-foreground">
                              <Trans>Details</Trans>
                            </summary>
                            <div className="space-y-1 break-all text-xs text-muted-foreground">
                              <p>{action.id}</p>
                              <p>{action.roleRevisionId}</p>
                              <p>{action.runId}</p>
                              <p>{action.sourceMessageId}</p>
                              {action.usage?.map((usage, index) => (
                                <p key={`${index}:${usage.unit}`}>
                                  {usage.scope} · {usage.amount} {usage.unit}
                                </p>
                              ))}
                            </div>
                          </details>
                        ) : null}
                        {action.recallScope ? (
                          <p className="whitespace-pre-wrap">{action.recallScope}</p>
                        ) : null}
                        {showDiagnostics ? (
                          <ArtifactReference
                            showDiagnostics
                            key={`request:${action.requestArtifact.artifactId}:${action.requestArtifact.sha256}`}
                            reference={action.requestArtifact}
                            label={t`Request`}
                          />
                        ) : null}
                        {showDiagnostics ? (
                          <ArtifactReference
                            showDiagnostics
                            key={`context:${action.contextArtifact.artifactId}:${action.contextArtifact.sha256}`}
                            reference={action.contextArtifact}
                            label={t`Context`}
                          />
                        ) : null}
                        {showDiagnostics && action.receiptArtifact ? (
                          <ArtifactReference
                            showDiagnostics
                            key={`receipt:${action.receiptArtifact.artifactId}:${action.receiptArtifact.sha256}`}
                            reference={action.receiptArtifact}
                            label={t`Receipt`}
                          />
                        ) : null}
                        {showDiagnostics
                          ? action.outputArtifacts.map((reference) => (
                              <ArtifactReference
                                showDiagnostics
                                key={`${reference.artifactId}:${reference.sha256}`}
                                reference={reference}
                                label={t`Output`}
                              />
                            ))
                          : null}
                      </div>
                    ))}
                </div>
              ))
            )}
          </TabsContent>
        </Tabs>
      ) : null}
      <Dialog
        open={candidateDetailOpen && !!selection}
        onOpenChange={setCandidateDetailOpen}
        onOpenChangeComplete={(open) => {
          if (open) return;
          const handoff = candidateHandoff.current;
          if (!handoff) return;
          // Let the popup unmount before the native chat callback takes focus.
          queueMicrotask(() => {
            if (candidateHandoff.current !== handoff) return;
            candidateHandoff.current = null;
            handoff();
          });
        }}
      >
        <DialogContent
          showCloseButton={false}
          initialFocus={candidateClose}
          data-product-view={presentation === "workspace" ? "recruiting" : undefined}
          finalFocus={candidateHandoff.current ? false : candidateTrigger}
          className={
            presentation === "workspace"
              ? "hire-profile-drawer inset-y-0 right-0 left-auto top-0 h-dvh max-h-dvh translate-x-0 translate-y-0 overflow-y-auto rounded-none text-sm leading-relaxed sm:max-w-2xl"
              : "max-h-[85dvh] overflow-y-auto text-base leading-relaxed sm:max-w-2xl"
          }
        >
          {selection ? (
            <div className="hire-candidate-body space-y-3">
              <div className="hire-candidate-header flex items-start justify-between gap-3">
                <DialogTitle className="break-words">
                  {selection.name ??
                    (showDiagnostics ? selection.candidateKey : t`Unnamed candidate`)}
                  <CandidateDecision decision={selection.decision} />
                </DialogTitle>
                <DialogClose
                  ref={candidateClose}
                  aria-label={t`Close`}
                  render={<Button variant="ghost" size="icon-sm" />}
                >
                  <X size={16} aria-hidden />
                </DialogClose>
              </div>
              {selection.title || selection.company || selection.location ? (
                <p className="text-muted-foreground">
                  {[selection.title, selection.company, selection.location]
                    .filter(Boolean)
                    .join(" · ")}
                </p>
              ) : null}
              <CandidateProfile candidate={selection} showDiagnostics={showDiagnostics} />
              <CandidateResearchMatch
                candidate={selection}
                roleRevisionId={workspace?.revision.id}
                showDiagnostics={showDiagnostics}
              />
              <div className="hire-candidate-actions">
                {onDiscussCandidate && workspace ? (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => {
                      candidateHandoff.current = () =>
                        onDiscussCandidate({
                          threadId,
                          roleTitle: workspace.role.title,
                          name: selection.name,
                          title: selection.title,
                          company: selection.company,
                          linkedinUrl: selection.linkedinUrl,
                          resumeUrl: selection.resumeUrl,
                        });
                      setCandidateDetailOpen(false);
                    }}
                  >
                    <Trans>Discuss candidate</Trans>
                  </Button>
                ) : null}
                {onCandidateFeedback && workspace && candidateDetailOpen ? (
                  <CandidateFeedbackForm
                    key={`${threadId}:${workspace.role.id}:${workspace.revision.id}:${selection.candidateKey}`}
                    candidate={{
                      threadId,
                      roleTitle: workspace.role.title,
                      roleVersion: workspace.revision.revision,
                      roleId: workspace.role.id,
                      roleRevisionId: workspace.revision.id,
                      candidateKey: selection.candidateKey,
                      candidateRevision: selection.revision,
                      name: selection.name,
                      title: selection.title,
                      company: selection.company,
                      linkedinUrl: selection.linkedinUrl,
                      resumeUrl: selection.resumeUrl,
                    }}
                    onSend={(...args) =>
                      candidateFresh &&
                      (!readCache || candidateValidation.current === readCache.epoch)
                        ? onCandidateFeedback(...args)
                        : Promise.resolve(false)
                    }
                    disabled={!candidateFresh}
                    recipients={candidateFeedbackRecipients}
                    onAccessError={denyAccess}
                    onRecorded={() => {
                      clearRecruitingReads(readCache, readCacheScope);
                      setRefresh((value) => value + 1);
                      setFeedbackRefresh((value) => value + 1);
                    }}
                  />
                ) : null}
              </div>
              {workspace ? (
                <FeedbackHistory
                  key={`feedback:${workspace.role.id}:${selection.candidateKey}`}
                  roleId={workspace.role.id}
                  candidateKey={selection.candidateKey}
                  refreshSignal={(refreshSignal ?? 0) + feedbackRefresh}
                  readCache={readCache}
                  readCacheScope={readCacheScope}
                  onAccessError={denyAccess}
                  collapsed
                />
              ) : null}
              {selectedCrmTarget ? (
                <section aria-label={t`Candidate pipeline`}>
                  <CrmDetails
                    sync={selectedCrm}
                    target={selectedCrmTarget}
                    showDiagnostics={showDiagnostics}
                  />
                </section>
              ) : null}
              {selection.latestAssessment && evidenceFailed ? (
                <p role="alert">
                  <Trans>Could not load assessment</Trans>
                </p>
              ) : selection.latestAssessment && !selectedEvidence ? (
                <p role="status">
                  <Trans>Loading…</Trans>
                </p>
              ) : selection.latestAssessment && !selected ? (
                <p role="alert">
                  <Trans>Assessment unavailable</Trans>
                </p>
              ) : null}
              {workspace && snapshot ? (
                <CandidateSources
                  key={`${selection.roleId}:${selection.candidateKey}`}
                  candidate={selection}
                  research={snapshot.research}
                  refreshSignal={candidateFresh ? candidatePage : null}
                  roleRevisionId={workspace.revision.id}
                  onAccessError={denyAccess}
                  showDiagnostics={showDiagnostics}
                />
              ) : null}
            </div>
          ) : null}
          {assessment && selected ? (
            <section
              key={`${assessment.roleId}:${assessment.candidateKey}:${assessment.version}`}
              aria-label={showDiagnostics ? assessment.candidateKey : t`Candidate assessment`}
              className="space-y-4 border-t border-border pt-4"
            >
              <h3 className="font-medium">
                {showDiagnostics
                  ? assessment.candidateKey
                  : (selection?.name ?? t`Unnamed candidate`)}
              </h3>
              <p className="text-xs text-muted-foreground">
                <Trans>Internal assessment</Trans> · <Trans>Role</Trans> ·{" "}
                <Trans>Version {selected.roleRevision.revision}</Trans>
              </p>
              <p className="flex items-center gap-2">
                <span>
                  <Trans>Hard criteria</Trans>
                </span>
                <VerdictLabel verdict={assessment.judgments.hardGate} />
              </p>
              {assessment.judgments.employment.map((employment) => {
                const count =
                  employment.upperMonths === employment.lowerMonths
                    ? String(employment.lowerMonths)
                    : `${employment.lowerMonths}–${employment.upperMonths ?? "?"}`;
                const cutoff = `${employment.cutoff.year}-${String(employment.cutoff.month).padStart(2, "0")}-${String(employment.cutoff.day).padStart(2, "0")}`;
                return (
                  <div key={employment.atomId} className="space-y-1">
                    <p>{employment.qualificationDefinition}</p>
                    <p className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                      <span>
                        <Trans>{count} months</Trans> · ≥ {employment.minimumMonths} · {cutoff}
                      </span>
                      <VerdictLabel verdict={employment.verdict} />
                    </p>
                  </div>
                );
              })}
              {assessment.judgments.criteria.map((judgment) => {
                const criterion = selected.roleRevision.criteria.find(
                  (item) => item.id === judgment.criterionId,
                );
                const facts = assessment.facts.filter((fact) => judgment.factIds.includes(fact.id));
                const sourceIds = new Set([
                  ...facts.flatMap((fact) => fact.sourceRefIds),
                  ...judgment.evidence,
                ]);
                return (
                  <details key={judgment.criterionId} open className="space-y-2">
                    <summary className="cursor-pointer">
                      <span className="me-2">
                        {criterion?.expression.kind === "atom"
                          ? criterion.expression.statement
                          : t`Criterion`}
                      </span>
                      <VerdictLabel verdict={judgment.verdict} />
                      {criterion ? (
                        <span className="ms-2 text-xs text-muted-foreground">
                          {criterion.priority === "hard" ? (
                            <Trans>Hard criteria</Trans>
                          ) : (
                            <Trans>Preferred criteria</Trans>
                          )}
                        </span>
                      ) : null}
                    </summary>
                    {criterion && criterion.expression.kind !== "atom" ? (
                      <CriteriaExpression expression={criterion.expression} />
                    ) : null}
                    {facts.map((fact) => (
                      <p key={fact.id}>{fact.statement}</p>
                    ))}
                    <Sources
                      sourceTarget={{
                        kind: "assessment",
                        roleId: assessment.roleId,
                        candidateKey: assessment.candidateKey,
                        version: assessment.version,
                      }}
                      sources={assessment.sourceRefs.filter((source) => sourceIds.has(source.id))}
                      messageTargets={selected.sourceMessageTargets}
                      onRevealMessage={revealCandidateMessage}
                      showDiagnostics={showDiagnostics}
                    />
                    {judgment.missing.map((question) => (
                      <p key={question} className="text-muted-foreground">
                        {question}
                      </p>
                    ))}
                  </details>
                );
              })}
              <details>
                <summary className="cursor-pointer text-muted-foreground">
                  <Trans>Saved facts</Trans>
                </summary>
                <ul className="mt-2 space-y-3">
                  {assessment.facts.map((fact) => (
                    <li key={fact.id} className="space-y-2">
                      <p>{fact.statement}</p>
                      <Sources
                        sourceTarget={{
                          kind: "assessment",
                          roleId: assessment.roleId,
                          candidateKey: assessment.candidateKey,
                          version: assessment.version,
                        }}
                        sources={assessment.sourceRefs.filter((source) =>
                          fact.sourceRefIds.includes(source.id),
                        )}
                        messageTargets={selected.sourceMessageTargets}
                        onRevealMessage={revealCandidateMessage}
                        showDiagnostics={showDiagnostics}
                      />
                    </li>
                  ))}
                </ul>
              </details>
              <details>
                <summary className="cursor-pointer text-muted-foreground">
                  <Trans>Sources</Trans>
                </summary>
                <div className="mt-2">
                  <Sources
                    sourceTarget={{
                      kind: "assessment",
                      roleId: assessment.roleId,
                      candidateKey: assessment.candidateKey,
                      version: assessment.version,
                    }}
                    showDiagnostics={showDiagnostics}
                    sources={assessment.sourceRefs}
                    messageTargets={selected.sourceMessageTargets}
                    onRevealMessage={revealCandidateMessage}
                  />
                </div>
              </details>
            </section>
          ) : null}
        </DialogContent>
      </Dialog>
    </section>
  );
}
