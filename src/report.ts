import { metricInfo } from "./types.js";
import type { Comparison, Limit, MetricComparison, MetricId, PageComparison, ScriptChange, Status } from "./types.js";

/** Hidden marker that identifies the tool's own PR comment, so it can be updated in place. */
export const COMMENT_MARKER = "<!-- perf-budget-guard -->";

/** Bracket the latest result, so the next run can carry it over as "Previous run". */
export const CURRENT_START = "<!-- pbg:current:start -->";
export const CURRENT_END = "<!-- pbg:current:end -->";

/** GitHub rejects comments over 65,536 characters; stay well clear of it. */
export const MAX_COMMENT_LENGTH = 60_000;

export interface RenderOptions {
  /** Link to the workflow run, shown in the footer. */
  runUrl?: string;
  /**
   * The previous comment's full body. Its latest result is kept, collapsed, under
   * "Previous run", so a PR shows both the regression and the fix.
   */
  previousBody?: string;
}

const ICONS: Record<Status, string> = { fail: "🔴", warn: "🟡", pass: "🟢" };

/** How much detail fits: full, then without the per-page "All metrics" tables, then one line per page. */
type Detail = "full" | "compact" | "summary";

/** Renders the full PR comment body, starting with COMMENT_MARKER. */
export function renderComment(comparison: Comparison, options: RenderOptions = {}): string {
  const previous = options.previousBody ? extractCurrent(options.previousBody) : undefined;
  const footer = renderFooter(options.runUrl);

  // Try progressively smaller renderings; the previous run is dropped before the current one shrinks.
  const attempts: Array<[Detail, string | undefined]> = [
    ["full", previous],
    ["full", undefined],
    ["compact", undefined],
    ["summary", undefined],
  ];
  for (const [detail, prev] of attempts) {
    const body = assemble(renderCurrent(comparison, detail), prev, footer);
    if (body.length <= MAX_COMMENT_LENGTH) return body;
  }
  // Last resort for absurd page counts: cut the summary but keep the markers and footer intact.
  const note = "\n\n…truncated: too many pages to list in one comment.";
  const room = MAX_COMMENT_LENGTH - assemble("", undefined, footer).length - note.length;
  return assemble(renderCurrent(comparison, "summary").slice(0, room) + note, undefined, footer);
}

/** The latest result inside a previously rendered comment, or undefined if it has none. */
export function extractCurrent(body: string): string | undefined {
  const start = body.indexOf(CURRENT_START);
  if (start === -1) return undefined;
  const end = body.indexOf(CURRENT_END, start);
  if (end === -1) return undefined;
  const content = body.slice(start + CURRENT_START.length, end).trim();
  return content === "" ? undefined : content;
}

/** Formats a value in the metric's unit: "2.1 s", "120 ms", "148 kB", "98", "0.04". */
export function formatValue(metric: MetricId, value: number): string {
  const { unit } = metricInfo(metric);
  if (unit === "ms") return Math.abs(Math.round(value)) < 1000 ? `${Math.round(value)} ms` : `${(value / 1000).toFixed(1)} s`;
  if (unit === "bytes") return formatBytes(value);
  if (unit === "score") return String(Math.round(value));
  return String(Number(value.toFixed(3)) + 0); // "+ 0" turns -0 into 0
}

/** Signed change in the metric's unit: "+73.0 kB", "-100 ms", "+3", "-0.012"; exactly zero is "±0". */
export function formatDelta(metric: MetricId, delta: number): string {
  if (delta === 0) return "±0";
  return `${delta > 0 ? "+" : "-"}${formatValue(metric, Math.abs(delta))}`;
}

/** Change with its percentage, e.g. "+73.0 kB (+49%)". */
export function formatChange(metric: MetricId, delta: number, deltaPercent: number | null): string {
  const text = formatDelta(metric, delta);
  if (deltaPercent === null || delta === 0) return text;
  return `${text} (${formatPercent(deltaPercent)})`;
}

