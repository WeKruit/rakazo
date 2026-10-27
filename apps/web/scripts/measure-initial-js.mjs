import { readFile } from "node:fs/promises";
import path from "node:path";
import { gzipSync } from "node:zlib";

const root = path.resolve(process.argv[2] ?? path.join(import.meta.dirname, "../dist"));
const manifest = JSON.parse(await readFile(path.join(root, ".vite/manifest.json"), "utf8"));
for (const includeShell of [false, true]) {
  const seen = new Set();
  function visit(key) {
    if (seen.has(key)) return;
    seen.add(key);
    for (const dependency of manifest[key].imports ?? []) visit(dependency);
  }
  for (const [key, value] of Object.entries(manifest)) {
    if (value.isEntry || (includeShell && key.endsWith("/Shell.tsx"))) visit(key);
  }
  const assets = [];
  for (const key of seen) {
    const file = manifest[key].file;
    if (!file.endsWith(".js")) continue;
    const bytes = await readFile(path.join(root, file));
    assets.push({ file, bytes: bytes.length, gzipBytes: gzipSync(bytes).length });
  }
  console.log(
    JSON.stringify(
      {
        scope: includeShell
          ? "entry + authenticated Shell static imports; excludes runtime-requested chunks"
          : "entry static imports only",
        jsAssets: assets.length,
        bytes: assets.reduce((sum, a) => sum + a.bytes, 0),
        gzipBytes: assets.reduce((sum, a) => sum + a.gzipBytes, 0),
        assets,
      },
      null,
      2,
    ),
  );
}
