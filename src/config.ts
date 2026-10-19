import { readFile } from "node:fs/promises";
import { METRIC_IDS, metricInfo } from "./types.js";
import type { BudgetConfig, Limit, MetricId, MetricUnit, ServerConfig } from "./types.js";

/** Default config file name, looked up in the working directory. */
export const DEFAULT_CONFIG_FILE = "perf-budget.json";

const TOP_LEVEL_KEYS = ["pages", "runs", "formFactor", "server", "budgets", "maxIncrease"];
const SERVER_KEYS = ["install", "build", "start", "port", "readyPath", "readyTimeoutMs"];

/** SI kilobytes (1000) match what Chrome DevTools shows; KiB/MiB are there for people who think in powers of two. */
const SIZE_UNITS: Record<string, number> = { b: 1, kb: 1000, kib: 1024, mb: 1e6, mib: 1024 * 1024 };
const TIME_UNITS: Record<string, number> = { ms: 1, s: 1000 };

/** What each kind of metric accepts, used to finish error messages. */
const EXPECTED: Record<MetricUnit, string> = {
  bytes: "a size (use B, kB, KiB, MB or MiB)",
  ms: "a duration (use ms or s)",
  score: "a score (a number from 0 to 100)",
  unitless: "a plain number",
};

type Fail = (field: string, message: string) => never;

/**
 * Reads and validates a perf-budget.json file, applying defaults and converting every
 * quantity to its base unit. Throws an Error naming the file and the bad field.
 */
export async function loadConfig(path: string): Promise<BudgetConfig> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    throw new Error(`${path}: could not read the config file (${(error as Error).message})`);
  }
  let raw: unknown;
  try {
    // Strip a BOM: some Windows editors add one and JSON.parse rejects it.
    raw = JSON.parse(text.replace(/^﻿/, ""));
  } catch (error) {
    throw new Error(`${path}: invalid JSON (${(error as Error).message})`);
  }
  return parseConfig(raw, path);
}

/** Validates an already-parsed config object. `source` names it in error messages. */
export function parseConfig(raw: unknown, source: string): BudgetConfig {
  const fail: Fail = (field, message) => {
    throw new Error(`${source}: ${field ? `${field}: ` : ""}${message}`);
  };
  if (!isObject(raw)) return fail("", "the config must be a JSON object");
  checkKeys(raw, TOP_LEVEL_KEYS, "", fail);

  const pages = parsePages(raw.pages, fail);
  const formFactor = raw.formFactor ?? "mobile";
  if (formFactor !== "mobile" && formFactor !== "desktop") {
    fail("formFactor", `${show(formFactor)} must be "mobile" or "desktop"`);
  }
  return {
    pages,
    runs: optionalInteger(raw.runs, "runs", 1, 15, fail) ?? 5,
    formFactor: formFactor as BudgetConfig["formFactor"],
    server: parseServer(raw.server, pages[0] as string, fail),
    budgets: parseMetricMap(raw.budgets, "budgets", parseQuantity, fail),
    maxIncrease: parseMetricMap(raw.maxIncrease, "maxIncrease", parseLimit, fail),
  };
}

/**
 * Parses a budget value into the metric's base unit.
 * "170 kB" → 170000 (bytes, 1 kB = 1000 as in Chrome DevTools), "166 KiB" → 169984,
 * "2.5 s" → 2500 (ms), "200 ms" → 200, 90 → 90.
 */
export function parseQuantity(input: string | number, metric: MetricId): number {
  const { unit } = metricInfo(metric);
  const value = typeof input === "number" ? input : parseString(input, unit);
  if (!Number.isFinite(value)) throw new Error(`${show(input)} is not ${EXPECTED[unit]}`);
  if (value < 0) throw new Error(`${show(input)} must not be negative`);
  if (unit === "score" && value > 100) throw new Error(`${show(input)} must be between 0 and 100`);
  return value;
}

/** Parses an allowed increase: "5%" → percent 5, "50 ms" → absolute 50, "10 kB" → absolute 10000. */
export function parseLimit(input: string | number, metric: MetricId): Limit {
  if (typeof input === "string" && input.trim().endsWith("%")) {
    const number = input.trim().slice(0, -1).trim();
    const value = number === "" ? NaN : Number(number);
    if (!Number.isFinite(value) || value <= 0) throw new Error(`${show(input)} must be a percentage above 0, e.g. "5%"`);
    return { kind: "percent", value };
  }
  return { kind: "absolute", value: parseQuantity(input, metric) };
}

