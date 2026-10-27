import { fileURLToPath } from "node:url";
import { createCompiledCatalog, getCatalogs } from "@lingui/cli/api";
import { getConfig } from "@lingui/conf";
import { expect, it } from "vitest";

it("keeps shared translations identical across complementary catalogs in every locale", async () => {
  const config = getConfig({
    configPath: fileURLToPath(new URL("../../lingui.config.ts", import.meta.url)),
  });
  const [features, startup] = await getCatalogs(config);
  expect(startup).toBeDefined();
  for (const locale of config.locales) {
    const feature = await features!.getTranslations(locale, config);
    const initial = await startup!.getTranslations(locale, config);
    const compile = (messages: typeof feature.messages) => {
      const result = createCompiledCatalog(locale, messages, { namespace: "json", strict: true });
      expect(result.errors).toEqual([]);
      return JSON.parse(result.source).messages;
    };
    const deferred = compile(feature.messages);
    const first = compile(initial.messages);
    for (const id of Object.keys(first).filter((id) => id in deferred)) {
      expect(first[id], `${locale} shared ${id}`).toEqual(deferred[id]);
    }
    expect(Object.keys(deferred).some((id) => !(id in first))).toBe(true);
    expect(Object.keys(first).some((id) => !(id in deferred))).toBe(true);
  }
});
