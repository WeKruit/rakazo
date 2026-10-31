# Left navigation, global view and global chat

Status: diagnosis and work plan. No product code changed yet.

## What recruiters see

- **Sequence** on a role whose Shortlist has people shows "No candidate records for this role yet." and "Recruiter messages are unavailable for this role."
- **Interview** shows "Calendar records have not been checked yet." and "Google Calendar · Needs connection", with no calendar.
- **Job Brief, Client feedback, Shortlist, Contacts, Sequence, Inbox, Interview, Recruiting workflow** all act on the role that happens to be open. Nothing works across roles, and there is no role picker.
- There is no place to ask across roles "which interviews are coming up", "who did I shortlist this week" or "how many people replied to my emails".
- Routines and tasks have no entry in the recruiting UI.

## Root causes (checked against main 612d870)

1. **Sequence, Interview, Inbox and Contacts history only read the legacy CRM binding.**
   `useRoleCrm` (`apps/web/src/pages/recruiting/shared.tsx`) returns `unbound` when the role's
   workspace has no `crmTarget`, and `CrmGate` turns `unbound` into "No candidate records for this
   role yet." Roles created in the product (chat → people search → Shortlist → agent-created email
   campaign) are never bound to a CRM role, so these tabs are empty even though the role has people,
   saved contact emails and a live campaign. The copy is also wrong: the role has candidates.
2. **Interview never reads a calendar.** `rpc.recruiting.correspondence({view:"interview"})`
   (`apps/api/src/recruiting.ts`, `correspondenceProvider`) only parses receipts of calendar tool
   calls an agent already made in this role's thread. If no agent called `list_events` /
   `get_bookings` there, the status is `not_checked` forever. Bookings made through
   `recruiting_scheduling` plans are not merged into the calendar view.
3. **Every left-nav view is role-scoped.** `RecruitingWorkspaceView` views render the current
   group's workspace; `canOpenDashboard` disables them without an open role. "Recruiting workflow"
   opens the current role's Results → Dashboard tab, so it duplicates Results and is not a
   workflow.
4. **No global agent.** Each role is a group with its own Main and specialists. Home
   (`HomeDashboard.tsx`) is a dashboard with no chat and fans out several reads per role. The agent
   tools (`packages/adapters/src/builtin-tools.ts`) are current-role scoped: only
   `recruiting_candidates resolve` searches across roles. There is no cross-role tool for upcoming
   interviews, shortlist, replies or campaign stats, and `recruiting_candidates replies` returns
   `not_bound` for product roles.
5. **Routines and tasks are developer-only.** Routines live in the "Agent computer" panel, shown
   only when `showToolActivity` is on and the conversation is not a group; every recruiting role is
   a group. The Board needs `showToolActivity` plus `ticketBoardEnabled`.

## Why it came back after earlier fixes

The October 23–24 work (#84 unified workspace, "Make calendar and sequence primary workspace
surfaces", "show saved sequence numbers and sequences without a role") was built and checked on
roles imported from the legacy CRM. Product-created roles were never on the test path.
`apps/web/e2e/recruiting-app-routes.spec.ts` uses a CRM-bound fixture and even asserts that
"Recruiter messages are unavailable for this role." is visible, so the empty state is locked in as
expected behavior. No e2e test creates a role through chat and then opens each left-nav page.

The standard that applies is AGENTS.md principle 8 (prove the user workflow through the real path)
and the project rule that tests go through the real user path: a page counts as done only when a
role created through ordinary chat shows its real records there.

## Plan

See the handoff prompt on the pull request. Summary:

- A. One source per page that works for product roles and CRM roles alike (product campaign +
  saved contacts for Sequence/Inbox, scheduling plans + connected calendar read for Interview),
  with honest empty states.
- B. Global views: each left-nav page opens across all roles with a role picker (All roles / one
  role), URL-addressable, instead of requiring a role click first.
- C. Global chat: one account-level Main conversation reachable from Home that answers cross-role
  questions and hands off to a role's own crew for role work, plus cross-role read tools through
  the existing `ToolHost`.
- D. Routines and reminders reachable from the recruiting UI for ordinary users.
- E. Decide "Recruiting workflow": remove it or make it the cross-role pipeline view.
- F. Real-user-path e2e for every page, on an isolated test account, never on real customer roles.
