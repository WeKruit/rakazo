// Bundles the API and worker entrypoints so a cold container starts plain
// JavaScript instead of transpiling the workspace TypeScript through tsx.
// Workspace packages (@rakazo/*) are bundled; every npm dependency stays an
// external import, pinned to the file the importing package resolves today, so
// pnpm's per-package node_modules isolation keeps working from dist/.
import { builtinModules } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const builtins = new Set(builtinModules);

const externalDependencies = {
  name: "external-dependencies",
  setup(pluginBuild) {
    pluginBuild.onResolve({ filter: /^[^./]/ }, async (args) => {
      if (args.pluginData === "external-dependencies") return undefined;
      if (args.path.startsWith("node:") || builtins.has(args.path.split("/")[0])) {
        return { path: args.path, external: true };
      }
      if (args.path.startsWith("@rakazo/")) return undefined;
      const resolved = await pluginBuild.resolve(args.path, {
        kind: args.kind,
        importer: args.importer,
        resolveDir: args.resolveDir,
        pluginData: "external-dependencies",
      });
      if (resolved.errors.length > 0) return { errors: resolved.errors };
      return { path: resolved.path, external: true };
    });
  },
};

for (const app of process.argv.slice(2).length > 0 ? process.argv.slice(2) : ["api", "worker"]) {
  await build({
    absWorkingDir: root,
    entryPoints: [`apps/${app}/src/index.ts`],
    outfile: `apps/${app}/dist/index.mjs`,
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node24",
    conditions: ["node"],
    mainFields: ["main"],
    sourcemap: true,
    logLevel: "warning",
    plugins: [externalDependencies],
    banner: {
      // Bundled workspace code may call require/__dirname in ESM output.
      js: [
        'import { createRequire as __rakazoCreateRequire } from "node:module";',
        'import { fileURLToPath as __rakazoFileURLToPath } from "node:url";',
        "const require = __rakazoCreateRequire(import.meta.url);",
        "const __filename = __rakazoFileURLToPath(import.meta.url);",
      ].join("\n"),
    },
  });
}
