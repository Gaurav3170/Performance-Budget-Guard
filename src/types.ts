/**
 * Shared contracts between the three parts of the tool:
 *
 *   measure/  starts each build's server and runs Lighthouse  ──► Measurement
 *   compare   medians, noise filtering and budget checks      ──► Comparison
 *   report    renders a Comparison as one PR comment          ──► markdown
 *
 * Every value is stored in its base unit: milliseconds, bytes, a 0–100 score, or
 * unitless (CLS). Formatting happens only in the report.
 */

export type MetricId = "performance" | "lcp" | "fcp" | "tbt" | "cls" | "speedIndex" | "jsBytes" | "totalBytes";

export type MetricUnit = "score" | "ms" | "bytes" | "unitless";

export interface MetricInfo {
  id: MetricId;
  label: string;
  unit: MetricUnit;
  higherIsBetter: boolean;
  /**
   * Absolute changes smaller than this are treated as measurement noise. Byte counts
   * are close to deterministic, so their floors are small; timings vary run to run.
   */
  noiseFloor: number;
}

/** Display order in the report. */
export const METRICS: readonly MetricInfo[] = [
  { id: "performance", label: "Performance score", unit: "score", higherIsBetter: true, noiseFloor: 3 },
  { id: "lcp", label: "Largest Contentful Paint", unit: "ms", higherIsBetter: false, noiseFloor: 100 },
  { id: "fcp", label: "First Contentful Paint", unit: "ms", higherIsBetter: false, noiseFloor: 100 },
  { id: "tbt", label: "Total Blocking Time", unit: "ms", higherIsBetter: false, noiseFloor: 30 },
  { id: "cls", label: "Cumulative Layout Shift", unit: "unitless", higherIsBetter: false, noiseFloor: 0.01 },
  { id: "speedIndex", label: "Speed Index", unit: "ms", higherIsBetter: false, noiseFloor: 150 },
  { id: "jsBytes", label: "JavaScript (transferred)", unit: "bytes", higherIsBetter: false, noiseFloor: 1024 },
  { id: "totalBytes", label: "Total transferred", unit: "bytes", higherIsBetter: false, noiseFloor: 2048 },
];

export const METRIC_IDS: readonly MetricId[] = METRICS.map((metric) => metric.id);

export function metricInfo(id: MetricId): MetricInfo {
  const info = METRICS.find((metric) => metric.id === id);
  if (!info) throw new Error(`Unknown metric "${id}"`);
  return info;
}

export type Log = (message: string) => void;

// ---------- Configuration (perf-budget.json) ----------

/** An allowed increase relative to the base build, e.g. "5%" or "50 ms". */
export type Limit = { kind: "absolute"; value: number } | { kind: "percent"; value: number };

export interface ServerConfig {
  /** Optional dependency install, run in each checkout before `build`, e.g. "npm ci". */
  install?: string;
  /** Production build, e.g. "npm run build". */
  build: string;
  /** Starts the production server. It must listen on the port given in the PORT environment variable. */
  start: string;
  /** Port for the head build; the base build uses port + 1. */
  port: number;
  /** Path polled until it responds, before measuring. Defaults to the first page. */
  readyPath: string;
  readyTimeoutMs: number;
}

/** Validated configuration with every quantity in its base unit. */
export interface BudgetConfig {
  /** Paths on the site, each starting with "/". */
  pages: string[];
  /** Lighthouse runs per page per build; the median is compared. */
  runs: number;
  formFactor: "desktop" | "mobile";
  server: ServerConfig;
  /** Absolute ceilings (floors for higher-is-better metrics) on the head build's median. */
  budgets: Partial<Record<MetricId, number>>;
  /** Largest allowed regression from base to head. */
  maxIncrease: Partial<Record<MetricId, Limit>>;
}

// ---------- Measurement ----------

export interface ScriptAsset {
  /** Full URL as requested. */
  url: string;
  /**
   * Stable identity across builds: path only, with content hashes replaced by "*",
   * so "/_next/static/chunks/app-3f2a91c0.js" in both builds is the same key.
   */
  key: string;
  transferBytes: number;
}

export interface RunResult {
  values: Record<MetricId, number>;
  scripts: ScriptAsset[];
}

export interface PageMeasurement {
  path: string;
  runs: RunResult[];
}

export interface Measurement {
  label: "base" | "head";
  /** Commit SHA, branch or tag that was measured. */
  ref: string;
  formFactor: "desktop" | "mobile";
  lighthouseVersion: string;
  pages: PageMeasurement[];
}

/** One build to measure: a checkout that has already been built. */
export interface Target {
  label: "base" | "head";
  ref: string;
  cwd: string;
  port: number;
}

// ---------- Comparison ----------

/** pass: within budget · warn: worth a look, doesn't block · fail: blocks the PR. */
export type Status = "pass" | "warn" | "fail";

export interface Stat {
  median: number;
  min: number;
  max: number;
}

export interface MetricComparison {
  metric: MetricId;
  base: Stat;
  head: Stat;
  /** head.median - base.median, in the metric's base unit. */
  delta: number;
  /** delta as a percentage of base.median; null when base.median is 0. */
  deltaPercent: number | null;
  /** Whether the change is larger than measurement noise (see compare.ts). */
  significant: boolean;
  /** True when the significant change is in the bad direction for this metric. */
  regressed: boolean;
  budget?: number;
  maxIncrease?: Limit;
  status: Status;
  /** Plain-language reasons for a warn or fail, e.g. "over the 170 kB budget". */
  reasons: string[];
}

export interface ScriptChange {
  key: string;
  kind: "added" | "removed" | "changed";
  baseBytes: number;
  headBytes: number;
  delta: number;
}

export interface PageComparison {
  path: string;
  metrics: MetricComparison[];
  /** Scripts that appeared, disappeared or changed size by more than the jsBytes noise floor, largest |delta| first. */
  scriptChanges: ScriptChange[];
  status: Status;
}

export interface Comparison {
  baseRef: string;
  headRef: string;
  formFactor: "desktop" | "mobile";
  runs: number;
  lighthouseVersion: string;
  pages: PageComparison[];
  status: Status;
}