/** An allowed change, signed in the bad direction: "+5%", "+50 ms", "-3" for a score drop. */
export function formatLimit(metric: MetricId, limit: Limit): string {
  const sign = metricInfo(metric).higherIsBetter ? "-" : "+";
  return limit.kind === "percent" ? `${sign}${limit.value}%` : `${sign}${formatValue(metric, limit.value)}`;
}

function formatBytes(bytes: number): string {
  const size = Math.abs(bytes);
  if (size < 1000) return `${Math.round(bytes)} B`;
  if (size < 1e6) {
    const kB = bytes / 1000;
    return Math.abs(kB) < 100 ? `${kB.toFixed(1)} kB` : `${Math.round(kB)} kB`;
  }
  return `${(bytes / 1e6).toFixed(2)} MB`;
}

function formatPercent(percent: number): string {
  const sign = percent > 0 ? "+" : percent < 0 ? "-" : "±";
  const size = Math.abs(percent);
  // Keep one decimal for small changes so "+0.4%" doesn't read as "+0%".
  const digits = size < 1 && size > 0 ? size.toFixed(1) : String(Math.round(size));
  return `${sign}${digits}%`;
}

function assemble(current: string, previous: string | undefined, footer: string): string {
  const parts = [COMMENT_MARKER, CURRENT_START, current, CURRENT_END];
  if (previous) parts.push("", `<details><summary>Previous run</summary>\n\n${previous}\n\n</details>`);
  parts.push("", footer);
  return parts.join("\n") + "\n";
}

function renderFooter(runUrl: string | undefined): string {
  const link = runUrl ? ` [Workflow run](${runUrl})` : "";
  return `<sub>Changes smaller than run-to-run noise are ignored.${link}</sub>`;
}

function renderCurrent(comparison: Comparison, detail: Detail): string {
  const notable = comparison.pages.filter(isNotable);
  const quiet = comparison.pages.filter((page) => !isNotable(page));
  const sections = [`### ${renderHeadline(comparison)}\n${renderSubtitle(comparison)}`];
  for (const page of notable) sections.push(detail === "summary" ? renderPageSummary(page) : renderPage(page, detail));
  if (quiet.length > 0) sections.push(`✅ No significant changes: ${quiet.map((page) => code(page.path)).join(", ")}`);
  return sections.join(detail === "summary" ? "\n" : "\n\n");
}

/**
 * A page gets its own section when something failed, warned, or moved beyond noise
 * (improvements included), or when its scripts changed, which is worth seeing even if
 * the totals happen to balance out.
 */
function isNotable(page: PageComparison): boolean {
  return page.status !== "pass" || page.scriptChanges.length > 0 || page.metrics.some((metric) => metric.significant);
}

function renderHeadline(comparison: Comparison): string {
  const total = comparison.pages.length;
  if (comparison.status === "fail") {
    const failing = comparison.pages.filter((page) => page.status === "fail").length;
    return `${ICONS.fail} Perf Budget Guard: ${failing} of ${plural(total, "page")} over budget`;
  }
  if (comparison.status === "warn") {
    const warnings = comparison.pages.flatMap((page) => page.metrics).filter((metric) => metric.status === "warn").length;
    return `${ICONS.warn} Perf Budget Guard: no budget broken, ${plural(warnings, "change")} worth a look`;
  }
  return `${ICONS.pass} Perf Budget Guard: ${total === 1 ? "1 page" : `all ${total} pages`} within budget`;
}

function renderSubtitle(comparison: Comparison): string {
  const formFactor = comparison.formFactor === "desktop" ? "Desktop" : "Mobile";
  const runs = comparison.runs === 1 ? "1 run" : `median of ${comparison.runs} runs`;
  const refs = `${code(shortRef(comparison.baseRef))} (base) → ${code(shortRef(comparison.headRef))} (head)`;
  return `${formFactor} · ${runs} · Lighthouse ${comparison.lighthouseVersion} · ${refs}`;
}

