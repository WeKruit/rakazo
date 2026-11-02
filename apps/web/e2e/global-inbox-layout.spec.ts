import { expect, test } from "@playwright/test";
import { inboxThreadKey } from "@rakazo/contracts";
import { accountItem, accountRolesData } from "./fixtures/recruiting-account-data";
import { mockRecruitingApp } from "./fixtures/recruiting-app-data";

for (const width of [1440, 390, 320]) {
  test(`global Inbox uses a compact thread list and selected detail at ${width}px`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width, height: width === 1440 ? 900 : 844 });
    const fixture = await mockRecruitingApp(page);
    const roles = accountRolesData();
    const items = roles.map((role, roleIndex) => {
      const item = accountItem(role, roleIndex);
      if (item.candidates)
        item.candidates.items = Array.from({ length: 3 }, (_, index) => ({
          key: `autumn:person-${roleIndex}-${index}`,
          name: ["Avery Example", "Blake Sample", "Morgan Chen"][index]!,
          title: roleIndex ? "Senior product designer" : "Staff platform engineer",
          location: index ? "Chicago, IL" : "Austin, TX",
          email: `candidate${roleIndex}${index}@example.test`,
          linkedinUrl: null,
          autumn: {
            candidateKey: `person-${roleIndex}-${index}`,
            score: 4,
            rank: index + 1,
            tier: "Strong",
            matchSummary: null,
            criteria: [],
            ranking: {
              source: "reviewer",
              state: "current",
              roleRevisionId: "revision",
              sourceEffectId: "review",
              grade: index ? "Promising" : "Strong",
              score: 4,
              group: index ? "worth_talking" : "strong_match",
            },
            savedProfile: {
              personKey: `person-${roleIndex}-${index}`,
              provider: "test",
              fetchedAt: "2026-10-30T00:00:00Z",
              headline: "Engineer",
              profileImageUrl: "https://assets.example.test/profile-photo.svg",
              experience: [0, 1].map((job) => ({
                title: job ? "Software engineer" : "Senior engineer",
                company_name: job ? "Example Systems" : "Example Labs",
                start_date: job ? "2020" : "2024",
                end_date: job ? "2024" : null,
                is_current: !job,
                company_url: null,
                company_linkedin_url: null,
                company_logo_url: null,
                company_industry: null,
                company_size: null,
                location: null,
                description: null,
              })),
              education: [
                {
                  school_name: "Example University",
                  degree: "BS Computer Science",
                  field_of_study: null,
                  school_url: null,
                  school_logo_url: null,
                  start_date: null,
                  end_date: "2020",
                },
              ],
            },
          },
          crm: null,
          shortlisted: false,
          shortlistedAt: null,
        }));
      if (item.correspondence) {
        item.correspondence.emails = Array.from({ length: 3 }, (_, index) => ({
          id: `mail-${roleIndex}-${index}`,
          sourceId: `source-${roleIndex}`,
          sourceName: roleIndex ? "Team mail" : "Work mail",
          providerMessageId: `provider-${roleIndex}-${index}`,
          providerThreadId: `thread-${index}`,
          campaignId: null,
          eaccount: roleIndex ? "team@example.test" : "recruiter@example.test",
          savedRead: null,
          direction: "received",
          sender: `${["Avery Example", "Blake Sample", "Morgan Chen"][index]} <candidate${roleIndex}${index}@example.test>`,
          recipients: ["recruiter@example.test"],
          subject: [
            "Interview availability",
            "A question about the platform team",
            "Experience and portfolio — 分布式系统与平台工程",
          ][index]!,
          body: `Hello,\n\n${index ? "Thanks for sharing the role. I would like to hear more about the team and scope." : "Tuesday afternoon works for me. Please let me know which time suits the team."}\n\n${"Here is some additional context about my experience. ".repeat(12)}\n\nBest,\nCandidate`,
          snippet: false,
          date: `2026-10-${30 - index}T12:00:00Z`,
          url: null,
        }));
      }
      return item;
    });
    const readAt = new Map<string, string>();
    await page.route("**/rpc/recruiting/**", async (route) => {
      const method = new URL(route.request().url()).pathname.split("/").at(-1);
      const input = route.request().postDataJSON()?.json ?? {};
      if (method === "globalInbox") {
        const rows = items.flatMap((item) =>
          (item.correspondence?.emails ?? []).map((email) => ({
            roleId: item.roleId,
            key: inboxThreadKey({
              sourceId: email.sourceId,
              organizationId: email.crm?.organizationId ?? null,
              mailbox: email.eaccount!,
              threadId: email.providerThreadId!,
            }),
            email,
            latestIncomingAt: email.date,
            person:
              item.candidates?.items.find((person) =>
                email.sender?.includes(`<${person.email}>`),
              ) ?? null,
          })),
        );
        const matching = rows.filter(
          (row) =>
            (!input.roleId || row.roleId === input.roleId) &&
            (!input.thread ||
              (row.roleId === input.thread.roleId && row.key === input.thread.key)) &&
            (!input.query ||
              [row.email.subject, row.email.sender, row.email.body].some((value) =>
                value?.toLowerCase().includes(String(input.query).toLowerCase()),
              )),
        );
        return route.fulfill({
          json: {
            json: {
              roles,
              items: matching.slice(0, input.limit ?? 30),
              nextCursor: null,
              unread: {
                count: rows.filter((row) => !readAt.has(row.key)).length,
                unknownThreads: 0,
                scope: "indexed_stored_mail",
              },
              coverage: {
                importsComplete: true,
                crmComplete: true,
                native: "observed",
                providerComplete: false,
                checkedAt: "2026-11-01T00:00:00Z",
              },
            },
          },
        });
      }
      if (method === "accountView")
        return route.fulfill({
          json: {
            json: {
              roles,
              items: input.roleId ? items.filter((item) => item.roleId === input.roleId) : items,
              nextCursor: null,
            },
          },
        });
      if (method === "inboxReadState")
        return route.fulfill({
          json: {
            json: {
              initializedAt: "2026-10-01T00:00:00Z",
              items: input.threads.flatMap((thread: Parameters<typeof inboxThreadKey>[0]) =>
                readAt.has(inboxThreadKey(thread))
                  ? [
                      {
                        key: inboxThreadKey(thread),
                        lastReadAt: readAt.get(inboxThreadKey(thread)),
                        unread: false,
                      },
                    ]
                  : [],
              ),
            },
          },
        });
      if (method === "markInboxThread") {
        readAt.set(inboxThreadKey(input.thread), input.observedIncomingAt);
        return route.fulfill({ json: { json: { ok: true } } });
      }
      return route.fallback();
    });
    await page.goto("/app?view=inbox&role=all");
    const inbox = page.getByTestId("account-inbox");
    const rail = inbox.getByRole("region", { name: "Inbox conversations" });
    const detail = inbox.getByTestId("email-conversation");
    await expect(inbox).toBeVisible();
    await expect(
      inbox.getByRole("list", { name: "Email threads" }).getByRole("button"),
    ).toHaveCount(6);
    await expect(rail).toBeVisible();
    await expect(rail).toContainText("Strong Match");
    await expect(rail).toContainText("Example University");
    if (width < 1024) await expect(detail).not.toBeVisible();
    else {
      await expect(detail).toBeVisible();
      const railBox = await rail.boundingBox();
      const detailBox = await detail.boundingBox();
      expect(detailBox!.x).toBeGreaterThan(railBox!.x + railBox!.width - 1);
    }
    await page.screenshot({
      path: testInfo.outputPath(`global-inbox-${width}.png`),
      fullPage: true,
    });
    await testInfo.attach(`global-inbox-${width}`, {
      path: testInfo.outputPath(`global-inbox-${width}.png`),
      contentType: "image/png",
    });
    await inbox.getByRole("button", { name: /Blake Sample.*Product Designer/ }).click();
    await expect(detail).toBeVisible();
    await expect(detail).toContainText("candidate11@example.test");
    await expect(detail).not.toContainText("candidate00@example.test");
    if (width < 1024) await expect(rail).not.toBeVisible();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      ),
    ).toBe(0);
    await page.screenshot({
      path: testInfo.outputPath(`global-inbox-detail-${width}.png`),
      fullPage: true,
    });
    await testInfo.attach(`global-inbox-detail-${width}`, {
      path: testInfo.outputPath(`global-inbox-detail-${width}.png`),
      contentType: "image/png",
    });
    if (width < 1024) {
      await inbox.getByRole("button", { name: "Back to inbox", exact: true }).click();
      await expect(rail).toBeVisible();
      await expect(detail).not.toBeVisible();
    }
    expect(fixture.unknown).toEqual([]);
  });
}
