import { METRICS, metricInfo } from "./types.js";
import type {
  BudgetConfig,
  Comparison,
  Measurement,
  MetricComparison,
  MetricInfo,
  PageComparison,
  PageMeasurement,
  RunResult,
  ScriptChange,
  Stat,
  Status,
} from "./types.js";
import { formatChange, formatLimit, formatValue } from "./report.js";

/** Script changes listed per page; the rest is noise in a PR comment. */
const MAX_SCRIPT_CHANGES = 10;

const SEVERITY: Record<Status, number> = { pass: 0, warn: 1, fail: 2 };

/** Median, min and max of a non-empty list. */
export function summarize(values: number[]): Stat {
  if (values.length === 0) throw new Error("summarize: no values");
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 === 1 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
  return { median, min: sorted[0]!, max: sorted[sorted.length - 1]! };
}

/** Compares the base and head measurements page by page and applies the budget. */
export function compare(base: Measurement, head: Measurement, config: BudgetConfig): Comparison {
  const pages = config.pages.map((path) => comparePage(findPage(base, path), findPage(head, path), config));
  return {
    baseRef: base.ref,
    headRef: head.ref,
    formFactor: config.formFactor,
    runs: config.runs,
    lighthouseVersion: head.lighthouseVersion,
    pages,
    status: worst(pages.map((page) => page.status)),
  };
}

/** The more severe of the given statuses; "pass" for none. */
export function worst(statuses: Status[]): Status {
  return statuses.reduce<Status>((a, b) => (SEVERITY[b] > SEVERITY[a] ? b : a), "pass");
}

/**
 * A change is significant when |delta| exceeds the metric's noise floor, its relative
 * floor (a fraction of the base median), and half of the larger run-to-run spread
 * (max − min) seen in either build. Byte counts barely vary between runs, so their
 * absolute floor decides. Timings must move by more than all three, because their noise
 * grows with the value and five runs rarely show the full spread.
 */
export function isSignificant(info: MetricInfo, base: Stat, head: Stat): boolean {
  const delta = Math.abs(head.median - base.median);
  const relative = info.relativeFloor * Math.abs(base.median);
  const halfSpread = Math.max(base.max - base.min, head.max - head.min) / 2;
  return delta > info.noiseFloor && delta > relative && delta > halfSpread;
}

function findPage(measurement: Measurement, path: string): PageMeasurement {
  const page = measurement.pages.find((candidate) => candidate.path === path);
  if (!page || page.runs.length === 0) {
    throw new Error(`The ${measurement.label} measurement (${measurement.ref}) has no results for page "${path}"`);
  }
  return page;
}

function comparePage(base: PageMeasurement, head: PageMeasurement, config: BudgetConfig): PageComparison {
  const metrics = METRICS.map((info) => compareMetric(info, base.runs, head.runs, config));
  return {
    path: base.path,
    metrics,
    scriptChanges: compareScripts(base.runs, head.runs),
    status: worst(metrics.map((metric) => metric.status)),
  };
}

function compareMetric(info: MetricInfo, baseRuns: RunResult[], headRuns: RunResult[], config: BudgetConfig): MetricComparison {
  const base = summarize(baseRuns.map((run) => run.values[info.id]));
  const head = summarize(headRuns.map((run) => run.values[info.id]));
  const delta = head.median - base.median;
  const deltaPercent = base.median === 0 ? null : (delta / base.median) * 100;
  const significant = isSignificant(info, base, head);
  const regressed = significant && (info.higherIsBetter ? delta < 0 : delta > 0);

  const result: MetricComparison = { metric: info.id, base, head, delta, deltaPercent, significant, regressed, status: "pass", reasons: [] };
  const flag = (status: Status, reason: string): void => {
    result.status = worst([result.status, status]);
    result.reasons.push(reason);
  };

  const budget = config.budgets[info.id];
  if (budget !== undefined) {
    result.budget = budget;
    const over = (value: number): boolean => (info.higherIsBetter ? value < budget : value > budget);
    const what = `${info.higherIsBetter ? "below" : "over"} the ${formatValue(info.id, budget)} budget`;
    // Debt that already exists on the base branch shouldn't block an unrelated PR.
    if (over(head.median) && over(base.median) && !regressed) flag("warn", `already ${what} on the base branch`);
    else if (over(head.median)) flag("fail", what);
  }

  const limit = config.maxIncrease[info.id];
  if (limit !== undefined) result.maxIncrease = limit;
  if (regressed && limit !== undefined) {
    const amount = limit.kind === "absolute" ? Math.abs(delta) : deltaPercent === null ? Infinity : Math.abs(deltaPercent);
    if (amount > limit.value) {
      flag("fail", `${formatChange(info.id, delta, deltaPercent)}, more than the allowed ${formatLimit(info.id, limit)}`);
    }
  } else if (regressed && result.status === "pass") {
    // Only when nothing else flagged it: "over budget" already says the same thing louder.
    flag("warn", `got worse by ${formatValue(info.id, Math.abs(delta))}`);
  }
  return result;
}

/**
 * Per-script byte changes. Within a run, assets sharing a key are summed (several hashed
 * chunks can normalize to the same key). A key counts as present in a build when it shows
 * up in at least half of that build's runs, so a lazily loaded chunk that only sometimes
 * makes it into the trace doesn't show up as added or removed.
 */
function compareScripts(baseRuns: RunResult[], headRuns: RunResult[]): ScriptChange[] {
  const base = scriptSizes(baseRuns);
  const head = scriptSizes(headRuns);
  const noiseFloor = metricInfo("jsBytes").noiseFloor;
  const changes: ScriptChange[] = [];
  for (const key of new Set([...base.keys(), ...head.keys()])) {
    const baseBytes = base.get(key) ?? 0;
    const headBytes = head.get(key) ?? 0;
    const delta = headBytes - baseBytes;
    const kind = !base.has(key) ? "added" : !head.has(key) ? "removed" : Math.abs(delta) > noiseFloor ? "changed" : undefined;
    if (kind) changes.push({ key, kind, baseBytes, headBytes, delta });
  }
  return changes.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta)).slice(0, MAX_SCRIPT_CHANGES);
}

/** Median transferred bytes per script key, for keys present in at least half the runs. */
export function scriptSizes(runs: RunResult[]): Map<string, number> {
  const perKey = new Map<string, number[]>();
  for (const run of runs) {
    const sums = new Map<string, number>();
    for (const script of run.scripts) sums.set(script.key, (sums.get(script.key) ?? 0) + script.transferBytes);
    for (const [key, bytes] of sums) perKey.set(key, [...(perKey.get(key) ?? []), bytes]);
  }
  const needed = Math.ceil(runs.length / 2);
  const sizes = new Map<string, number>();
  for (const [key, values] of perKey) {
    if (values.length >= needed) sizes.set(key, summarize(values).median);
  }
  return sizes;
}
