import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "../src");
const limit = 1_500;
function components(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) return components(file);
    if (!entry.name.endsWith(".tsx") || /\.(test|spec)\.tsx$/.test(entry.name)) return [];
    const source = readFileSync(file, "utf8");
    return [
      {
        file: path.relative(root, file),
        lines: source.split("\n").length - Number(source.endsWith("\n")),
      },
    ];
  });
}
const files = components(root).sort((a, b) => b.lines - a.lines);
const violations = files.filter(({ lines }) => lines > limit);
console.log(
  JSON.stringify({ limit, components: files.length, largest: files[0], violations }, null, 2),
);
if (violations.length) process.exitCode = 1;
