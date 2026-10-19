import { test } from "node:test";
import assert from "node:assert/strict";
import { compare } from "../src/compare.js";
import { COMMENT_MARKER, MAX_COMMENT_LENGTH, extractCurrent, formatDelta, formatValue, renderComment } from "../src/report.js";
import type { BudgetConfig, Comparison } from "../src/types.js";
import { config, measurement, runs, script, type RunSpec } from "./helpers.js";

const SHA_BASE = "abc1234".padEnd(40, "0");
const SHA_HEAD = "def5678".padEnd(40, "0");

/** Builds a comparison from per-page base/head specs (5 identical runs each). */
function build(pages: Record<string, [RunSpec, RunSpec]>, overrides: Partial<BudgetConfig> = {}, scripts: Record<string, [ReturnType<typeof script>[], ReturnType<typeof script>[]]> = {}): Comparison {
  const entries = Object.entries(pages);
  const base = measurement("base", Object.fromEntries(entries.map(([path, [b]]) => [path, runs(5, b, scripts[path]?.[0] ?? [])])), SHA_BASE);
  const head = measurement("head", Object.fromEntries(entries.map(([path, [, h]]) => [path, runs(5, h, scripts[path]?.[1] ?? [])])), SHA_HEAD);
  return compare(base, head, config({ pages: Object.keys(pages), ...overrides }));
}

test("formatValue", () => {
  assert.equal(formatValue("tbt", 120.4), "120 ms");
  assert.equal(formatValue("lcp", 2140), "2.1 s");
  assert.equal(formatValue("lcp", 999.7), "1.0 s");
  assert.equal(formatValue("jsBytes", 512), "512 B");
  assert.equal(formatValue("jsBytes", 12_300), "12.3 kB");
  assert.equal(formatValue("jsBytes", 148_200), "148 kB");
  assert.equal(formatValue("totalBytes", 1_234_567), "1.23 MB");
  assert.equal(formatValue("performance", 97.6), "98");
  assert.equal(formatValue("cls", 0.0421), "0.042");
  assert.equal(formatValue("cls", 0.1), "0.1");
  assert.equal(formatValue("cls", 0), "0");
});

test("formatDelta", () => {
  assert.equal(formatDelta("jsBytes", 73_000), "+73.0 kB");
  assert.equal(formatDelta("jsBytes", 150_000), "+150 kB");
  assert.equal(formatDelta("lcp", -100), "-100 ms");
  assert.equal(formatDelta("lcp", -1500), "-1.5 s");
  assert.equal(formatDelta("tbt", 170), "+170 ms");
  assert.equal(formatDelta("performance", 3), "+3");
  assert.equal(formatDelta("cls", -0.012), "-0.012");
  assert.equal(formatDelta("tbt", 0), "±0");
});

