#!/usr/bin/env node
// Times the first ten on a live deployment for the three ways a recruiter starts a role: a long
// pasted JD, a short pasted JD and a job link. Each case runs recruiting-latency.mjs once as a new
// test copy (archived afterwards) and stops after the first ten; this prints one comparable table.
//
// Usage:
//   RAKAZO_URL=https://… RAKAZO_EMAIL=… RAKAZO_PASSWORD=… RAKAZO_RELEASE_SHA=<sha> \
//     node infra/acceptance/first10-suite.mjs [--link <job url> --link-company <hiring company>]
//   Options: --link <url>            public job posting in metro Atlanta (the link case is skipped without it)
//            --link-company <name>   the posting's company; its current staff are flagged
//            --only <long,short,link> run a subset
//            --out <dir>             reports directory (default ./first10-<time>)
// Runs the cases one after another, never in parallel, and never during another live test.
// Node 20+, no dependencies. Prints no credentials. Exit code 0 only when every case passes.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] !== undefined ? args[index + 1] : fallback;
};
const here = path.dirname(fileURLToPath(import.meta.url));
const harness = path.join(here, "recruiting-latency.mjs");
const OUT = option("--out", `first10-${new Date().toISOString().replace(/[:.]/g, "-")}`);
fs.mkdirSync(OUT, { recursive: true });

// Metro Atlanta towns a commuter reaches; anything else is listed for review.
const ATLANTA =
  "Atlanta|Marietta|Alpharetta|Roswell|Sandy Springs|Smyrna|Kennesaw|Acworth|Woodstock|Canton|Cartersville|Duluth|Lawrenceville|Norcross|Peachtree|Decatur|Tucker|Stone Mountain|Lithonia|Conyers|Covington|McDonough|Stockbridge|Hampton|Locust Grove|Jonesboro|Morrow|Riverdale|Forest Park|Ellenwood|Fayetteville|Tyrone|Newnan|Senoia|Sharpsburg|Douglasville|Austell|Mableton|Lithia Springs|Powder Springs|Hiram|Dallas, Georgia|Villa Rica|Carrollton|Fairburn|Union City|Palmetto|College Park|East Point|Hapeville|Chamblee|Doraville|Dunwoody|Brookhaven|Johns Creek|Milton|Suwanee|Buford|Sugar Hill|Cumming|Snellville|Loganville|Grayson|Lilburn|Dacula|Braselton|Winder|Monroe, Georgia|Social Circle|Gainesville, Georgia|Flowery Branch|Griffin|Jackson, Georgia|Rex|Redan|Clarkston|Scottdale|Vinings";

const SHORT_JD =
  "新岗位：仓库运营经理（亚特兰大 Atlanta，现场办公）。要求：5年以上仓储或配送中心运营管理，带过50人以上的小时工团队，熟悉WMS和KPI管理。加分：会中文、电商或第三方物流背景。排除：猎头、学生。";
const cases = [
  {
    key: "long",
    label: "Long text",
    args: ["--jd", path.join(here, "fixtures", "first10-long-jd.txt")],
  },
  { key: "short", label: "Short text", args: ["--jd-text", SHORT_JD] },
  option("--link") && {
    key: "link",
    label: "Link",
    args: [
      "--jd-url",
      option("--link"),
      ...(option("--link-company") ? ["--hiring-company", option("--link-company")] : []),
    ],
  },
].filter(Boolean);
const only = option("--only")?.split(",");
const selected = only ? cases.filter((item) => only.includes(item.key)) : cases;

const rows = [];
for (const item of selected) {
  const out = path.join(OUT, `${item.key}.json`);
  process.stdout.write(`\n=== ${item.label} ===\n`);
  spawnSync(
    process.execPath,
    [
      harness,
      ...item.args,
      "--skip-scale",
      "--archive",
      "--area",
      ATLANTA,
      "--timeout-min",
      "10",
      "--out",
      out,
    ],
    { stdio: "inherit", env: process.env },
  );
  const report = fs.existsSync(out) ? JSON.parse(fs.readFileSync(out, "utf8")) : null;
  rows.push({ case: item.label, report });
}

const s = (value) => (value == null ? "—" : `${value} s`);
const lines = [
  `First ten on ${process.env.RAKAZO_RELEASE_SHA ?? "unknown release"}, ${new Date().toISOString().slice(0, 16)}Z. Times from the recruiter's last answer; Q1 from the JD.`,
  "",
  "| JD | Q1 | First people in chat | All ten | Searched again | Ten before card | In area | Hiring-company staff | Tool retries | Result |",
  "|---|---|---|---|---|---|---|---|---|---|",
];
for (const { case: label, report } of rows) {
  const f = report?.first10;
  if (!f) {
    lines.push(`| ${label} | — | — | — | — | — | — | — | — | ${report?.result ?? "no report"} |`);
    continue;
  }
  lines.push(
    `| ${label} | ${s(f.firstQuestionS)} | ${s(f.firstPeopleInChatS)} | ${s(f.allTenS)} | ${f.modelSearchesAfterAnswer ? `yes (${f.modelSearchesAfterAnswer})` : "no"} | ${f.tenRecordedBeforeCard ? "yes" : "no"} | ${f.inArea ?? "—"}/${f.people} | ${f.hiringCompanyStaff.length} | ${report.toolErrors?.errors ?? "—"} | ${report.result} |`,
  );
}
const flagged = rows.flatMap(({ case: label, report }) =>
  (report?.violations ?? []).map((v) => `- ${label}: ${v.kind} — ${v.detail}`),
);
if (flagged.length) lines.push("", "Flagged for review:", ...flagged);
const summary = `${lines.join("\n")}\n`;
fs.writeFileSync(path.join(OUT, "summary.md"), summary);
process.stdout.write(`\n${summary}`);
process.exit(rows.every((row) => row.report?.result === "pass") ? 0 : 1);
