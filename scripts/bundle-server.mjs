// Bundles the API and worker entrypoints so a cold container starts plain
// JavaScript instead of transpiling the workspace TypeScript through tsx.
// Workspace packages (@rakazo/*) are bundled; every npm dependency stays an
// external import, pinned to the file the importing package resolves today, so
// pnpm's per-package node_modules isolation keeps working from dist/.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
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
  const outfile =
    app === "slot-control" ? "apps/worker/dist/replace-slot.mjs" : `apps/${app}/dist/index.mjs`;
  await build({
    absWorkingDir: root,
    entryPoints: [
      app === "slot-control" ? "apps/worker/src/replace-slot.ts" : `apps/${app}/src/index.ts`,
    ],
    outfile,
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
  if (app !== "slot-control") {
    let sourceRevision = "unknown";
    try {
      sourceRevision = (await readFile(path.join(root, ".wekruit-source-revision"), "utf8")).trim();
    } catch {
      try {
        const dirty = execFileSync("git", ["status", "--porcelain"], {
          cwd: root,
          encoding: "utf8",
        }).trim();
        if (!dirty)
          sourceRevision = execFileSync("git", ["rev-parse", "HEAD"], {
            cwd: root,
            encoding: "utf8",
          }).trim();
      } catch {
        /* Legacy builds may omit repository metadata; split startup rejects unknown. */
      }
    }
    if (!/^[0-9a-f]{40}$/.test(sourceRevision)) sourceRevision = "unknown";
    const sha256 = createHash("sha256")
      .update(await readFile(path.join(root, outfile)))
      .digest("hex");
    await writeFile(
      path.join(root, `apps/${app}/dist/build-manifest.json`),
      JSON.stringify({ sourceRevision, sha256, sessionAdmissionProtocol: 1 }) + "\n",
    );
  }
}
