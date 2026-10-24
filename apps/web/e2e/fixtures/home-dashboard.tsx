import { I18nProvider } from "@lingui/react";
import type { Group } from "@rakazo/contracts";
import { createRoot } from "react-dom/client";
import { bootstrapI18n, i18n } from "../../src/lib/i18n";
import { applyUiAppearance } from "../../src/lib/ui-appearance";
import { HomeDashboard } from "../../src/pages/recruiting/HomeDashboard";
import "../../src/styles.css";

// Local synthetic records only. No application or provider requests leave this fixture.
const groups = [
  {
    id: "g1",
    threadId: "thread-g1",
    name: "Staff Platform Engineer",
    updatedAt: "2026-10-23T09:00:00Z",
    archivedAt: null,
  },
  {
    id: "g2",
    threadId: "thread-g2",
    name: "Product Design Lead · International Customer Experience and Research",
    updatedAt: "2026-10-22T09:00:00Z",
    archivedAt: null,
  },
] as Group[];
const date = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString();
const requests: string[] = [];
const state = { requests, opened: "" };
Object.assign(window, { homeDashboardFixture: state });
const realFetch = window.fetch.bind(window);
window.fetch = async (input, init) => {
  const url = input instanceof Request ? input.url : String(input);
  if (!url.includes("/rpc/")) return realFetch(input, init);
  const request =
    input instanceof Request ? input : new Request(new URL(url, location.origin), init);
  const path = new URL(request.url).pathname.replace(/^\/rpc\//, "");
  const { json: value = {} } = (await request.clone().json()) as { json?: Record<string, unknown> };
  requests.push(path);
  let result: unknown;
  if (path === "recruiting/getWorkspace") result = { role: { id: `role-${value.threadId}` } };
  else if (path === "recruiting/listCandidates") {
    const days = value.roleId === "role-thread-g1" ? [0, 2, 8, 20, 42, null] : [3, 11, 27, 35, 55];
    result = {
      items: days.map((day) => ({
        shortlisted: true,
        shortlistedAt: day === null ? null : date(day),
      })),
      total: days.length,
      nextCursor: null,
    };
  } else if (path === "recruiting/roleCandidates")
    result = {
      items: [],
      total: 0,
      counts: { replied: value.threadId === "thread-g1" ? 2 : 1 },
      crmStatus: "ok",
      nextCursor: null,
    };
  else if (path === "recruiting/roleCampaign")
    result =
      value.groupId === "g1"
        ? {
            status: "ready",
            campaign: { id: "fixture-campaign", status: 1 },
            leads: [
              { candidateKey: null, email: "first@example.test", status: 1, interestStatus: null },
              { candidateKey: null, email: "second@example.test", status: 3, interestStatus: 2 },
            ],
          }
        : { status: "none", campaign: null, leads: [] };
  else if (path === "recruiting/reminders/list")
    result = {
      items: [
        {
          id: "task-1",
          roleId: "role-thread-g1",
          title: "Review the platform shortlist",
          dueAt: date(-1),
          status: "open",
        },
        {
          id: "task-2",
          roleId: "role-thread-g2",
          title: "Prepare design interview questions",
          dueAt: date(1),
          status: "open",
        },
      ],
      overdueCount: 1,
    };
  else if (path === "recruiting/reminders/update") result = { id: value.id, status: "done" };
  else throw new Error(`Unexpected fixture request: ${path}`);
  return new Response(JSON.stringify({ json: result }), {
    headers: { "content-type": "application/json" },
  });
};
applyUiAppearance("light");
void bootstrapI18n("en").then(() =>
  createRoot(document.getElementById("root")!).render(
    <I18nProvider i18n={i18n}>
      <main className="flex h-dvh min-w-0 bg-background text-foreground">
        <HomeDashboard
          userName="Jordan Example"
          groups={groups}
          readCacheScope="fixture-account"
          onOpenRole={(id) => {
            state.opened = id;
          }}
        />
      </main>
    </I18nProvider>,
  ),
);