test("failing comment: headline, subtitle, tables, reasons, scripts and quiet pages", () => {
  const comparison = build(
    {
      "/": [{}, {}],
      "/products": [{}, {}],
      "/products/blue-running-shoe": [{ jsBytes: 148_000, tbt: 120 }, { jsBytes: 221_000, tbt: 290 }],
    },
    { budgets: { jsBytes: 170_000, tbt: 200 }, maxIncrease: { jsBytes: { kind: "percent", value: 5 }, tbt: { kind: "absolute", value: 50 } } },
    { "/products/blue-running-shoe": [[script("/_next/static/chunks/app/products/*.js", 12_000)], [script("/_next/static/chunks/app/products/*.js", 85_000)]] },
  );
  const body = renderComment(comparison, { runUrl: "https://github.com/o/r/actions/runs/1" });
  assert.ok(body.startsWith(`${COMMENT_MARKER}\n<!-- pbg:current:start -->\n### 🔴 Perf Budget Guard: 1 of 3 pages over budget\n`));
  assert.match(body, /Mobile · median of 5 runs · Lighthouse 12\.8\.2 · `abc1234` \(base\) → `def5678` \(head\)/);
  assert.match(body, /#### 🔴 `\/products\/blue-running-shoe`/);
  assert.match(body, /\| JavaScript \(transferred\) \| 148 kB \| 221 kB \| \*\*\+73\.0 kB \(\+49%\)\*\* \| 170 kB · max \+5% \|/);
  assert.match(body, /\| Total Blocking Time \| 120 ms \| 290 ms \| \*\*\+170 ms \(\+142%\)\*\* \| 200 ms · max \+50 ms \|/);
  assert.match(body, /- \*\*JavaScript \(transferred\):\*\* over the 170 kB budget/);
  assert.match(body, /- \*\*Total Blocking Time:\*\* \+170 ms \(\+142%\), more than the allowed \+50 ms/);
  assert.match(body, /\| `\/_next\/static\/chunks\/app\/products\/\*\.js` \| 12\.0 kB \| 85\.0 kB \| \+73\.0 kB \|/);
  assert.match(body, /<details><summary>All metrics<\/summary>\n\n\| Metric[^]*\| Performance score \| 95 \| 95 \| ±0 \| — \|/);
  assert.match(body, /✅ No significant changes: `\/`, `\/products`\n<!-- pbg:current:end -->/);
  assert.ok(body.trimEnd().endsWith("<sub>Changes smaller than run-to-run noise are ignored. [Workflow run](https://github.com/o/r/actions/runs/1)</sub>"));
  assert.doesNotMatch(body, /Previous run/);

  // The main table only lists metrics worth attention.
  const mainTable = body.slice(body.indexOf("#### 🔴"), body.indexOf("<details>"));
  assert.doesNotMatch(mainTable, /Largest Contentful Paint/);
});

test("warn and pass headlines pluralize", () => {
  const warnOne = build({ "/": [{ tbt: 100 }, { tbt: 300 }] });
  assert.match(renderComment(warnOne), /### 🟡 Perf Budget Guard: no budget broken, 1 change worth a look/);
  const warnTwo = build({ "/": [{ tbt: 100, lcp: 1800 }, { tbt: 300, lcp: 2400 }] });
  assert.match(renderComment(warnTwo), /no budget broken, 2 changes worth a look/);

  const pass = build({ "/": [{}, {}], "/a": [{}, {}] });
  const body = renderComment(pass);
  assert.match(body, /### 🟢 Perf Budget Guard: all 2 pages within budget/);
  assert.match(body, /✅ No significant changes: `\/`, `\/a`/);
  assert.match(body, /<sub>Changes smaller than run-to-run noise are ignored\.<\/sub>/, "no link without runUrl");
  assert.match(renderComment(build({ "/": [{}, {}] })), /🟢 Perf Budget Guard: 1 page within budget/);
  assert.match(renderComment(build({ "/": [{}, {}] }, { formFactor: "desktop", runs: 1 })), /\nDesktop · 1 run ·/);
});

test("an improvement gets its own section even though it passes", () => {
  const body = renderComment(build({ "/": [{ lcp: 2500 }, { lcp: 1800 }] }));
  assert.match(body, /#### 🟢 `\/`/);
  assert.match(body, /\| Largest Contentful Paint \| 2\.5 s \| 1\.8 s \| \*\*-700 ms \(-28%\)\*\* \| — \|/);
  assert.doesNotMatch(body, /No significant changes/);
});

test("non-SHA refs are shown as given", () => {
  const comparison = { ...build({ "/": [{}, {}] }), baseRef: "main", headRef: "feature/x" };
  assert.match(renderComment(comparison), /`main` \(base\) → `feature\/x` \(head\)/);
});

test("pipes and backticks in script keys are escaped", () => {
  const key = "/weird|name`x`.js";
  const comparison = build({ "/": [{}, {}] }, {}, { "/": [[], [script(key, 5000)]] });
  const body = renderComment(comparison);
  assert.ok(body.includes("| `` /weird\\|name`x`.js `` | — | 5.0 kB | +5.0 kB (added) |"), body);
});

test("previous run is carried over once, never nested", () => {
  const failing = build({ "/": [{ tbt: 100 }, { tbt: 400 }] }, { budgets: { tbt: 200 } });
  const fixed = build({ "/": [{}, {}] });
  const first = renderComment(failing);
  const second = renderComment(fixed, { previousBody: first });
  const third = renderComment(fixed, { previousBody: second });

  assert.match(second, /<details><summary>Previous run<\/summary>\n\n### 🔴 Perf Budget Guard/);
  assert.equal(extractCurrent(second), extractCurrent(renderComment(fixed)));
  assert.equal(third.split("Previous run").length - 1, 1, "only one previous run");
  assert.doesNotMatch(third, /🔴/, "the run before last is gone");
  assert.equal(third.split(COMMENT_MARKER).length - 1, 1);

  assert.doesNotMatch(renderComment(fixed, { previousBody: "someone else's comment" }), /Previous run/);
});

test("stays under the length cap with many pages", () => {
  const pages: Record<string, [RunSpec, RunSpec]> = {};
  const scripts: Record<string, [ReturnType<typeof script>[], ReturnType<typeof script>[]]> = {};
  for (let i = 0; i < 400; i++) {
    const path = `/products/item-with-a-fairly-long-name-${i}`;
    pages[path] = [{ tbt: 100, jsBytes: 100_000 }, { tbt: 400, jsBytes: 300_000 }];
    scripts[path] = [[], Array.from({ length: 10 }, (_, j) => script(`/_next/static/chunks/page-${i}-${j}-*.js`, 20_000))];
  }
  const comparison = build(pages, { budgets: { tbt: 200 } }, scripts);
  const body = renderComment(comparison, { previousBody: renderComment(comparison), runUrl: "https://example.com/run" });
  assert.ok(body.length <= MAX_COMMENT_LENGTH, `length ${body.length}`);
  assert.ok(body.startsWith(COMMENT_MARKER));
  assert.match(body, /<!-- pbg:current:end -->/);
  assert.match(body, /\[Workflow run\]\(https:\/\/example\.com\/run\)/);
  assert.match(body, /400 of 400 pages over budget/);
});
