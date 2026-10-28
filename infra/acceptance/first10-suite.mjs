#!/usr/bin/env node
// Times the first ten on a live deployment for the three ways a recruiter starts a role: a long
// pasted JD, a short pasted JD and a job link. Each run of a case is recruiting-latency.mjs on a new
// test copy (archived afterwards) that stops after the first ten. The suite writes summary.md and a
// self-contained report.html with every run and the p50 / p90 / max of each milestone.
//
// Usage:
//   RAKAZO_URL=https://… RAKAZO_EMAIL=… RAKAZO_PASSWORD=… RAKAZO_RELEASE_SHA=<sha> \
//     node infra/acceptance/first10-suite.mjs [--link <job url> --link-company <hiring company>]
//   Options: --link <url>            public job posting in metro Atlanta (the link case is skipped without it)
//            --link-company <name>   the posting's company; its current staff are flagged
//            --only <long,short,link> run a subset
//            --repeat <n>            runs per case (default 1; use 5+ for a meaningful p90)
//            --out <dir>             reports directory (default ./first10-<time>)
//            --from <dir>            rebuild summary.md and report.html from an earlier run, no new runs
// RAKAZO_ORIGIN (optional) is passed through to each run as its Origin header.
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
const FROM = option("--from");
const OUT = FROM ?? option("--out", `first10-${new Date().toISOString().replace(/[:.]/g, "-")}`);
const REPEAT = Math.max(1, Number(option("--repeat", "1")));
fs.mkdirSync(OUT, { recursive: true });

// Metro Atlanta towns a commuter reaches; anything else is listed for review.
const ATLANTA =
  "Atlanta|Marietta|Alpharetta|Roswell|Sandy Springs|Smyrna|Kennesaw|Acworth|Woodstock|Canton|Cartersville|Duluth|Lawrenceville|Norcross|Peachtree|Decatur|Tucker|Stone Mountain|Lithonia|Conyers|Covington|McDonough|Stockbridge|Hampton|Locust Grove|Jonesboro|Morrow|Riverdale|Forest Park|Ellenwood|Fayetteville|Tyrone|Newnan|Senoia|Sharpsburg|Douglasville|Austell|Mableton|Lithia Springs|Powder Springs|Hiram|Dallas, Georgia|Villa Rica|Carrollton|Fairburn|Union City|Palmetto|College Park|East Point|Hapeville|Chamblee|Doraville|Dunwoody|Brookhaven|Johns Creek|Milton|Suwanee|Buford|Sugar Hill|Cumming|Snellville|Loganville|Grayson|Lilburn|Dacula|Braselton|Hoschton|Winder|Monroe, Georgia|Social Circle|Gainesville, Georgia|Flowery Branch|Griffin|Jackson, Georgia|Rex|Redan|Clarkston|Scottdale|Vinings";

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

// Rounds interleave the cases (long, short, link, long, …) so drift in the model or the search
// service spreads evenly across them.
if (!FROM)
  for (let run = 1; run <= REPEAT; run++)
    for (const item of selected) {
      const out = path.join(OUT, `${item.key}-${run}.json`);
      process.stdout.write(`\n=== ${item.label} · run ${run}/${REPEAT} ===\n`);
      spawnSync(
        process.execPath,
        [
          harness,
          ...item.args,
          "--skip-scale",
          "--area",
          ATLANTA,
          "--timeout-min",
          "10",
          "--out",
          out,
        ],
        { stdio: "inherit", env: process.env },
      );
    }

// Every case key the suite knows, so --from also reads cases this invocation did not configure.
const KNOWN = [
  { key: "long", label: "Long text" },
  { key: "short", label: "Short text" },
  { key: "link", label: "Link" },
];
const rows = [];
for (const item of KNOWN) {
  const files = fs
    .readdirSync(OUT)
    .filter((name) => new RegExp(`^${item.key}-\\d+\\.json$`).test(name))
    .sort((a, b) => Number(a.match(/\d+/)[0]) - Number(b.match(/\d+/)[0]));
  for (const name of files) {
    const report = JSON.parse(fs.readFileSync(path.join(OUT, name), "utf8"));
    rows.push({ key: item.key, case: item.label, run: Number(name.match(/\d+/)[0]), report });
  }
}
const release = rows.find((row) => row.report.version)?.report.version ?? "unknown release";
const startedAt = rows.map((row) => row.report.startedAt).sort()[0] ?? new Date().toISOString();

