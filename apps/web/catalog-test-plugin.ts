import { fileURLToPath } from "node:url";
import { lingui } from "@lingui/vite-plugin";

// Component tests now exercise real deferred catalogs, just like the web build.
export const catalogTestPlugin = lingui({
  configPath: fileURLToPath(new URL("./lingui.config.ts", import.meta.url)),
});
