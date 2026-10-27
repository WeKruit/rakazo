import { i18n } from "@lingui/core";
import { applyUiDirection } from "./apply-ui-direction";
import { persistUiLocale, resolveUiLocale, type UiLocale } from "./ui-locale";

export { i18n };

type CatalogMessages = Parameters<typeof i18n.load>[1];
type CatalogModule = { messages: CatalogMessages };
type CatalogLoader = () => Promise<CatalogModule>;

const defaultFeatureCatalogLoaders: Record<UiLocale, CatalogLoader> = {
  en: () => import("../locales/en/messages.po") as Promise<CatalogModule>,
  de: () => import("../locales/de/messages.po") as Promise<CatalogModule>,
  ko: () => import("../locales/ko/messages.po") as Promise<CatalogModule>,
  tr: () => import("../locales/tr/messages.po") as Promise<CatalogModule>,
  hi: () => import("../locales/hi/messages.po") as Promise<CatalogModule>,
  "pt-BR": () => import("../locales/pt-BR/messages.po") as Promise<CatalogModule>,
  "zh-CN": () => import("../locales/zh-CN/messages.po") as Promise<CatalogModule>,
  es: () => import("../locales/es/messages.po") as Promise<CatalogModule>,
  ru: () => import("../locales/ru/messages.po") as Promise<CatalogModule>,
  fr: () => import("../locales/fr/messages.po") as Promise<CatalogModule>,
};

const defaultCatalogLoaders: Record<UiLocale, CatalogLoader> = {
  en: () => import("../locales/en/startup.po") as Promise<CatalogModule>,
  de: () => import("../locales/de/startup.po") as Promise<CatalogModule>,
  ko: () => import("../locales/ko/startup.po") as Promise<CatalogModule>,
  tr: () => import("../locales/tr/startup.po") as Promise<CatalogModule>,
  hi: () => import("../locales/hi/startup.po") as Promise<CatalogModule>,
  "pt-BR": () => import("../locales/pt-BR/startup.po") as Promise<CatalogModule>,
  "zh-CN": () => import("../locales/zh-CN/startup.po") as Promise<CatalogModule>,
  es: () => import("../locales/es/startup.po") as Promise<CatalogModule>,
  ru: () => import("../locales/ru/startup.po") as Promise<CatalogModule>,
  fr: () => import("../locales/fr/startup.po") as Promise<CatalogModule>,
};

let catalogLoaders: Record<UiLocale, CatalogLoader> = defaultCatalogLoaders;
let featureCatalogLoaders = defaultFeatureCatalogLoaders;
let featureCatalogRequired = false;
let activeHasFeatures = false;
let requestedLocale: UiLocale | null = null;
let activeLocale: UiLocale | null = null;
let activationGeneration = 0;
let activationInFlight: Promise<UiLocale> | null = null;

/** Test-only: replace catalog loaders (restore with `null`). */
export function setCatalogLoadersForTests(loaders: Record<UiLocale, CatalogLoader> | null): void {
  catalogLoaders = loaders ?? defaultCatalogLoaders;
  featureCatalogLoaders = loaders ?? defaultFeatureCatalogLoaders;
  featureCatalogRequired = false;
  activeHasFeatures = false;
  requestedLocale = null;
  activeLocale = null;
  activationGeneration = 0;
  activationInFlight = null;
}

export function getActiveUiLocale(): UiLocale {
  return activeLocale ?? resolveUiLocale();
}

async function loadCatalog(locale: UiLocale): Promise<CatalogMessages> {
  const { messages } = await catalogLoaders[locale]();
  if (!featureCatalogRequired) return messages;
  const feature = await featureCatalogLoaders[locale]();
  return { ...messages, ...feature.messages };
}

function activateLoaded(
  locale: UiLocale,
  messages: CatalogMessages,
  hasFeatures = featureCatalogRequired,
): UiLocale {
  i18n.load(locale, messages);
  i18n.activate(locale);
  activeLocale = locale;
  activeHasFeatures = hasFeatures;
  applyUiDirection(locale);
  return locale;
}

/**
 * Load and activate a locale. Concurrent calls: only the latest selection wins.
 * If the preferred catalog fails, tries English, then preserves the active catalog.
 * Empty English is only the final fallback before any locale has been activated.
 */
export function activateUiLocale(locale: UiLocale): Promise<UiLocale> {
  activationInFlight = loadAndActivateLocale(locale);
  return activationInFlight;
}

async function loadAndActivateLocale(locale: UiLocale): Promise<UiLocale> {
  // Bump first so a later "already active" selection cancels in-flight loads.
  requestedLocale = locale;
  const generation = ++activationGeneration;
  const isCurrent = () => generation === activationGeneration;

  if (
    activeLocale === locale &&
    i18n.locale === locale &&
    (!featureCatalogRequired || activeHasFeatures)
  )
    return locale;

  try {
    const messages = await loadCatalog(locale);
    if (!isCurrent()) return getActiveUiLocale();
    return activateLoaded(locale, messages);
  } catch {
    if (!isCurrent()) return getActiveUiLocale();
    if (locale !== "en") {
      try {
        const messages = await loadCatalog("en");
        if (!isCurrent()) return getActiveUiLocale();
        return activateLoaded("en", messages);
      } catch {
        // Preserve the last activated catalog when both complete loads fail.
      }
    }
    if (!isCurrent()) return getActiveUiLocale();
    if (activeLocale !== null) return activeLocale;
    return activateLoaded("en", {}, false);
  }
}

/** Resolve preferred locale and load only that catalog. */
export async function bootstrapI18n(preferred: UiLocale = resolveUiLocale()): Promise<UiLocale> {
  return activateUiLocale(preferred);
}

export async function setUiLocale(locale: UiLocale): Promise<UiLocale> {
  persistUiLocale(locale);
  const activation = activateUiLocale(locale);
  const generation = activationGeneration;
  const activated = await activation;
  // Only rewrite storage on fallback when this call is still the latest selection.
  if (generation === activationGeneration && activated !== locale) {
    persistUiLocale(activated);
  }
  return activated;
}

/** Load optional-page messages before its existing lazy component can render. */
export async function withFeatureMessages<T>(load: () => Promise<T>): Promise<T> {
  featureCatalogRequired = true;
  const locale = requestedLocale ?? getActiveUiLocale();
  const [module] = await Promise.all([load(), activateUiLocale(locale)]);
  // A newer locale selection can supersede the activation we started. Its complete
  // catalog must be ready too before the deferred component reads any messages.
  let pending = activationInFlight;
  while (pending) {
    await pending;
    if (pending === activationInFlight) break;
    pending = activationInFlight;
  }
  if (!activeHasFeatures) throw new Error("Could not load translations");
  return module;
}

/** Test-only: inject optional catalog failures and deferred loads. */
export function setFeatureCatalogLoadersForTests(loaders: Record<UiLocale, CatalogLoader>): void {
  featureCatalogLoaders = loaders;
}
