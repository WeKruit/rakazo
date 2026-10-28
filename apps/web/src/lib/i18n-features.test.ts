// @vitest-environment jsdom
import { beforeEach, expect, it, vi } from "vitest";
import {
  activateUiLocale,
  i18n,
  setCatalogLoadersForTests,
  setFeatureCatalogLoadersForTests,
  withFeatureMessages,
} from "./i18n";
import type { UiLocale } from "./ui-locale";
import { UI_LOCALES } from "./ui-locale";

type Catalog = { messages: Record<string, string> };
function loaders(load: (locale: UiLocale) => Promise<Catalog>) {
  return Object.fromEntries(UI_LOCALES.map((locale) => [locale, () => load(locale)])) as Record<
    UiLocale,
    () => Promise<Catalog>
  >;
}
function deferred() {
  let resolve!: (value: Catalog) => void;
  const promise = new Promise<Catalog>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
beforeEach(() => {
  setCatalogLoadersForTests(null);
  i18n.loadAndActivate({ locale: "en", messages: {} });
});
it("loads only startup messages until an optional page is requested", async () => {
  const full = vi.fn(async (locale: UiLocale) => ({ messages: { feature: `${locale} full` } }));
  setCatalogLoadersForTests(loaders(async (locale) => ({ messages: { base: locale } })));
  setFeatureCatalogLoadersForTests(loaders(full));
  await activateUiLocale("zh-CN");
  expect(full).not.toHaveBeenCalled();
  const component = {};
  expect(await withFeatureMessages(async () => component)).toBe(component);
  expect(i18n._("feature")).toBe("zh-CN full");
  await activateUiLocale("de");
  expect(i18n._("feature")).toBe("de full");
});
it("waits for the latest locale when a feature opens during a switch", async () => {
  const zh = deferred();
  const de = deferred();
  setCatalogLoadersForTests(loaders(async () => ({ messages: { base: "ready" } })));
  await activateUiLocale("en");
  setFeatureCatalogLoadersForTests(
    loaders((locale) => (locale === "zh-CN" ? zh.promise : de.promise)),
  );
  const switching = activateUiLocale("zh-CN");
  let rendered = false;
  const feature = withFeatureMessages(async () => "component").then((value) => {
    rendered = true;
    return value;
  });
  const latest = activateUiLocale("de");
  zh.resolve({ messages: { feature: "Chinese" } });
  await switching;
  await Promise.resolve();
  expect(rendered).toBe(false);
  de.resolve({ messages: { feature: "German" } });
  await latest;
  await feature;
  expect(i18n.locale).toBe("de");
  expect(i18n._("feature")).toBe("German");
});
it("falls back atomically to the complete English catalog", async () => {
  setCatalogLoadersForTests(loaders(async (locale) => ({ messages: { base: locale } })));
  await activateUiLocale("zh-CN");
  setFeatureCatalogLoadersForTests(
    loaders(async (locale) => {
      if (locale !== "en") throw new Error("missing");
      return { messages: { base: "English", feature: "Settings" } };
    }),
  );
  await withFeatureMessages(async () => ({}));
  expect(i18n.locale).toBe("en");
  expect(i18n._("base")).toBe("English");
  expect(i18n._("feature")).toBe("Settings");
});
it("does not render an untranslated feature when both catalogs fail, and can retry", async () => {
  setCatalogLoadersForTests(loaders(async () => ({ messages: { base: "ready" } })));
  await activateUiLocale("en");
  setFeatureCatalogLoadersForTests(
    loaders(async () => {
      throw new Error("offline");
    }),
  );
  await expect(withFeatureMessages(async () => ({}))).rejects.toThrow(
    "Could not load translations",
  );
  setFeatureCatalogLoadersForTests(loaders(async () => ({ messages: { feature: "Ready" } })));
  await withFeatureMessages(async () => ({}));
  expect(i18n._("feature")).toBe("Ready");
});

it("preserves visible startup translations when both optional catalogs fail", async () => {
  setCatalogLoadersForTests(loaders(async (locale) => ({ messages: { base: `${locale} ready` } })));
  await activateUiLocale("zh-CN");
  setFeatureCatalogLoadersForTests(
    loaders(async () => {
      throw new Error("offline");
    }),
  );
  await expect(withFeatureMessages(async () => ({}))).rejects.toThrow(
    "Could not load translations",
  );
  expect(i18n.locale).toBe("zh-CN");
  expect(i18n._("base")).toBe("zh-CN ready");
  setFeatureCatalogLoadersForTests(
    loaders(async (locale) => ({ messages: { feature: `${locale} feature` } })),
  );
  await withFeatureMessages(async () => ({}));
  expect(i18n.locale).toBe("zh-CN");
  expect(i18n._("feature")).toBe("zh-CN feature");
});

it("keeps a fully translated mounted feature when a later locale and English fail", async () => {
  setCatalogLoadersForTests(loaders(async (locale) => ({ messages: { base: locale } })));
  setFeatureCatalogLoadersForTests(
    loaders(async (locale) => ({ messages: { feature: `${locale} feature` } })),
  );
  await activateUiLocale("zh-CN");
  await withFeatureMessages(async () => ({}));
  setFeatureCatalogLoadersForTests(
    loaders(async () => {
      throw new Error("offline");
    }),
  );
  expect(await activateUiLocale("de")).toBe("zh-CN");
  expect(i18n.locale).toBe("zh-CN");
  expect(i18n._("base")).toBe("zh-CN");
  expect(i18n._("feature")).toBe("zh-CN feature");
});
