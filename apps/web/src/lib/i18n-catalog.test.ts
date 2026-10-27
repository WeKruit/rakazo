import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { transformSync } from "@babel/core";
import linguiMacro from "@lingui/babel-plugin-lingui-macro";
import { createCompiledCatalog, getCatalogs } from "@lingui/cli/api";
import { getConfig } from "@lingui/conf";
import { i18n } from "@lingui/core";
import { beforeEach, describe, expect, it } from "vitest";
import de from "../../scripts/translations-de.json";
import es from "../../scripts/translations-es.json";
import hi from "../../scripts/translations-hi.json";
import ko from "../../scripts/translations-ko.json";
import ptBR from "../../scripts/translations-pt-BR.json";
import tr from "../../scripts/translations-tr.json";
import zhCN from "../../scripts/translations-zh-CN.json";

// The product is translated to Chinese; other locales fall back to English.
const ZH_RECRUITING: Record<string, string> = {
  "Match score": "匹配分数",
  "Stop {name}": "停止 Synthetic agent",
};

describe("lingui catalogs", () => {
  beforeEach(() => {
    i18n.load("en", {});
    i18n.activate("en");
  });

  it("resolves every compiled artifact-card label from production catalogs", async () => {
    const config = getConfig({
      configPath: fileURLToPath(new URL("../../lingui.config.ts", import.meta.url)),
    });
    const component = fileURLToPath(new URL("../components/ArtifactFileCard.tsx", import.meta.url));
    const compiled = transformSync(readFileSync(component, "utf8"), {
      filename: component,
      babelrc: false,
      configFile: false,
      parserOpts: { plugins: ["typescript", "jsx"] },
      plugins: [[linguiMacro, { linguiConfig: config }]],
    });
    const ids = [...new Set([...compiled!.code!.matchAll(/\bid:\s*"([^"]+)"/g)].map((m) => m[1]!))];
    expect(ids.length).toBeGreaterThan(5);
    const [catalog] = await getCatalogs(config);
    for (const locale of config.locales) {
      const { messages } = await catalog!.getTranslations(locale, config);
      for (const id of ids) expect(messages[id], `${locale} ${id}`).toBeDefined();
      const result = createCompiledCatalog(
        locale,
        Object.fromEntries(ids.map((id) => [id, messages[id]!])),
        { namespace: "json", strict: true },
      );
      expect(result.errors).toEqual([]);
      i18n.load(locale, JSON.parse(result.source).messages);
      i18n.activate(locale);
      for (const id of ids)
        expect(
          i18n._({ id, values: { 0: "Job description", name: "Job description" } }),
          locale,
        ).not.toBe(id);
    }
  });

  it("compiles recruiter workspace labels in every production locale without source descriptors", async () => {
    const config = getConfig({
      configPath: fileURLToPath(new URL("../../lingui.config.ts", import.meta.url)),
    });
    const [catalog] = await getCatalogs(config);
    const source = await catalog!.read("en");
    const labels = [
      "Recruiting workspace",
      "WeKruit home",
      "All roles",
      "New Role",
      "Job Brief",
      "Client feedback",
      "Shortlist",
      "Contacts",
      "Sequence",
      "Inbox",
      "Interview",
      "Recruiting workflow",
      "Subject",
      "Save draft",
      "Recipients",
      "Search roles",
      "Role conversations",
      "Unread",
      "Collapse navigation",
      "Show navigation",
      "Hide navigation",
    ];
    const entries = labels.map((label) => {
      const entry = Object.entries(source ?? {}).find(([, entry]) => entry.message === label);
      expect(entry, label).toBeDefined();
      return entry!;
    });
    expect(Object.fromEntries(entries.map(([id, entry]) => [id, entry.message]))).toMatchObject({
      pzfKRn: "Search roles",
      ipQKNM: "Sequence",
    });
    for (const locale of config.locales) {
      const { messages } = await catalog!.getTranslations(locale, config);
      const compiled = createCompiledCatalog(locale, messages, { namespace: "json", strict: true });
      expect(compiled.errors).toEqual([]);
      i18n.load(locale, JSON.parse(compiled.source).messages);
      i18n.activate(locale);
      for (const [id, entry] of entries) {
        const rendered = i18n._({ id });
        expect(rendered, `${locale} ${entry.message}`).not.toBe(id);
        expect(rendered, `${locale} ${entry.message}`).not.toBe("");
        if (locale === "en") expect(rendered).toBe(entry.message);
      }
    }
  });

  it("resolves the actual recruiting workspace component messages in production catalogs", async () => {
    const config = getConfig({
      configPath: fileURLToPath(new URL("../../lingui.config.ts", import.meta.url)),
    });
    const ids = new Set<string>();
    for (const path of [
      "../pages/shell/RecruitingNavigation.tsx",
      "../pages/RecruitingCorrespondence.tsx",
      "../pages/GroupPanel.tsx",
      "../pages/Shell.tsx",
      "../pages/RecruitingPanel.tsx",
      "../pages/shell/ShellSidebar.tsx",
      "../pages/shell/ShellConversation.tsx",
      "../pages/shell/ShellOverlays.tsx",
      "../pages/shell/Composer.tsx",
      "../pages/shell/Transcript.tsx",
      "../pages/shell/useShellController.tsx",
      "../pages/recruiting/CandidateFeedback.tsx",
      "../pages/recruiting/CandidatePresentation.tsx",
      "../pages/recruiting/CriteriaEditor.tsx",
      "../pages/recruiting/CrmWorkbench.tsx",
      "../pages/recruiting/SourceDocuments.tsx",
      "../pages/recruiting/VerdictLabel.tsx",
      "../pages/recruiting/RecruitingRoleTab.tsx",
      "../pages/recruiting/RecruitingEvidenceTab.tsx",
      "../pages/recruiting/useRecruitingWorkspace.ts",
      "../pages/shell/useShellComputer.ts",
      "../pages/shell/useShellRoster.ts",
      "../pages/shell/useShellMessages.ts",
      "../pages/shell/useShellThreads.ts",
      "../pages/shell/useShellRecruiting.ts",
      "../pages/shell/useShellAgentActions.ts",
      "../pages/shell/useShellCreation.ts",
      "../pages/shell/useShellNotifications.ts",
      "../pages/shell/useShellRecruitingRefresh.ts",
    ]) {
      const filename = fileURLToPath(new URL(path, import.meta.url));
      const compiled = transformSync(readFileSync(filename, "utf8"), {
        filename,
        babelrc: false,
        configFile: false,
        parserOpts: { plugins: ["typescript", "jsx"] },
        plugins: [[linguiMacro, { linguiConfig: config }]],
      });
      for (const match of compiled!.code!.matchAll(/\/\*\*\s*i18n\s*\*\/\s*\{\s*id:\s*"([^"]+)"/g))
        ids.add(match[1]!);
    }
    expect(ids.size).toBeGreaterThan(40);
    expect(ids.has("liuegf")).toBe(true);
    const [catalog] = await getCatalogs(config);
    for (const locale of config.locales) {
      const { messages } = await catalog!.getTranslations(locale, config);
      for (const id of ids) expect(messages[id], `${locale} ${id}`).toBeDefined();
      const compiled = createCompiledCatalog(
        locale,
        Object.fromEntries([...ids].map((id) => [id, messages[id]!])),
        { namespace: "json", strict: true },
      );
      expect(compiled.errors).toEqual([]);
      i18n.load(locale, JSON.parse(compiled.source).messages);
      i18n.activate(locale);
      for (const id of ids)
        expect(i18n._({ id, values: { 0: 1, name: "Draft" } }), `${locale} ${id}`).not.toBe(id);
    }
  });

  it("compiles match-score and member-stop labels without source-message descriptors", async () => {
    const config = getConfig({
      configPath: fileURLToPath(new URL("../../lingui.config.ts", import.meta.url)),
    });
    const [catalog] = await getCatalogs(config);
    const source = await catalog!.read("en");
    const entries = ["Match score", "Stop {name}"].map((message) => {
      const entry = Object.entries(source ?? {}).find(([, entry]) => entry.message === message);
      expect(entry, message).toBeDefined();
      return entry!;
    });
    for (const locale of config.locales) {
      const { messages } = await catalog!.getTranslations(locale, config);
      const compiled = createCompiledCatalog(
        locale,
        Object.fromEntries(entries.map(([id]) => [id, messages[id]!])),
        { namespace: "json", strict: true },
      );
      expect(compiled.errors).toEqual([]);
      i18n.load(locale, JSON.parse(compiled.source).messages);
      i18n.activate(locale);
      for (const [id, entry] of entries)
        expect(i18n._({ id, values: { name: "Synthetic agent" } }), locale).toBe(
          (locale === "zh-CN" ? ZH_RECRUITING[entry.message!] : undefined) ??
            entry.message?.replaceAll("{name}", "Synthetic agent"),
        );
    }
  });

  it("compiles Recruiting messages for production without source-message descriptors", async () => {
    const config = getConfig({
      configPath: fileURLToPath(new URL("../../lingui.config.ts", import.meta.url)),
    });
    const [catalog] = await getCatalogs(config);
    const source = await catalog!.read("en");
    const entries = Object.entries(source ?? {}).filter(([, entry]) =>
      entry.origin?.some(([path]) => path === "src/pages/RecruitingPanel.tsx"),
    );
    expect(entries.length).toBeGreaterThan(30);
    for (const message of [
      "Open original question",
      "Cards",
      "Table",
      "Candidate",
      "Raw search results",
      "No saved result rows",
      "Could not load search results",
    ])
      expect(
        entries.some(([, entry]) => entry.message === message),
        message,
      ).toBe(true);
    for (const locale of config.locales) {
      const { messages } = await catalog!.getTranslations(locale, config);
      const compiled = createCompiledCatalog(locale, messages, { namespace: "json", strict: true });
      expect(compiled.errors).toEqual([]);
      i18n.load(locale, JSON.parse(compiled.source).messages);
      i18n.activate(locale);
      expect(i18n._({ id: "bn0SqF" }), locale).toBe(locale === "zh-CN" ? "招聘" : "Recruiting");
      for (const [id, entry] of entries) {
        const values = Object.fromEntries(
          [...(entry.message ?? "").matchAll(/\{(\w+)\}/g)].map(([, name]) => [name, "2"]),
        );
        const rendered = i18n._({ id, values: { 0: 2, count: 2, ...values } });
        expect(rendered, `${locale} ${id}`).not.toBe(id);
        // Plural messages are rendered by ICU; the candidate-count test checks their grammar.
        if (locale === "en" && !entry.message?.includes(", plural,"))
          expect(rendered, id).toBe(entry.message?.replaceAll(/\{\w+\}/g, "2"));
      }
    }
  });

  it("compiles candidate counts with English fallback grammar in every other locale", async () => {
    const config = getConfig({
      configPath: fileURLToPath(new URL("../../lingui.config.ts", import.meta.url)),
    });
    const [catalog] = await getCatalogs(config);
    const source = await catalog!.read("en");
    const candidateCountId = Object.entries(source ?? {}).find(
      ([, entry]) =>
        entry.origin?.some(([path]) => path === "src/pages/RecruitingPanel.tsx") &&
        entry.message === "{0, plural, =1 {# candidate} other {# candidates}}",
    )?.[0];
    expect(candidateCountId).toBeDefined();
    for (const locale of config.locales) {
      const { messages } = await catalog!.getTranslations(locale, config);
      const compiled = createCompiledCatalog(
        locale,
        { [candidateCountId!]: messages[candidateCountId!]! },
        { namespace: "json", strict: true },
      );
      expect(compiled.errors).toEqual([]);
      i18n.load(locale, JSON.parse(compiled.source).messages);
      i18n.activate(locale);
      for (const count of [0, 1, 2])
        expect(i18n._({ id: candidateCountId!, values: { 0: count } }), `${locale}: ${count}`).toBe(
          locale === "zh-CN" ? `${count} 位候选人` : `${count} candidate${count === 1 ? "" : "s"}`,
        );
    }
  });

  it("falls back to the English source message when a translation is missing", () => {
    i18n.load("de", {});
    i18n.activate("de");
    expect(i18n._({ id: "Settings", message: "Settings" })).toBe("Settings");
    expect(
      i18n._({
        id: "Cancel new bot",
        message: "Cancel new bot",
      }),
    ).toBe("Cancel new bot");
  });

  it("formats ICU cron-style messages with reordered placeholders", () => {
    i18n.load("de", {
      "every {intervalAmountSelect} {intervalUnitSelect}":
        "alle {intervalAmountSelect} {intervalUnitSelect}",
      "at {timeSelect}": "um {timeSelect}",
    });
    i18n.activate("de");
    expect(
      i18n._({
        id: "every {intervalAmountSelect} {intervalUnitSelect}",
        message: "every {intervalAmountSelect} {intervalUnitSelect}",
        values: { intervalAmountSelect: "5", intervalUnitSelect: "minutes" },
      }),
    ).toBe("alle 5 minutes");
    expect(
      i18n._({
        id: "at {timeSelect}",
        message: "at {timeSelect}",
        values: { timeSelect: "9:00 AM" },
      }),
    ).toBe("um 9:00 AM");

    i18n.load("ko", {
      "every {intervalAmountSelect} {intervalUnitSelect}":
        "{intervalAmountSelect} {intervalUnitSelect}마다",
      "at {timeSelect}": "{timeSelect}에",
    });
    i18n.activate("ko");
    expect(
      i18n._({
        id: "every {intervalAmountSelect} {intervalUnitSelect}",
        message: "every {intervalAmountSelect} {intervalUnitSelect}",
        values: { intervalAmountSelect: "5", intervalUnitSelect: "분" },
      }),
    ).toBe("5 분마다");

    i18n.load("tr", {
      "every {intervalAmountSelect} {intervalUnitSelect}":
        "her {intervalAmountSelect} {intervalUnitSelect}",
      "at {timeSelect}": "saat {timeSelect}",
    });
    i18n.activate("tr");
    expect(
      i18n._({
        id: "every {intervalAmountSelect} {intervalUnitSelect}",
        message: "every {intervalAmountSelect} {intervalUnitSelect}",
        values: { intervalAmountSelect: "5", intervalUnitSelect: "dakika" },
      }),
    ).toBe("her 5 dakika");
    expect(
      i18n._({
        id: "at {timeSelect}",
        message: "at {timeSelect}",
        values: { timeSelect: "09:00" },
      }),
    ).toBe("saat 09:00");

    i18n.load("hi", {
      "every {intervalAmountSelect} {intervalUnitSelect}":
        "हर {intervalAmountSelect} {intervalUnitSelect}",
      "at {timeSelect}": "{timeSelect} बजे",
    });
    i18n.activate("hi");
    expect(
      i18n._({
        id: "every {intervalAmountSelect} {intervalUnitSelect}",
        message: "every {intervalAmountSelect} {intervalUnitSelect}",
        values: { intervalAmountSelect: "5", intervalUnitSelect: "मिनट" },
      }),
    ).toBe("हर 5 मिनट");
    expect(
      i18n._({
        id: "at {timeSelect}",
        message: "at {timeSelect}",
        values: { timeSelect: "09:00" },
      }),
    ).toBe("09:00 बजे");

    i18n.load("zh-CN", {
      "every {intervalAmountSelect} {intervalUnitSelect}":
        "每 {intervalAmountSelect} {intervalUnitSelect}",
      "at {timeSelect}": "{timeSelect}",
      "{0, plural, one {# model} other {# models}}": "{0, plural, one {# 个模型} other {# 个模型}}",
      "{botName} · {0, plural, one {# peer} other {# peers}}":
        "{botName} · {0, plural, one {# 个同事 Bot} other {# 个同事 Bot}}",
    });
    i18n.activate("zh-CN");
    expect(
      i18n._({
        id: "every {intervalAmountSelect} {intervalUnitSelect}",
        message: "every {intervalAmountSelect} {intervalUnitSelect}",
        values: { intervalAmountSelect: "5", intervalUnitSelect: "分钟" },
      }),
    ).toBe("每 5 分钟");
    expect(
      i18n._({
        id: "at {timeSelect}",
        message: "at {timeSelect}",
        values: { timeSelect: "09:00" },
      }),
    ).toBe("09:00");
    expect(
      i18n._({
        id: "{0, plural, one {# model} other {# models}}",
        message: "{0, plural, one {# model} other {# models}}",
        values: { 0: 1 },
      }),
    ).toBe("1 个模型");
    expect(
      i18n._({
        id: "{0, plural, one {# model} other {# models}}",
        message: "{0, plural, one {# model} other {# models}}",
        values: { 0: 3 },
      }),
    ).toBe("3 个模型");
    expect(
      i18n._({
        id: "{botName} · {0, plural, one {# peer} other {# peers}}",
        message: "{botName} · {0, plural, one {# peer} other {# peers}}",
        values: { botName: "Scout", 0: 2 },
      }),
    ).toBe("Scout · 2 个同事 Bot");

    i18n.load("es", {
      "every {intervalAmountSelect} {intervalUnitSelect}":
        "cada {intervalAmountSelect} {intervalUnitSelect}",
      "at {timeSelect}": "a las {timeSelect}",
    });
    i18n.activate("es");
    expect(
      i18n._({
        id: "every {intervalAmountSelect} {intervalUnitSelect}",
        message: "every {intervalAmountSelect} {intervalUnitSelect}",
        values: { intervalAmountSelect: "5", intervalUnitSelect: "minutos" },
      }),
    ).toBe("cada 5 minutos");
    expect(
      i18n._({
        id: "at {timeSelect}",
        message: "at {timeSelect}",
        values: { timeSelect: "09:00" },
      }),
    ).toBe("a las 09:00");
  });

  it("uses seeded catalog strings for German, Korean, Turkish, Hindi, Brazilian Portuguese, Simplified Chinese, and Spanish chrome", () => {
    i18n.load("de", de as Record<string, string>);
    i18n.activate("de");
    expect(i18n._({ id: "Settings", message: "Settings" })).toBe("Einstellungen");
    expect(i18n._({ id: "Cancel", message: "Cancel" })).toBe("Abbrechen");
    expect(i18n._({ id: "Search", message: "Search" })).toBe("Suchen");
    expect(i18n._({ id: "To:", message: "To:" })).toBe("An:");

    i18n.load("ko", ko as Record<string, string>);
    i18n.activate("ko");
    expect(i18n._({ id: "Settings", message: "Settings" })).toBe("설정");
    expect(i18n._({ id: "Cancel", message: "Cancel" })).toBe("취소");

    i18n.load("tr", tr as Record<string, string>);
    i18n.activate("tr");
    expect(i18n._({ id: "Settings", message: "Settings" })).toBe("Ayarlar");
    expect(i18n._({ id: "Cancel", message: "Cancel" })).toBe("İptal");

    i18n.load("hi", hi as Record<string, string>);
    i18n.activate("hi");
    expect(i18n._({ id: "Settings", message: "Settings" })).toBe("सेटिंग्स");
    expect(i18n._({ id: "Cancel", message: "Cancel" })).toBe("रद्द करें");

    i18n.load("pt-BR", ptBR as Record<string, string>);
    i18n.activate("pt-BR");
    expect(i18n._({ id: "Settings", message: "Settings" })).toBe("Configurações");
    expect(i18n._({ id: "Cancel", message: "Cancel" })).toBe("Cancelar");

    i18n.load("zh-CN", zhCN as Record<string, string>);
    i18n.activate("zh-CN");
    expect(i18n._({ id: "Settings", message: "Settings" })).toBe("设置");
    expect(i18n._({ id: "Cancel", message: "Cancel" })).toBe("取消");

    i18n.load("es", es as Record<string, string>);
    i18n.activate("es");
    expect(i18n._({ id: "Settings", message: "Settings" })).toBe("Configuración");
    expect(i18n._({ id: "Cancel", message: "Cancel" })).toBe("Cancelar");
  });

  it("ships Simplified Chinese translations for the Chief onboarding focus card", () => {
    const catalog = readFileSync(
      fileURLToPath(new URL("../locales/zh-CN/messages.po", import.meta.url)),
      "utf8",
    );

    expect(catalog).toContain('msgid "What do you want me on first?"\nmsgstr "你想让我先做什么？"');
    expect(catalog).toContain('msgid "Day-to-day work"\nmsgstr "日常工作"');
    expect(catalog).toContain('msgid "Inbox & email"\nmsgstr "收件箱和邮件"');
    expect(catalog).toContain('msgid "Research & writing"\nmsgstr "调研和写作"');
    expect(catalog).toContain('msgid "A bit of everything"\nmsgstr "什么都做一点"');

    i18n.load("zh-CN", {
      "What do you want me on first?": "你想让我先做什么？",
      "Day-to-day work": "日常工作",
      "Inbox & email": "收件箱和邮件",
      "Research & writing": "调研和写作",
      "A bit of everything": "什么都做一点",
    });
    i18n.activate("zh-CN");
    expect(
      i18n._({
        id: "What do you want me on first?",
        message: "What do you want me on first?",
      }),
    ).toBe("你想让我先做什么？");
    expect(i18n._({ id: "Day-to-day work", message: "Day-to-day work" })).toBe("日常工作");
    expect(i18n._({ id: "Inbox & email", message: "Inbox & email" })).toBe("收件箱和邮件");
  });

  it("ships the Russian runtime catalog with translated chrome and Russian plurals", () => {
    const catalog = readFileSync(
      fileURLToPath(new URL("../locales/ru/messages.po", import.meta.url)),
      "utf8",
    );

    expect(catalog).toContain('msgid "Settings"\nmsgstr "Настройки"');
    expect(catalog).toContain('msgid "Language"\nmsgstr "Язык"');
    expect(catalog).toContain('msgid "Cancel"\nmsgstr "Отмена"');
    expect(catalog).toContain(
      'msgstr "{0, plural, one {# модель} few {# модели} many {# моделей} other {# модели}}"',
    );
  });

  it("ships the French runtime catalog with translated chrome and French plurals", () => {
    const catalog = readFileSync(
      fileURLToPath(new URL("../locales/fr/messages.po", import.meta.url)),
      "utf8",
    );

    expect(catalog).toContain('msgid "Settings"\nmsgstr "Paramètres"');
    expect(catalog).toContain('msgid "Language"\nmsgstr "Langue"');
    expect(catalog).toContain('msgid "Cancel"\nmsgstr "Annuler"');
    expect(catalog).toContain('msgstr "{0, plural, one {# modèle} other {# modèles}}"');
    expect(catalog).toContain(
      'msgid "Configure a plugin catalog on the server to connect apps."\nmsgstr "Configurez un catalogue de plugins sur le serveur pour connecter des applications."',
    );
  });

  it("translates command credential controls in every locale", () => {
    const messages = [
      "Command variable",
      "Available to this bot's shell commands as {commandVariable}",
      "{commandVariable} is reserved and cannot be used as a command variable. Choose another name.",
      "Values are encrypted and never shown again.",
    ];
    for (const locale of ["en", "de", "es", "fr", "hi", "ko", "pt-BR", "ru", "tr", "zh-CN"]) {
      const catalog = readFileSync(
        fileURLToPath(new URL(`../locales/${locale}/messages.po`, import.meta.url)),
        "utf8",
      );
      for (const message of messages) {
        const entry = catalog
          .split("\n\n")
          .find((block) => block.includes(`msgid ${JSON.stringify(message)}\n`));
        expect(entry, `${locale}: ${message}`).toMatch(/msgstr ".+"/);
        if (message.includes("{commandVariable}")) {
          expect(entry?.split("msgstr ")[1]).toContain("{commandVariable}");
        }
      }
    }
  });

  it("translates model connection preflight feedback in every non-English catalog", () => {
    const locales = ["de", "es", "fr", "hi", "ko", "pt-BR", "ru", "tr", "zh-CN"];
    const messages = [
      "A subscription credential is stored securely.",
      'Model "{modelId}" was not listed.',
      "Models list OK. {modelCount, plural, one {# model} other {# models}} available. " +
        "Chat was not tested.",
      "Connection test failed.",
      "Test API key",
      "Testing…",
    ];
    for (const locale of locales) {
      const catalog = readFileSync(
        fileURLToPath(new URL(`../locales/${locale}/messages.po`, import.meta.url)),
        "utf8",
      );
      for (const msgid of messages) {
        const needle = `msgid ${JSON.stringify(msgid)}\nmsgstr "`;
        const at = catalog.indexOf(needle);
        expect(at, `${locale} ${msgid}`).toBeGreaterThanOrEqual(0);
        const end = catalog.indexOf('"\n', at + needle.length);
        const translated = catalog.slice(at + needle.length, end);
        expect(translated.length, `${locale} ${msgid}`).toBeGreaterThan(0);
        expect(translated, `${locale} ${msgid}`).not.toBe(msgid);
        if (msgid.includes("{modelId}")) expect(translated).toContain("{modelId}");
        if (msgid.includes("{modelCount")) {
          expect(translated).toContain("{modelCount, plural,");
          expect(translated).toContain("#");
        }
      }
    }

    const russian = readFileSync(
      fileURLToPath(new URL("../locales/ru/messages.po", import.meta.url)),
      "utf8",
    );
    expect(russian).toContain(
      "msgstr " +
        '"Список моделей в порядке. {modelCount, plural, one {Доступна # модель} ' +
        "few {Доступны # модели} many {Доступно # моделей} other {Доступно # модели}}. " +
        'Чат не проверялся."',
    );
  });

  it("translates the terminal empty state in every non-English catalog", () => {
    const translations: Record<string, string> = {
      de: "Noch keine Bot-Aktivität.",
      es: "Aún no hay actividad del bot.",
      fr: "Aucune activité du bot pour le moment.",
      hi: "अभी तक कोई बॉट गतिविधि नहीं।",
      ko: "아직 봇 활동이 없습니다.",
      "pt-BR": "Ainda não há atividade do bot.",
      ru: "Активности бота пока нет.",
      tr: "Henüz bot etkinliği yok.",
      "zh-CN": "还没有机器人活动。",
    };
    for (const [locale, msgstr] of Object.entries(translations)) {
      const catalog = readFileSync(
        fileURLToPath(new URL(`../locales/${locale}/messages.po`, import.meta.url)),
        "utf8",
      );
      expect(catalog).toContain(`msgid "No bot activity yet."\nmsgstr "${msgstr}"`);
    }
  });
});
