/** Synthetic signed-out and authenticated sessions; no live API or customer data. */
import { readFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { chromium } from "@playwright/test";
import { preview } from "vite";

const root = path.resolve(import.meta.dirname, "..");
const locale = process.env.MEASURE_UI_LOCALE;
const browser = await chromium.launch();
try {
  for (const directory of process.argv.slice(2)) {
    for (const authenticated of [false, true]) {
      const server = await preview({
        root,
        configFile: path.join(root, "vite.config.ts"),
        build: { outDir: path.resolve(directory) },
        preview: { port: 0, host: "127.0.0.1" },
        logLevel: "silent",
      });
      const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
      if (locale)
        await page.addInitScript(
          (value) => localStorage.setItem("rakazo.uiLocale", value),
          locale,
        );
      const requests: { url: string; type: string }[] = [];
      page.on("request", (req) =>
        requests.push({ url: new URL(req.url()).pathname, type: req.resourceType() }),
      );
      const user = {
        id: "synthetic-user",
        name: "Synthetic user",
        email: "benchmark@example.test",
        emailVerified: true,
      };
      const me = {
        userId: user.id,
        name: user.name,
        email: user.email,
        spaceId: "synthetic-space",
        isDeploymentOwner: false,
        ticketBoardEnabled: false,
        needsModel: false,
        billingEnabled: false,
        defaultProvider: "fake",
        defaultModel: "fake",
        hostCredentialProvider: null,
        hostCredentialSource: null,
        computerHost: null,
        canChooseHostComputer: false,
        sandboxProvider: "fake",
        avatarStyle: "shape",
      };
      const bot = {
        id: "synthetic-bot",
        spaceId: me.spaceId,
        name: "Synthetic assistant",
        title: "",
        description: "",
        instructions: "",
        color: "ink",
        pinned: false,
        sectionId: null,
        archivedAt: null,
        unread: false,
        parentBotId: null,
        threadId: "synthetic-thread",
        preview: "",
        status: "idle",
        notifyOnFinish: false,
        computerMode: "team",
        autoSpeak: false,
        voiceId: null,
      };
      const thread = {
        threadId: bot.threadId,
        botId: bot.id,
        cursor: 1,
        messages: [
          {
            id: "synthetic-message",
            threadId: bot.threadId,
            seq: 1,
            role: "bot",
            botId: bot.id,
            createdAt: "2026-01-01T00:00:00Z",
            blocks: [{ kind: "text", text: "Synthetic benchmark message." }],
          },
        ],
        olderCursor: null,
        run: null,
        computer: null,
        activeRuns: [],
      };
      const spaces = [
        {
          id: me.spaceId,
          name: "Synthetic workspace",
          hasContent: true,
          bots: [bot],
          groups: [],
          botSections: [],
        },
      ];
      const bootstrap = {
        me,
        bots: [bot],
        groups: [],
        botSections: [],
        archivedBots: [],
        archivedGroups: [],
        thread,
        routines: [],
        spaces,
      };
      await page.route("**/api/auth/get-session**", (route) =>
        route.fulfill({
          json: authenticated
            ? {
                user,
                session: {
                  id: "fake-session",
                  userId: user.id,
                  expiresAt: "2099-01-01T00:00:00Z",
                  token: "fake",
                },
              }
            : null,
        }),
      );
      await page.route("**/rpc/**", (route) => {
        const rpc = new URL(route.request().url()).pathname.slice(5);
        const values: Record<string, unknown> = {
          bootstrap,
          me,
          "threads/get": thread,
          "threads/messages": {
            threadId: thread.threadId,
            messages: thread.messages,
            olderCursor: null,
          },
          "spaces/list": { spaces, archivedSpaces: [] },
          "bots/list": [bot],
          "groups/list": [],
          "routines/list": [],
          "connections/list": [],
          "recruiting/getWorkspace": { role: null, revision: null },
          "recruiting/listRoles": { items: [], total: 0 },
          "voice/status": { available: false, enabled: false },
        };
        if (rpc.includes("subscribe"))
          return route.fulfill({ contentType: "text/event-stream", body: ": heartbeat\n\n" });
        return route.fulfill({ json: { json: values[rpc] ?? [] } });
      });
      await page.route("**/api/auth/capabilities", (route) =>
        route.fulfill({
          json: { passwordAuth: true, sso: null, passwordReset: false, resetUrl: null },
        }),
      );
      try {
        await page.goto(
          `http://127.0.0.1:${(server.httpServer.address() as AddressInfo).port}${authenticated ? "/app/synthetic-bot" : "/sign-in"}`,
        );
        if (authenticated)
          await page.getByText("Synthetic benchmark message.", { exact: true }).waitFor();
        else await page.locator('input[type="email"]').waitFor();
        await page.waitForTimeout(1000);
        const scripts = requests.filter((r) => r.type === "script");
        let gzipBytes = 0;
        for (const script of scripts) {
          gzipBytes += gzipSync(
            await readFile(path.join(path.resolve(directory), script.url)),
          ).length;
        }
        console.log(
          JSON.stringify(
            {
              directory: path.basename(directory),
              locale: locale ?? "application default",
              scope: authenticated
                ? "cold synthetic authenticated chat with one text message"
                : "cold signed-out sign-in page",
              gzipBytes,
              totalRequests: requests.length,
              scriptRequests: requests.filter((r) => r.type === "script").length,
              requests,
            },
            null,
            2,
          ),
        );
      } finally {
        await page.close();
        await server.close();
      }
    }
  }
} finally {
  await browser.close();
}
