import type {
  MemoryDocument,
  ReadRecruitingSourceInput,
  RecruitingCandidate,
  RecruitingCandidateFeedbackSelection,
  RecruitingCrmDataInput,
} from "@rakazo/contracts";
import type { ReactNode } from "react";
import type { RecruitingReadCache } from "../../lib/recruiting-read-cache";
import type { RecruitingPanelState } from "../../lib/right-panel-state";
import type { rpc } from "../../lib/rpc";
import type { ShortlistWeekFilter } from "../recruiting/dashboard-drilldown";
import type { SchedulingPlanHandoff } from "../recruiting/SchedulingPlan";
import type { RecruitingWorkspaceView } from "../shell/RecruitingNavigation";

export type CrmBrowseSelection = Pick<
  Extract<RecruitingCrmDataInput, { operation: "candidates" }>,
  "serverId" | "serverRevision" | "organizationId" | "crmRoleId"
>;

export type CrmReplyDraftContext = {
  threadId: string;
  candidateId: string;
  candidateName?: string;
  candidateEmail?: string | null;
  email: {
    sender: string | null;
    recipients: string[];
    subject: string | null;
    date: string | null;
  };
  source: { serverId: string; serverRevision: number; organizationId: string };
  crmRoleId?: string;
};

export type CandidateDiscussionContext = Pick<
  RecruitingCandidate,
  "name" | "title" | "company" | "linkedinUrl" | "resumeUrl"
> & {
  threadId: string;
  roleTitle: string;
  roleVersion?: number;
  roleId?: string;
  roleRevisionId?: string;
  candidateKey?: string;
  candidateRevision?: number;
  intent?: "email_draft" | "contact_lookup";
};

export type CandidateFeedback = {
  choice: RecruitingCandidateFeedbackSelection["choice"];
  reason: string;
  recipientBotId?: string;
};

export type RecruitingWorkspaceRead = {
  threadId: string;
  refreshSignal: number;
  workspace?: Awaited<ReturnType<typeof rpc.recruiting.getWorkspace>>;
};

export type Props = {
  /** Fresh only for the Shell navigation and refresh generation that performed the read. */
  workspaceRead?: RecruitingWorkspaceRead;
  shortlistWeekFilter?: ShortlistWeekFilter;
  onClearShortlistWeekFilter?: () => void;
  onReviewSchedulingPlan?: (handoff: SchedulingPlanHandoff) => void;
  /** The thread is this CRM role's own conversation, so its agent results share the workbench. */
  roleConversation?: boolean;
  /** The role conversation's own Sequence, Inbox or Interview view, shown above its CRM history. */
  correspondence?: ReactNode;
  crmBrowse?: {
    selection: CrmBrowseSelection;
    view: RecruitingWorkspaceView;
    candidateId?: string;
    onSelectCandidate: (id: string, view?: RecruitingWorkspaceView) => void;
    onStartRecruiting?: (description: string) => void;
    onDraftReply?: (context: CrmReplyDraftContext) => void;
  };
  threadId: string;
  botId?: string;
  groupId?: string;
  readCache?: RecruitingReadCache;
  readCacheScope?: string;
  refreshSignal?: number;
  onClose: () => void;
  onBrowseCandidates?: () => void;
  showDiagnostics?: boolean;
  presentation?: "panel" | "workspace";
  summary?: "brief" | "feedback";
  view?: "results" | "shortlist" | "contacts";
  tab?: RecruitingPanelState["tab"];
  onTabChange?: (tab: RecruitingPanelState["tab"]) => void;
  onRevealMessage?: (target: { botId?: string; groupId?: string; messageId: string }) => void;
  onDiscussCandidate?: (candidate: CandidateDiscussionContext) => void;
  candidateFeedbackRecipients?: { id: string; name: string }[];
  onCandidateFeedback?: (
    candidate: CandidateDiscussionContext,
    feedback: CandidateFeedback,
    clientNonce: string,
  ) => Promise<boolean>;
};
export type SourceReadTarget =
  | Omit<Extract<ReadRecruitingSourceInput, { kind: "role" }>, "sourceRefId">
  | Omit<Extract<ReadRecruitingSourceInput, { kind: "assessment" }>, "sourceRefId">;
export type SourceContent = Awaited<ReturnType<typeof rpc.recruiting.readSource>>;
export type Snapshot = {
  workspace: Awaited<ReturnType<typeof rpc.recruiting.getWorkspace>>;
  assessments: Awaited<ReturnType<typeof rpc.recruiting.listAssessments>>;
  research: Awaited<ReturnType<typeof rpc.recruiting.listResearch>>;
  questions: Awaited<ReturnType<typeof rpc.recruiting.listQuestions>>["questions"];
  documents: MemoryDocument[];
};
