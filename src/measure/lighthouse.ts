import * as chromeLauncher from "chrome-launcher";
import lighthouse, { desktopConfig, type Config, type Result } from "lighthouse";
import type { MetricId, RunResult, ScriptAsset } from "../types.js";
import { normalizeScriptKey } from "./scripts.js";

export interface LighthouseRun {
  result: RunResult;
  lhr: Result;
}

export interface RunOptions {
  url: string;
  formFactor: "desktop" | "mobile";
  /** For error messages: which page and build this run belongs to. */
  page: string;
  label: string;
  /** Reports a failed attempt before it is retried. */
  log?: (message: string) => void;
}

/**
 * Upper bound for one attempt. A healthy run takes ~10 s; Chrome occasionally stalls
 * (we saw a 5-minute hang on Windows), and a stalled run should be retried, not waited out.
 */
const ATTEMPT_TIMEOUT_MS = 120_000;

const CHROME_FLAGS = [
  "--headless=new",
  "--no-first-run",
  "--disable-dev-shm-usage",
  // GitHub's Linux runners run as root in a container-like sandbox where Chrome's
  // own sandbox can't start; elsewhere keep it.
  ...(process.platform === "linux" ? ["--no-sandbox"] : []),
];

const AUDIT_FOR: Partial<Record<MetricId, string>> = {
  lcp: "largest-contentful-paint",
  fcp: "first-contentful-paint",
  tbt: "total-blocking-time",
  cls: "cumulative-layout-shift",
  speedIndex: "speed-index",
  totalBytes: "total-byte-weight",
};

/**
 * One Lighthouse run in a freshly launched Chrome, so no cache, service worker or
 * JIT state leaks between runs. Retries once on a Lighthouse runtime error or a
 * missing metric, which on CI is usually a transient Chrome hiccup.
 */
export async function runLighthouse(options: RunOptions): Promise<LighthouseRun> {
  try {
    return await runOnce(options);
  } catch (first) {
    options.log?.(`[${options.label}] Lighthouse attempt on ${options.page} failed, retrying: ${(first as Error).message}`);
    try {
      return await runOnce(options);
    } catch (second) {
      const reason = (second as Error).message;
      const firstReason = (first as Error).message;
      throw new Error(
        `Lighthouse failed twice on ${options.page} (${options.label} build): ${reason}` +
          (firstReason !== reason ? ` (first attempt: ${firstReason})` : ""),
      );
    }
  }
}

async function runOnce({ url, formFactor }: RunOptions): Promise<LighthouseRun> {
  // handleSIGINT: false — the caller owns Ctrl-C handling and must stop the servers too.
  const chrome = await chromeLauncher.launch({ chromeFlags: CHROME_FLAGS, logLevel: "silent", handleSIGINT: false });
  try {
    const config: Config | undefined = formFactor === "desktop" ? desktopConfig : undefined;
    const run = lighthouse(
      url,
      { port: chrome.port, output: "json", logLevel: "error", onlyCategories: ["performance"] },
      config,
    );
    // Killing Chrome on timeout makes the abandoned run reject; swallow that.
    run.catch(() => {});
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`TIMEOUT: no result after ${ATTEMPT_TIMEOUT_MS / 1000} s`)),
        ATTEMPT_TIMEOUT_MS,
      );
    });
    const runner = await Promise.race([run, timeout]).finally(() => clearTimeout(timer));
    if (!runner) throw new Error("Lighthouse returned no result");
    const lhr = runner.lhr;
    if (lhr.runtimeError) throw new Error(`${lhr.runtimeError.code}: ${lhr.runtimeError.message}`);
    return { result: extractRunResult(lhr), lhr };
  } finally {
    chrome.kill();
  }
}

interface NetworkRequestItem {
  url?: string;
  resourceType?: string;
  transferSize?: number;
}

/** Turns a Lighthouse result into our metrics; throws if any metric is missing. */
export function extractRunResult(lhr: Result): RunResult {
  const score = lhr.categories["performance"]?.score;
  const values: Partial<Record<MetricId, number>> = {
    performance: typeof score === "number" ? Math.round(score * 100) : NaN,
  };
  for (const [metric, auditId] of Object.entries(AUDIT_FOR) as [MetricId, string][]) {
    values[metric] = lhr.audits[auditId]?.numericValue ?? NaN;
  }

  const origin = new URL(lhr.finalDisplayedUrl || lhr.requestedUrl || "http://localhost").origin;
  const details = lhr.audits["network-requests"]?.details as { items?: NetworkRequestItem[] } | undefined;
  const scripts: ScriptAsset[] = (details?.items ?? [])
    .filter((item) => item.resourceType === "Script" && typeof item.url === "string")
    .map((item) => ({
      url: item.url as string,
      key: normalizeScriptKey(item.url as string, origin),
      transferBytes: item.transferSize ?? 0,
    }));
  values.jsBytes = scripts.reduce((sum, script) => sum + script.transferBytes, 0);

  const missing = Object.entries(values)
    .filter(([, value]) => !Number.isFinite(value))
    .map(([metric]) => metric);
  if (!details?.items) missing.push("network-requests");
  if (missing.length) {
    const warnings = lhr.runWarnings?.length ? ` — ${lhr.runWarnings.join("; ")}` : "";
    throw new Error(`NO_METRICS: missing ${missing.join(", ")}${warnings}`);
  }
  return { values: values as Record<MetricId, number>, scripts };
}
