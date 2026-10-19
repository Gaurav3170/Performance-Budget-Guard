import { METRIC_IDS } from "../src/types.js";
import type { BudgetConfig, Measurement, MetricId, RunResult, ScriptAsset } from "../src/types.js";

/** Plausible defaults so tests only spell out the metric they care about. */
export const DEFAULT_VALUES: Record<MetricId, number> = {
  performance: 95,
  lcp: 1800,
  fcp: 900,
  tbt: 100,
  cls: 0.01,
  speedIndex: 1500,
  jsBytes: 150_000,
  totalBytes: 400_000,
};

/** Per-metric values for each run: a number repeats for every run, an array gives one value per run. */
export type RunSpec = Partial<Record<MetricId, number | number[]>>;

/** Builds `count` runs; `scripts` is a list per run (or one list reused for every run). */
export function runs(count: number, spec: RunSpec = {}, scripts: ScriptAsset[][] | ScriptAsset[] = []): RunResult[] {
  return Array.from({ length: count }, (_, index) => {
    const values = {} as Record<MetricId, number>;
    for (const id of METRIC_IDS) {
      const value = spec[id] ?? DEFAULT_VALUES[id];
      values[id] = Array.isArray(value) ? value[index]! : value;
    }
    const perRun = isNested(scripts) ? (scripts[index] ?? []) : scripts;
    return { values, scripts: perRun };
  });
}

function isNested(scripts: ScriptAsset[][] | ScriptAsset[]): scripts is ScriptAsset[][] {
  return Array.isArray(scripts[0]);
}

export function script(key: string, transferBytes: number): ScriptAsset {
  return { url: `https://localhost${key.replace("*", "abc123")}`, key, transferBytes };
}

export function measurement(label: "base" | "head", pages: Record<string, RunResult[]>, ref = label === "base" ? "main" : "feature"): Measurement {
  return {
    label,
    ref,
    formFactor: "mobile",
    lighthouseVersion: "12.8.2",
    pages: Object.entries(pages).map(([path, pageRuns]) => ({ path, runs: pageRuns })),
  };
}

export function config(overrides: Partial<BudgetConfig> = {}): BudgetConfig {
  return {
    pages: ["/"],
    runs: 5,
    formFactor: "mobile",
    server: { build: "npm run build", start: "npm run start", port: 4100, readyPath: "/", readyTimeoutMs: 60000 },
    budgets: {},
    maxIncrease: {},
    ...overrides,
  };
}
