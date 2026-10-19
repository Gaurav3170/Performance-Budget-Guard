import { test } from "node:test";
import assert from "node:assert/strict";
import { compare, scriptSizes, summarize } from "../src/compare.js";
import type { MetricId } from "../src/types.js";
import { config, measurement, runs, script, type RunSpec } from "./helpers.js";
import type { BudgetConfig } from "../src/types.js";

/** Compares a single page "/" and returns one metric's result plus the whole comparison. */
function one(metric: MetricId, base: RunSpec, head: RunSpec, overrides: Partial<BudgetConfig> = {}) {
  const comparison = compare(measurement("base", { "/": runs(5, base) }), measurement("head", { "/": runs(5, head) }), config(overrides));
  const result = comparison.pages[0]!.metrics.find((m) => m.metric === metric)!;
  return { result, comparison };
}

test("summarize: odd and even counts", () => {
  assert.deepEqual(summarize([3, 1, 2]), { median: 2, min: 1, max: 3 });
  assert.deepEqual(summarize([4, 1, 3, 2]), { median: 2.5, min: 1, max: 4 });
  assert.deepEqual(summarize([7]), { median: 7, min: 7, max: 7 });
  assert.throws(() => summarize([]));
});

test("significance: below the noise floor is ignored", () => {
  const { result } = one("tbt", { tbt: 100 }, { tbt: 125 });
  assert.equal(result.delta, 25);
  assert.equal(result.significant, false);
  assert.equal(result.status, "pass");
});

test("significance: a change inside the run-to-run spread is ignored", () => {
  // Delta 60 > floor 30, but head runs span 200 ms, so half-spread 100 swallows it.
  const { result } = one("tbt", { tbt: 100 }, { tbt: [60, 160, 160, 160, 260] });
  assert.equal(result.delta, 60);
  assert.equal(result.significant, false);
});

test("significance: a change beyond floor and spread counts, and warns without a limit", () => {
  const { result, comparison } = one("tbt", { tbt: [110, 120, 120, 120, 130] }, { tbt: [280, 290, 290, 290, 300] });
  assert.equal(result.significant, true);
  assert.equal(result.regressed, true);
  assert.equal(result.status, "warn");
  assert.deepEqual(result.reasons, ["got worse by 170 ms"]);
  assert.equal(comparison.status, "warn");
});

test("improvements are significant but not regressions", () => {
  const { result } = one("lcp", { lcp: 2500 }, { lcp: 1800 });
  assert.equal(result.significant, true);
  assert.equal(result.regressed, false);
  assert.equal(result.status, "pass");
  assert.ok(Math.abs(result.deltaPercent! - -28) < 1e-9);
});

test("budget: head over budget fails", () => {
  const { result, comparison } = one("jsBytes", { jsBytes: 148_000 }, { jsBytes: 221_000 }, { budgets: { jsBytes: 170_000 } });
  assert.equal(result.status, "fail");
  assert.equal(result.budget, 170_000);
  assert.deepEqual(result.reasons, ["over the 170 kB budget"]);
  assert.equal(comparison.status, "fail");
});

test("budget: debt that already exists on base only warns", () => {
  const { result } = one("jsBytes", { jsBytes: 180_000 }, { jsBytes: 180_500 }, { budgets: { jsBytes: 170_000 } });
  assert.equal(result.significant, false);
  assert.equal(result.status, "warn");
  assert.deepEqual(result.reasons, ["already over the 170 kB budget on the base branch"]);
});

test("budget: making existing debt worse fails", () => {
  const { result } = one("jsBytes", { jsBytes: 180_000 }, { jsBytes: 200_000 }, { budgets: { jsBytes: 170_000 } });
  assert.equal(result.status, "fail");
  assert.equal(result.reasons[0], "over the 170 kB budget");
});

test("budget: higher-is-better score below its floor fails", () => {
  const { result } = one("performance", { performance: 95 }, { performance: 85 }, { budgets: { performance: 90 } });
  assert.equal(result.regressed, true);
  assert.equal(result.status, "fail");
  assert.equal(result.reasons[0], "below the 90 budget");
});

test("higher-is-better: a score rise is not a regression", () => {
  const { result } = one("performance", { performance: 80 }, { performance: 95 });
  assert.equal(result.significant, true);
  assert.equal(result.regressed, false);
  assert.equal(result.status, "pass");
});

test("maxIncrease: percent limit", () => {
  const limit = { maxIncrease: { jsBytes: { kind: "percent" as const, value: 5 } } };
  const over = one("jsBytes", { jsBytes: 148_000 }, { jsBytes: 221_000 }, limit).result;
  assert.equal(over.status, "fail");
  assert.deepEqual(over.reasons, ["+73.0 kB (+49%), more than the allowed +5%"]);

  const within = one("jsBytes", { jsBytes: 148_000 }, { jsBytes: 152_000 }, limit).result;
  assert.equal(within.regressed, true);
  assert.equal(within.status, "pass", "a regression inside the allowed increase passes");
});