function renderPage(page: PageComparison, detail: Detail): string {
  const highlighted = page.metrics.filter((metric) => metric.significant || metric.status !== "pass");
  const parts = [`#### ${ICONS[page.status]} ${code(page.path)}`];
  if (highlighted.length > 0) parts.push(renderMetricTable(highlighted));
  const reasons = renderReasons(page);
  if (reasons) parts.push(reasons);
  if (page.scriptChanges.length > 0) parts.push(`**Scripts that changed**\n${renderScriptTable(page.scriptChanges, detail === "full" ? 10 : 3)}`);
  if (detail === "full") parts.push(`<details><summary>All metrics</summary>\n\n${renderMetricTable(page.metrics)}\n\n</details>`);
  return parts.join("\n\n");
}

function renderPageSummary(page: PageComparison): string {
  const reasons = page.metrics.flatMap((metric) => metric.reasons.map((reason) => `${metricInfo(metric.metric).label} ${reason}`));
  return `- ${ICONS[page.status]} ${code(page.path)}${reasons.length > 0 ? `: ${reasons.join("; ")}` : ": changed beyond noise"}`;
}

function renderReasons(page: PageComparison): string {
  return page.metrics
    .flatMap((metric) => metric.reasons.map((reason) => `- **${metricInfo(metric.metric).label}:** ${reason}`))
    .join("\n");
}

function renderMetricTable(metrics: MetricComparison[]): string {
  const rows = metrics.map((metric) => {
    const change = formatChange(metric.metric, metric.delta, metric.deltaPercent);
    return row([
      metricInfo(metric.metric).label,
      formatValue(metric.metric, metric.base.median),
      formatValue(metric.metric, metric.head.median),
      metric.significant ? `**${change}**` : change,
      renderBudget(metric),
    ]);
  });
  return [row(["Metric", "Base", "Head", "Change", "Budget"]), row(["---", "---", "---", "---", "---"]), ...rows].join("\n");
}

function renderBudget(metric: MetricComparison): string {
  const parts: string[] = [];
  if (metric.budget !== undefined) parts.push(formatValue(metric.metric, metric.budget));
  if (metric.maxIncrease) parts.push(`max ${formatLimit(metric.metric, metric.maxIncrease)}`);
  return parts.length > 0 ? parts.join(" · ") : "—";
}

function renderScriptTable(changes: ScriptChange[], limit: number): string {
  const rows = changes.slice(0, limit).map((change) =>
    row([
      code(change.key),
      change.kind === "added" ? "—" : formatValue("jsBytes", change.baseBytes),
      change.kind === "removed" ? "—" : formatValue("jsBytes", change.headBytes),
      `${formatDelta("jsBytes", change.delta)}${change.kind === "changed" ? "" : ` (${change.kind})`}`,
    ]),
  );
  const table = [row(["Script", "Base", "Head", "Change"]), row(["---", "---", "---", "---"]), ...rows].join("\n");
  const hidden = changes.length - Math.min(limit, changes.length);
  return hidden > 0 ? `${table}\n\n…and ${plural(hidden, "more script")}` : table;
}

/** A table row; "|" inside a cell would end the cell, so it is escaped (GitHub honours `\|` even in code spans). */
function row(cells: string[]): string {
  return `| ${cells.map((cell) => cell.replace(/\|/g, "\\|")).join(" | ")} |`;
}

/** Inline code that survives backticks in the text, using a longer fence as CommonMark allows. */
export function code(text: string): string {
  const longestRun = Math.max(0, ...(text.match(/`+/g) ?? []).map((run) => run.length));
  if (longestRun === 0) return `\`${text}\``;
  const fence = "`".repeat(longestRun + 1);
  return `${fence} ${text} ${fence}`;
}

/** 40-hex commit SHAs are shortened like git does; branch names and tags are shown as given. */
function shortRef(ref: string): string {
  return /^[0-9a-f]{40}$/i.test(ref) ? ref.slice(0, 7) : ref;
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}