function parseString(input: string, unit: MetricUnit): number {
  const match = /^(-?(?:\d+\.?\d*|\.\d+))\s*([a-z]*)$/i.exec(input.trim());
  if (!match) throw new Error(`${show(input)} is not ${EXPECTED[unit]}`);
  const number = Number(match[1]);
  const suffix = (match[2] ?? "").toLowerCase();
  if (suffix === "") return number;

  const own = unit === "bytes" ? SIZE_UNITS : unit === "ms" ? TIME_UNITS : {};
  const factor = own[suffix];
  if (factor !== undefined) return number * factor;
  // Name the mix-up explicitly: "2 s" for a byte budget is an easy copy-paste slip.
  const kind = suffix in TIME_UNITS ? "a duration" : suffix in SIZE_UNITS ? "a size" : undefined;
  if (kind) throw new Error(`${show(input)} is ${kind}, but this metric needs ${EXPECTED[unit]}`);
  throw new Error(`${show(input)} is not ${EXPECTED[unit]}`);
}

function parsePages(value: unknown, fail: Fail): string[] {
  if (!Array.isArray(value) || value.length === 0) {
    return fail("pages", 'required: a non-empty list of paths, e.g. ["/", "/products"]');
  }
  const seen = new Set<unknown>();
  value.forEach((page: unknown, index) => {
    if (typeof page !== "string" || !page.startsWith("/")) fail(`pages[${index}]`, `${show(page)} must be a path starting with "/"`);
    if (seen.has(page)) fail(`pages[${index}]`, `${show(page)} is listed more than once`);
    seen.add(page);
  });
  return value as string[];
}

function parseServer(value: unknown, firstPage: string, fail: Fail): ServerConfig {
  if (value !== undefined && !isObject(value)) return fail("server", "must be an object");
  const server = (value ?? {}) as Record<string, unknown>;
  checkKeys(server, SERVER_KEYS, "server.", fail);

  const readyPath = optionalString(server.readyPath, "server.readyPath", fail) ?? firstPage;
  if (!readyPath.startsWith("/")) fail("server.readyPath", `${show(readyPath)} must start with "/"`);
  const result: ServerConfig = {
    build: optionalString(server.build, "server.build", fail) ?? "npm run build",
    start: optionalString(server.start, "server.start", fail) ?? "npm run start",
    port: optionalInteger(server.port, "server.port", 1024, 65000, fail) ?? 4100,
    readyPath,
    readyTimeoutMs: optionalInteger(server.readyTimeoutMs, "server.readyTimeoutMs", 1, Infinity, fail) ?? 60000,
  };
  // Left undefined when absent so the CLI can pick an install command from the lockfile.
  const install = optionalString(server.install, "server.install", fail);
  if (install !== undefined) result.install = install;
  return result;
}

function parseMetricMap<T>(
  value: unknown,
  field: string,
  parse: (input: string | number, metric: MetricId) => T,
  fail: Fail,
): Partial<Record<MetricId, T>> {
  if (value === undefined) return {};
  if (!isObject(value)) return fail(field, "must be an object keyed by metric id");
  const result: Partial<Record<MetricId, T>> = {};
  for (const [key, input] of Object.entries(value)) {
    if (!(METRIC_IDS as readonly string[]).includes(key)) {
      fail(field, `unknown metric "${key}"${suggest(key, METRIC_IDS, "")} (valid: ${METRIC_IDS.join(", ")})`);
    }
    if (typeof input !== "string" && typeof input !== "number") {
      fail(`${field}.${key}`, `${show(input)} must be a number or a string`);
    }
    try {
      result[key as MetricId] = parse(input as string | number, key as MetricId);
    } catch (error) {
      fail(`${field}.${key}`, (error as Error).message);
    }
  }
  return result;
}

/** Rejects unknown keys, which are almost always typos that would otherwise be silently ignored. */
function checkKeys(object: Record<string, unknown>, allowed: string[], prefix: string, fail: Fail): void {
  for (const key of Object.keys(object)) {
    if (!allowed.includes(key)) fail("", `unknown key "${prefix}${key}"${suggest(key, allowed, prefix)}`);
  }
}

function optionalString(value: unknown, field: string, fail: Fail): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.trim() === "") return fail(field, `${show(value)} must be a non-empty string`);
  return value;
}

function optionalInteger(value: unknown, field: string, min: number, max: number, fail: Fail): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
    const range = max === Infinity ? `at least ${min}` : `from ${min} to ${max}`;
    return fail(field, `${show(value)} must be a whole number ${range}`);
  }
  return value;
}

/** ' (did you mean "x"?)' for the closest candidate within two edits, else "". */
function suggest(key: string, candidates: readonly string[], prefix: string): string {
  let best: string | undefined;
  let bestDistance = 3;
  for (const candidate of candidates) {
    const distance = editDistance(key.toLowerCase(), candidate.toLowerCase());
    if (distance < bestDistance) [best, bestDistance] = [candidate, distance];
  }
  return best === undefined ? "" : ` (did you mean "${prefix}${best}"?)`;
}

function editDistance(a: string, b: string): number {
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      current[j] = Math.min((previous[j] ?? 0) + 1, (current[j - 1] ?? 0) + 1, (previous[j - 1] ?? 0) + cost);
    }
    previous = current;
  }
  return previous[b.length] ?? 0;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function show(value: unknown): string {
  return JSON.stringify(value) ?? String(value);
}