const METRICS = [
  { key: "firstQuestionS", label: "Q1", from: "JD sent → first question" },
  { key: "firstPeopleInChatS", label: "First people in chat", from: "last answer → first names" },
  { key: "allTenS", label: "All ten", from: "last answer → ten recorded and listed" },
];
// Linear interpolation between closest ranks, as in most spreadsheet PERCENTILE functions.
function percentile(values, p) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = (sorted.length - 1) * p;
  const low = Math.floor(index);
  const value = sorted[low] + (sorted[Math.ceil(index)] - sorted[low]) * (index - low);
  return Math.round(value * 10) / 10;
}
const stats = {};
for (const item of KNOWN) {
  const runs = rows.filter((row) => row.key === item.key);
  if (!runs.length) continue;
  stats[item.key] = { label: item.label, n: runs.length, passed: 0, metrics: {} };
  stats[item.key].passed = runs.filter((row) => row.report.result === "pass").length;
  for (const metric of METRICS) {
    const values = runs.map((row) => row.report.first10?.[metric.key]).filter((v) => v != null);
    stats[item.key].metrics[metric.key] = {
      values,
      p50: percentile(values, 0.5),
      p90: percentile(values, 0.9),
      max: values.length ? Math.max(...values) : null,
    };
  }
}

const s = (value) => (value == null ? "—" : `${value} s`);
const check = (f, report) => ({
  searched:
    (f.modelSearchesAfterAnswer ? `yes (${f.modelSearchesAfterAnswer})` : "no") +
    (f.refusedSearchesAfterAnswer ? `, ${f.refusedSearchesAfterAnswer} refused` : ""),
  beforeCard: f.tenRecordedBeforeCard ? "yes" : "no",
  area: `${f.inArea ?? "—"}/${f.people}`,
  staff: f.hiringCompanyStaff.length,
  retries: report.toolErrors?.errors ?? "—",
  modelRetries: report.modelRetries ?? "—",
});
const lines = [
  `First ten on ${release}, ${startedAt.slice(0, 16)}Z. Q1 counts from the JD; the other times count from the recruiter's last answer.`,
  "",
  "| JD | Runs | Passed | Q1 p50 / p90 / max | First people p50 / p90 / max | All ten p50 / p90 / max |",
  "|---|---|---|---|---|---|",
];
for (const stat of Object.values(stats)) {
  const cell = (key) => {
    const m = stat.metrics[key];
    return `${s(m.p50)} / ${s(m.p90)} / ${s(m.max)}`;
  };
  lines.push(
    `| ${stat.label} | ${stat.n} | ${stat.passed} | ${cell("firstQuestionS")} | ${cell("firstPeopleInChatS")} | ${cell("allTenS")} |`,
  );
}
lines.push(
  "",
  "| JD | Run | Q1 | First people in chat | All ten | Run start wait | Searched again | Ten before card | In area | Hiring-company staff | Tool retries | Model retries | Result |",
  "|---|---|---|---|---|---|---|---|---|---|---|---|---|",
);
for (const { case: label, run, report } of rows) {
  const f = report.first10;
  if (!f) {
    lines.push(`| ${label} | ${run} | — | — | — | — | — | — | — | — | — | — | ${report.result} |`);
    continue;
  }
  const c = check(f, report);
  lines.push(
    `| ${label} | ${run} | ${s(f.firstQuestionS)} | ${s(f.firstPeopleInChatS)} | ${s(f.allTenS)} | ${s(f.runStartWaitS)} | ${c.searched} | ${c.beforeCard} | ${c.area} | ${c.staff} | ${c.retries} | ${c.modelRetries} | ${report.result} |`,
  );
}
const flagged = rows.flatMap(({ case: label, run, report }) =>
  (report.violations ?? []).map((v) => `${label} run ${run}: ${v.kind} — ${v.detail}`),
);
if (flagged.length) lines.push("", "Flagged for review:", ...flagged.map((line) => `- ${line}`));
const summary = `${lines.join("\n")}\n`;
fs.writeFileSync(path.join(OUT, "summary.md"), summary);
fs.writeFileSync(path.join(OUT, "report.html"), renderHtml());
process.stdout.write(`\n${summary}\nReport: ${path.join(OUT, "report.html")}\n`);
process.exit(rows.length && rows.every((row) => row.report.result === "pass") ? 0 : 1);