test("maxIncrease: absolute limit", () => {
  const limit = { maxIncrease: { tbt: { kind: "absolute" as const, value: 50 } } };
  const { result } = one("tbt", { tbt: 120 }, { tbt: 290 }, limit);
  assert.equal(result.status, "fail");
  assert.deepEqual(result.reasons, ["+170 ms (+142%), more than the allowed +50 ms"]);
});

test("maxIncrease: percent limit with a zero base counts as exceeded", () => {
  const { result } = one("tbt", { tbt: 0 }, { tbt: 200 }, { maxIncrease: { tbt: { kind: "percent", value: 5 } } });
  assert.equal(result.deltaPercent, null);
  assert.equal(result.status, "fail");
});

test("statuses roll up to the page and the comparison; metadata comes from config and head", () => {
  const base = measurement("base", { "/": runs(5), "/a": runs(5) }, "a".repeat(40));
  const head = measurement("head", { "/": runs(5), "/a": runs(5, { tbt: 400 }) });
  head.lighthouseVersion = "12.9.0";
  const comparison = compare(base, head, config({ pages: ["/", "/a"], runs: 5, formFactor: "desktop", budgets: { tbt: 200 } }));
  assert.deepEqual(comparison.pages.map((page) => page.status), ["pass", "fail"]);
  assert.equal(comparison.status, "fail");
  assert.equal(comparison.baseRef, "a".repeat(40));
  assert.equal(comparison.formFactor, "desktop");
  assert.equal(comparison.lighthouseVersion, "12.9.0");
});

test("missing page in a measurement is a clear error", () => {
  assert.throws(
    () => compare(measurement("base", { "/": runs(3) }), measurement("head", {}), config()),
    /head measurement \(feature\) has no results for page "\/"/,
  );
});

test("scriptSizes: sums assets sharing a key within a run and takes the median across runs", () => {
  const sizes = scriptSizes(
    runs(3, {}, [
      [script("/chunks/*.js", 1000), script("/chunks/*.js", 500), script("/main.js", 100)],
      [script("/chunks/*.js", 2000), script("/main.js", 100)],
      [script("/chunks/*.js", 1600), script("/main.js", 100)],
    ]),
  );
  assert.equal(sizes.get("/chunks/*.js"), 1600);
  assert.equal(sizes.get("/main.js"), 100);
});

test("scriptSizes: a key must appear in at least half the runs (rounded up)", () => {
  const lazy = script("/lazy.js", 5000);
  assert.equal(scriptSizes(runs(5, {}, [[lazy], [lazy], [], [], []])).has("/lazy.js"), false, "2 of 5 is not enough");
  assert.equal(scriptSizes(runs(5, {}, [[lazy], [lazy], [lazy], [], []])).has("/lazy.js"), true, "3 of 5 is");
  assert.equal(scriptSizes(runs(4, {}, [[lazy], [lazy], [], []])).has("/lazy.js"), true, "2 of 4 is");
});

test("script changes: added, removed and changed, largest first, small changes ignored", () => {
  const baseScripts = [script("/main.js", 50_000), script("/old.js", 3000), script("/same.js", 10_000), script("/app/*.js", 12_000)];
  const headScripts = [script("/main.js", 50_500), script("/new.js", 8000), script("/same.js", 10_000), script("/app/*.js", 85_000)];
  const comparison = compare(measurement("base", { "/": runs(3, {}, baseScripts) }), measurement("head", { "/": runs(3, {}, headScripts) }), config());
  assert.deepEqual(comparison.pages[0]!.scriptChanges, [
    { key: "/app/*.js", kind: "changed", baseBytes: 12_000, headBytes: 85_000, delta: 73_000 },
    { key: "/new.js", kind: "added", baseBytes: 0, headBytes: 8000, delta: 8000 },
    { key: "/old.js", kind: "removed", baseBytes: 3000, headBytes: 0, delta: -3000 },
  ]);
});

test("script changes: at most 10 per page", () => {
  const headScripts = Array.from({ length: 15 }, (_, i) => script(`/s${i}.js`, 1000 * (i + 1)));
  const comparison = compare(measurement("base", { "/": runs(1) }), measurement("head", { "/": runs(1, {}, headScripts) }), config());
  const changes = comparison.pages[0]!.scriptChanges;
  assert.equal(changes.length, 10);
  assert.equal(changes[0]!.key, "/s14.js");
});
