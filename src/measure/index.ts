import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { BudgetConfig, Log, Measurement, PageMeasurement, Target } from "../types.js";
import { runLighthouse } from "./lighthouse.js";
import { startServer, type ServerHandle } from "./server.js";

export { normalizeScriptKey } from "./scripts.js";

export interface MeasureOptions {
  /** When set, every raw Lighthouse report is saved as `<reportDir>/<label>/<page>-run<N>.json`. */
  reportDir?: string;
}

/**
 * Starts every target's production server (each already built), measures every page
 * `config.runs` times per target with runs interleaved across targets, stops the
 * servers, and returns one Measurement per target in the same order.
 */
export async function measure(
  targets: Target[],
  config: BudgetConfig,
  log: Log,
  options: MeasureOptions = {},
): Promise<Measurement[]> {
  const servers: ServerHandle[] = [];
  const stopAll = () => Promise.all(servers.map((server) => server.stop()));
  // Ctrl-C / CI cancellation must not leave servers running in the background.
  const onSignal = (signal: NodeJS.Signals) => {
    void stopAll().finally(() => process.exit(signal === "SIGINT" ? 130 : 143));
  };
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);

  try {
    const started = await Promise.allSettled(targets.map((target) => startServer(target, config.server, log)));
    for (const result of started) if (result.status === "fulfilled") servers.push(result.value);
    const failed = started.find((result): result is PromiseRejectedResult => result.status === "rejected");
    if (failed) throw failed.reason;

    await warmUp(targets, config.pages, log);

    const measurements: Measurement[] = targets.map((target) => ({
      label: target.label,
      ref: target.ref,
      formFactor: config.formFactor,
      lighthouseVersion: "",
      pages: config.pages.map((page): PageMeasurement => ({ path: page, runs: [] })),
    }));

    for (let run = 0; run < config.runs; run++) {
      // Alternate which build goes first so slow drift (thermal throttling, a noisy
      // neighbour on the runner) hits both builds equally.
      const order = targets.map((_, index) => index);
      if (run % 2 === 1) order.reverse();

      for (const [pageIndex, page] of config.pages.entries()) {
        for (const targetIndex of order) {
          const target = targets[targetIndex]!;
          const measurement = measurements[targetIndex]!;
          const startedAt = Date.now();
          const { result, lhr } = await runLighthouse({
            url: `http://127.0.0.1:${target.port}${page}`,
            formFactor: config.formFactor,
            page,
            label: target.label,
            log,
          });
          measurement.lighthouseVersion = lhr.lighthouseVersion;
          measurement.pages[pageIndex]!.runs.push(result);
          if (options.reportDir) await saveReport(options.reportDir, target.label, page, run, lhr);

          const { performance, lcp } = result.values;
          const seconds = ((Date.now() - startedAt) / 1000).toFixed(1);
          log(
            `run ${run + 1}/${config.runs} · ${page} · ${target.label} · perf ${performance} · LCP ${(lcp / 1000).toFixed(1)} s  (${seconds} s)`,
          );
        }
      }
    }
    return measurements;
  } finally {
    process.removeListener("SIGINT", onSignal);
    process.removeListener("SIGTERM", onSignal);
    await stopAll();
  }
}

/**
 * One plain request per page per build, so first-hit work (server-side caches,
 * lazy route compilation, V8 warm-up) doesn't land in the first measured run.
 */
async function warmUp(targets: Target[], pages: string[], log: Log): Promise<void> {
  log(`Warming up ${pages.length} page(s) on ${targets.length} build(s)…`);
  await Promise.all(
    targets.flatMap((target) =>
      pages.map(async (page) => {
        const url = `http://127.0.0.1:${target.port}${page}`;
        try {
          const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
          await response.arrayBuffer();
          if (response.status >= 400) log(`[${target.label}] warning: ${page} returned HTTP ${response.status}`);
        } catch (error) {
          log(`[${target.label}] warning: warm-up request to ${page} failed: ${(error as Error).message}`);
        }
      }),
    ),
  );
}

async function saveReport(reportDir: string, label: string, page: string, run: number, lhr: unknown): Promise<void> {
  const dir = path.join(reportDir, label);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, `${slug(page)}-run${run + 1}.json`), JSON.stringify(lhr));
}

/** "/" → "home", "/products/blue-running-shoe" → "products-blue-running-shoe". */
export function slug(page: string): string {
  const cleaned = page
    .replace(/[?#].*$/, "")
    .replace(/[^A-Za-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase();
  return cleaned || "home";
}
