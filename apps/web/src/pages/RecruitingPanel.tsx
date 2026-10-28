import { lazyPanel } from "../components/ErrorBoundary";
import { withFeatureMessages } from "../lib/i18n";

const RecruitingSummary = lazyPanel(() =>
  withFeatureMessages(() => import("./recruiting/RecruitingSummary")).then(
    (m) => m.RecruitingSummary,
  ),
);
const RecruitingSupplementaryTab = lazyPanel(() =>
  withFeatureMessages(() => import("./recruiting/RecruitingSupplementaryTab")).then(
    (m) => m.RecruitingSupplementaryTab,
  ),
);

const CandidateDetailDialog = lazyPanel(() =>
  withFeatureMessages(() => import("./recruiting/CandidateDetailDialog")).then(
    (m) => m.CandidateDetailDialog,
  ),
);

import { CrmRecruitingPanel } from "./recruiting/CrmWorkbench";
import { RecruitingEvidenceTab } from "./recruiting/RecruitingEvidenceTab";

const RecruitingRoleTab = lazyPanel(() =>
  withFeatureMessages(() => import("./recruiting/RecruitingRoleTab")).then(
    (m) => m.RecruitingRoleTab,
  ),
);

import { useRecruitingWorkspace } from "./recruiting/useRecruitingWorkspace";
import type { Props } from "./recruiting/workspace-types";

export type {
  CandidateDiscussionContext,
  CandidateFeedback,
  CrmBrowseSelection,
  CrmReplyDraftContext,
} from "./recruiting/workspace-types";

import { Plural, Trans, useLingui } from "@lingui/react/macro";
import { Button, Tabs, TabsList, TabsTrigger } from "@rakazo/ui-web";
import { RefreshCw, X } from "lucide-react";

import { authClient } from "../lib/auth";
import type { RecruitingPanelState } from "../lib/right-panel-state";

import { RetryNotice } from "./recruiting/RetryNotice";
import { TabLoading } from "./recruiting/shared";

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

function RecruitingWorkspace(props: Props & { userId?: string }) {
  const { t } = useLingui();
  const model = useRecruitingWorkspace(props);
  const {
    onClose,
    presentation,
    summary,
    onTabChange,
    workspaceSnapshot,
    setRefresh,
    loading,
    failed,
    setCandidateList,
    activeTab,
    contactsView,
    shortlistView,
    tabsList,
    selection,
    candidatePage,
    candidateLoading,
    workspace,
  } = model;
  if (summary) return <RecruitingSummary model={model} />;

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
          {activeTab === "dashboard" ? <RecruitingSupplementaryTab model={model} /> : null}
          {activeTab === "role" ? <RecruitingRoleTab model={model} /> : null}
          <RecruitingEvidenceTab model={model} />
          {activeTab === "missing" ? <RecruitingSupplementaryTab model={model} /> : null}
          {activeTab === "memory" ? <RecruitingSupplementaryTab model={model} /> : null}
          {activeTab === "activity" ? <RecruitingSupplementaryTab model={model} /> : null}
        </Tabs>
      ) : null}
      {selection ? <CandidateDetailDialog model={model} /> : null}
    </section>
  );
}