// --- HTML report -----------------------------------------------------------------------------
// One strip chart per milestone: a dot per run, with p50 and p90 marks, on a shared seconds axis.
function escapeHtml(text) {
  return String(text).replace(
    /[&<>"]/g,
    (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[ch],
  );
}
function outcome(result) {
  return (
    { pass: "pass", completed_with_violations: "flagged", incomplete: "no ten" }[result] ?? result
  );
}
function chart(metric) {
  const groups = Object.entries(stats);
  const all = groups.flatMap(([, stat]) => stat.metrics[metric.key].values);
  const top = Math.max(10, Math.ceil(Math.max(0, ...all) / 5) * 5);
  const width = 640;
  const left = 96;
  const right = 24;
  const rowHeight = 44;
  const top0 = 24;
  const height = top0 + groups.length * rowHeight + 32;
  const x = (value) => left + ((width - left - right) * value) / top;
  const ticks = [];
  for (let t = 0; t <= top; t += top > 30 ? 10 : 5) ticks.push(t);
  const parts = ticks.map(
    (t) =>
      `<line x1="${x(t)}" x2="${x(t)}" y1="${top0}" y2="${height - 28}" class="grid"/><text x="${x(t)}" y="${height - 10}" class="tick" text-anchor="middle">${t}</text>`,
  );
  if (metric.key === "firstPeopleInChatS")
    parts.push(
      `<line x1="${x(10)}" x2="${x(10)}" y1="${top0 - 6}" y2="${height - 28}" class="goal"/><text x="${x(10)}" y="12" class="goal-label" text-anchor="middle">10 s goal</text>`,
    );
  groups.forEach(([key, stat], index) => {
    const y = top0 + rowHeight * index + rowHeight / 2;
    const m = stat.metrics[metric.key];
    parts.push(
      `<text x="${left - 12}" y="${y + 4}" class="row-label" text-anchor="end">${escapeHtml(stat.label)}</text>`,
    );
    if (m.p50 != null && m.p90 != null)
      parts.push(
        `<line x1="${x(m.p50)}" x2="${x(m.p90)}" y1="${y}" y2="${y}" class="span s-${key}"/>`,
      );
    for (const value of m.values)
      parts.push(
        `<circle cx="${x(value)}" cy="${y}" r="5" class="dot s-${key}"><title>${value} s</title></circle>`,
      );
    if (m.p50 != null)
      parts.push(
        `<line x1="${x(m.p50)}" x2="${x(m.p50)}" y1="${y - 12}" y2="${y + 12}" class="mark"/>`,
      );
    if (m.p90 != null)
      parts.push(
        `<line x1="${x(m.p90)}" x2="${x(m.p90)}" y1="${y - 8}" y2="${y + 8}" class="mark thin"/>`,
      );
  });
  return `<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="${escapeHtml(metric.label)} per run, seconds">${parts.join("")}</svg>`;
}
function renderHtml() {
  const statRows = Object.entries(stats)
    .map(
      ([key, stat]) =>
        `<tr><th scope="row"><span class="swatch s-${key}"></span>${escapeHtml(stat.label)}</th><td>${stat.n}</td><td>${stat.passed}</td>${METRICS.map(
          (metric) => {
            const m = stat.metrics[metric.key];
            return `<td><b>${s(m.p50)}</b></td><td>${s(m.p90)}</td><td>${s(m.max)}</td>`;
          },
        ).join("")}</tr>`,
    )
    .join("");
  const runRows = rows
    .map(({ key, case: label, run, report }) => {
      const f = report.first10;
      if (!f)
        return `<tr><th scope="row"><span class="swatch s-${key}"></span>${escapeHtml(label)} ${run}</th><td colspan="9">—</td><td class="warn">${outcome(report.result)}</td></tr>`;
      const c = check(f, report);
      return `<tr><th scope="row"><span class="swatch s-${key}"></span>${escapeHtml(label)} ${run}</th><td>${s(f.firstQuestionS)}</td><td>${s(f.firstPeopleInChatS)}</td><td>${s(f.allTenS)}</td><td>${c.searched}</td><td>${c.beforeCard}</td><td>${c.area}</td><td>${c.staff}</td><td>${c.retries}</td><td>${c.modelRetries}</td><td class="${report.result === "pass" ? "ok" : "warn"}">${outcome(report.result)}</td></tr>`;
    })
    .join("");
  const charts = METRICS.map(
    (metric) =>
      `<section class="chart"><h2>${escapeHtml(metric.label)}</h2><p class="sub">${escapeHtml(metric.from)} · seconds · dots are runs, tall mark p50, short mark p90</p><div class="scroll">${chart(metric)}</div></section>`,
  ).join("");
  const flags = flagged.length
    ? `<section><h2>Flagged for review</h2><ul>${flagged.map((line) => `<li>${escapeHtml(line)}</li>`).join("")}</ul></section>`
    : "";
  return `<title>First-ten timing ${escapeHtml(release)}</title>
<meta name="claude:viewport-fit-sides" content="cover">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Source+Sans+3:wght@400;600;700&family=JetBrains+Mono:wght@400;600&display=swap">
<style>
/* Layout: one reading column; summary table, three strip charts, then every run. */
:root {
  --bg: #f6f7f9; --panel: #ffffff; --fg: #1b2230; --muted: #5b6577; --rule: #dde2ea;
  --long: #2f63c8; --short: #c26a0a; --link: #12857a; --goal: #b3261e; --ok: #1d7a3a;
  --body: "Source Sans 3", "Segoe UI", system-ui, sans-serif;
  --mono: "JetBrains Mono", ui-monospace, Menlo, monospace;
}
@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) {
  --bg: #12161d; --panel: #1a2029; --fg: #e6eaf1; --muted: #9aa5b8; --rule: #2c3442;
  --long: #7aa5f5; --short: #f0a24a; --link: #4fc8b8; --goal: #f2847b; --ok: #6fd08f; color-scheme: dark } }
:root[data-theme="dark"] {
  --bg: #12161d; --panel: #1a2029; --fg: #e6eaf1; --muted: #9aa5b8; --rule: #2c3442;
  --long: #7aa5f5; --short: #f0a24a; --link: #4fc8b8; --goal: #f2847b; --ok: #6fd08f; color-scheme: dark }
body { background: var(--bg); color: var(--fg); font: 16px/1.5 var(--body); }
main { max-width: 960px; margin: 0 auto; display: grid; gap: 28px; padding-block: 32px 48px;
  padding-left: max(16px, env(safe-area-inset-left, 0px)); padding-right: max(16px, env(safe-area-inset-right, 0px)); }
main > * { min-width: 0; }
h1 { font-size: 1.75rem; margin: 0; text-wrap: balance; }
h2 { font-size: 1.1rem; margin: 0 0 4px; }
.meta, .sub { color: var(--muted); margin: 4px 0 0; font-size: 0.9rem; }
.scroll { overflow-x: auto; }
table { border-collapse: collapse; width: 100%; font-variant-numeric: tabular-nums; background: var(--panel); }
th, td { padding: 8px 10px; border-bottom: 1px solid var(--rule); text-align: right; white-space: nowrap; font-size: 0.9rem; }
th[scope="row"], thead th:first-child { text-align: left; }
thead th { font-size: 0.75rem; letter-spacing: 0.04em; text-transform: uppercase; color: var(--muted); font-weight: 600; }
td, .tick { font-family: var(--mono); }
.group th { border-bottom: 0; padding-bottom: 0; text-align: center; color: var(--fg); }
.swatch { display: inline-block; width: 10px; height: 10px; border-radius: 50%; margin-right: 8px; background: currentColor; }
.s-long { color: var(--long); stroke: var(--long); fill: var(--long); }
.s-short { color: var(--short); stroke: var(--short); fill: var(--short); }
.s-link { color: var(--link); stroke: var(--link); fill: var(--link); }
.chart { background: var(--panel); border: 1px solid var(--rule); border-radius: 8px; padding: 16px; }
svg { display: block; width: 100%; min-width: 480px; height: auto; margin-top: 8px; }
.grid { stroke: var(--rule); stroke-width: 1; }
.tick { fill: var(--muted); font-size: 11px; }
.row-label { fill: var(--fg); font: 600 13px var(--body); }
.dot { fill-opacity: 0.75; stroke: none; }
.span { stroke-width: 6; stroke-opacity: 0.25; stroke-linecap: round; }
.mark { stroke: var(--fg); stroke-width: 2.5; }
.mark.thin { stroke-width: 1.5; }
.goal { stroke: var(--goal); stroke-width: 1.5; stroke-dasharray: 4 3; }
.goal-label { fill: var(--goal); font-size: 11px; font-family: var(--mono); }
.ok { color: var(--ok); } .warn { color: var(--goal); }
ul { margin: 8px 0 0; padding-left: 20px; color: var(--muted); }
</style>
<main>
<header>
<h1>First ten timing · ${escapeHtml(release)}</h1>
<p class="meta">${escapeHtml(startedAt.slice(0, 16).replace("T", " "))} UTC · ${rows.length} runs on new test roles · times from the chat's own event log</p>
</header>
<section class="scroll"><table>
<thead><tr class="group"><th></th><th></th><th></th>${METRICS.map((m) => `<th colspan="3">${escapeHtml(m.label)}</th>`).join("")}</tr>
<tr><th>JD</th><th>Runs</th><th>Passed</th>${METRICS.map(() => "<th>p50</th><th>p90</th><th>max</th>").join("")}</tr></thead>
<tbody>${statRows}</tbody></table></section>
${charts}
<section><h2>Every run</h2><div class="scroll"><table>
<thead><tr><th>Run</th><th>Q1</th><th>First people</th><th>All ten</th><th>Searched again</th><th>Ten before card</th><th>In area</th><th>Hiring-co. staff</th><th>Tool retries</th><th>Model retries</th><th>Result</th></tr></thead>
<tbody>${runRows}</tbody></table></div></section>
${flags}
</main>
`;
}
