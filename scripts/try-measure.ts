/**
 * Local end-to-end check of the measurement layer: builds the static-store fixture
 * twice (normal as "base", PBG_FIXTURE_HEAVY=1 as "head"), measures both with real
 * Lighthouse and prints per-page medians side by side.
 *
 *   npx tsx scripts/try-measure.ts [runs] [--reports <dir>]
 */
import { cp, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runCommand } from "../src/exec.js";
import { measure } from "../src/measure/index.js";
import { METRICS, type BudgetConfig, type Measurement, type MetricId } from "../src/types.js";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fixture = path.join(repo, "fixtures", "static-store");
const args = process.argv.slice(2);
const runs = Number(args.find((arg) => /^\d+$/.test(arg)) ?? 3);
const reportsIndex = args.indexOf("--reports");
const reportDir = reportsIndex >= 0 ? path.resolve(args[reportsIndex + 1] ?? "lh-reports") : undefined;

const config: BudgetConfig = {
  pages: ["/", "/products", "/products/blue-running-shoe"],
  runs,
  formFactor: "mobile",
  server: { build: "npm run build", start: "npm run start", port: 4100, readyPath: "/", readyTimeoutMs: 30_000 },
  budgets: {},
  maxIncrease: {},
};

function stats(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
  return { median, min: sorted[0]!, max: sorted[sorted.length - 1]! };
}

function fmt(metric: MetricId, value: number): string {
  const unit = METRICS.find((info) => info.id === metric)!.unit;
  if (unit === "bytes") return `${(value / 1024).toFixed(1)} kB`;
  if (unit === "ms") return `${Math.round(value)} ms`;
  if (unit === "unitless") return value.toFixed(3);
  return String(Math.round(value));
}

function printTable(base: Measurement, head: Measurement): void {
  for (const [index, page] of base.pages.entries()) {
    const headPage = head.pages[index]!;
    console.log(`\n${page.path}`);
    for (const { id } of METRICS) {
      const b = stats(page.runs.map((run) => run.values[id]));
      const h = stats(headPage.runs.map((run) => run.values[id]));
      const range = (s: typeof b) => `${fmt(id, s.median)} [${fmt(id, s.min)} – ${fmt(id, s.max)}]`;
      console.log(`  ${id.padEnd(12)} base ${range(b).padEnd(34)} head ${range(h)}`);
    }
    const scripts = headPage.runs[0]?.scripts.map((script) => `${script.key} (${fmt("jsBytes", script.transferBytes)})`);
    console.log(`  head scripts: ${scripts?.join(", ") ?? "none"}`);
  }
}

async function main(): Promise<void> {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "pbg-try-"));
  const baseDir = path.join(tmp, "base");
  const headDir = path.join(tmp, "head");
  const copyOptions = { recursive: true, filter: (src: string) => !src.includes(`${path.sep}dist`) };
  try {
    await cp(fixture, baseDir, copyOptions);
    await cp(fixture, headDir, copyOptions);
    await runCommand(config.server.build, { cwd: baseDir, log: console.log });
    await runCommand(config.server.build, { cwd: headDir, env: { PBG_FIXTURE_HEAVY: "1" }, log: console.log });

    const started = Date.now();
    const [base, head] = await measure(
      [
        { label: "base", ref: "normal", cwd: baseDir, port: 4100 },
        { label: "head", ref: "heavy", cwd: headDir, port: 4101 },
      ],
      config,
      console.log,
      { reportDir },
    );
    console.log(`\nMeasured in ${((Date.now() - started) / 1000).toFixed(0)} s with Lighthouse ${base!.lighthouseVersion}`);
    printTable(base!, head!);
  } finally {
    await rm(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
