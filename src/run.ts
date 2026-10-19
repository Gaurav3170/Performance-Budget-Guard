import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { compare } from "./compare.js";
import { loadConfig } from "./config.js";
import { runCommand } from "./exec.js";
import { addWorktree, isGitRepo, removeWorktree, repoPrefix, repoRoot, resolveCommit, revParse } from "./git.js";
import { measure } from "./measure/index.js";
import { renderComment } from "./report.js";
import type { BudgetConfig, Comparison, Log, Measurement } from "./types.js";

/** Runs `fn` as one named phase; the action passes core.group so each phase folds in the log. */
export type Phase = <T>(name: string, fn: () => Promise<T>) => Promise<T>;

export interface GuardOptions {
  /** The head checkout: measured as it is, uncommitted changes included. */
  cwd: string;
  /** Path to perf-budget.json, relative to cwd. */
  configPath: string;
  /** Branch, tag or SHA to compare against. */
  baseRef: string;
  /** Where results are written, relative to cwd. Default ".perf-budget-guard". */
  outDir?: string;
  /** The user's workflow already installed dependencies in the head checkout. */
  skipHeadInstall?: boolean;
  /** The user's workflow already built the head checkout. */
  skipHeadBuild?: boolean;
  /** Link to the CI run, shown in the comment footer. */
  runUrl?: string;
  /** Body of the comment being replaced, so its result is kept as "Previous run". */
  previousBody?: string;
  log: Log;
  phase?: Phase;
}

export interface GuardResult {
  comparison: Comparison;
  markdown: string;
  base: Measurement;
  head: Measurement;
  /** Absolute path of the output directory. */
  outDir: string;
}

export const DEFAULT_OUT_DIR = ".perf-budget-guard";

const runPhase: Phase = (_name, fn) => fn();

/**
 * Builds and measures the base ref and the current checkout, compares them against the
 * budget and renders the PR comment. Writes base.json, head.json, comparison.json and
 * comment.md to the output directory so a run can be inspected or re-compared later.
 */
export async function runGuard(options: GuardOptions): Promise<GuardResult> {
  const { log } = options;
  const phase = options.phase ?? runPhase;
  const cwd = resolve(options.cwd);
  const outDir = resolve(cwd, options.outDir ?? DEFAULT_OUT_DIR);

  if (!(await isGitRepo(cwd))) {
    throw new Error(`${cwd} is not inside a git repository; perf-budget-guard needs git to check out the base ref`);
  }
  const config = await loadConfig(resolve(cwd, options.configPath));
  const headSha = await revParse("HEAD", cwd);
  const baseSha = await resolveCommit(options.baseRef, cwd);
  if (!baseSha) {
    throw new Error(
      `Can't find the base ref "${options.baseRef}". Fetch it first (git fetch origin <branch>), ` +
        `or in GitHub Actions use actions/checkout with fetch-depth: 0.`,
    );
  }
  log(`Base: ${options.baseRef} (${baseSha})`);
  log(`Head: working tree at ${headSha}`);
  await mkdir(outDir, { recursive: true });

  const root = await repoRoot(cwd);
  const worktree = await worktreePath(root);
  // The base build runs in the same sub-directory of its checkout as the head build (monorepos).
  const baseCwd = join(worktree, await repoPrefix(cwd));

  try {
    await phase("Check out base", async () => {
      // A crashed earlier run can leave the worktree behind; git refuses to reuse the path.
      await removeWorktree(worktree, root);
      await addWorktree(worktree, baseSha, root);
      log(`Checked out ${baseSha} at ${worktree}`);
    });

    // Sequential on purpose: parallel builds on a 2-core runner slow each other down
    // and interleave their logs.
    await phase("Build base", () => installAndBuild(baseCwd, worktree, config, log, false, false));
    await phase("Build head", () =>
      installAndBuild(cwd, root, config, log, options.skipHeadInstall ?? false, options.skipHeadBuild ?? false),
    );

    const [base, head] = await phase("Measure", () =>
      measure(
        [
          { label: "base", ref: baseSha, cwd: baseCwd, port: config.server.port + 1 },
          { label: "head", ref: headSha, cwd, port: config.server.port },
        ],
        config,
        log,
        { reportDir: join(outDir, "lighthouse") },
      ),
    );
    if (!base || !head) throw new Error("measure() did not return a result for both builds");
    await writeJson(join(outDir, "base.json"), base);
    await writeJson(join(outDir, "head.json"), head);

    const comparison = compare(base, head, config);
    await writeJson(join(outDir, "comparison.json"), comparison);
    const markdown = renderComment(comparison, { runUrl: options.runUrl, previousBody: options.previousBody });
    await writeFile(join(outDir, "comment.md"), markdown);
    log(`Results written to ${outDir}`);
    return { comparison, markdown, base, head, outDir };
  } finally {
    try {
      await removeWorktree(worktree, root);
    } catch (error) {
      log(`Could not remove the base worktree at ${worktree}: ${(error as Error).message}`);
    }
  }
}

/**
 * The base checkout lives outside the repository. Inside it (e.g. under .perf-budget-guard)
 * the head build would see the base sources: TypeScript's default include, ESLint and
 * Next.js's workspace-root detection all walk into sub-directories, and Node's module
 * resolution from the base checkout would fall back to the head's node_modules.
 * The path is stable per repository so a crashed run's leftovers are cleaned up next time.
 */
async function worktreePath(root: string): Promise<string> {
  const id = createHash("sha1").update(root).digest("hex").slice(0, 10);
  return join(process.env.RUNNER_TEMP || tmpdir(), `perf-budget-guard-base-${id}`);
}

async function installAndBuild(
  dir: string,
  root: string,
  config: BudgetConfig,
  log: Log,
  skipInstall: boolean,
  skipBuild: boolean,
): Promise<void> {
  if (skipInstall) {
    log("Skipping install");
  } else {
    const install = config.server.install ? { command: config.server.install, cwd: dir } : detectInstall(dir, root);
    if (install) await runCommand(install.command, { cwd: install.cwd, log });
    else log(`No lockfile in ${dir}; skipping install (set server.install to override)`);
  }
  if (skipBuild) log("Skipping build");
  else await runCommand(config.server.build, { cwd: dir, log });
}

const LOCKFILES: ReadonlyArray<[file: string, command: string]> = [
  ["package-lock.json", "npm ci"],
  ["pnpm-lock.yaml", "pnpm install --frozen-lockfile"],
  ["yarn.lock", "yarn install --frozen-lockfile"],
];

/**
 * Picks the install command from the lockfile in `dir`, falling back to the repository
 * root, where workspaces (monorepos) keep their single lockfile.
 */
export function detectInstall(dir: string, root: string): { command: string; cwd: string } | null {
  for (const candidate of dir === root ? [dir] : [dir, root]) {
    for (const [file, command] of LOCKFILES) {
      if (existsSync(join(candidate, file))) return { command, cwd: candidate };
    }
  }
  return null;
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, JSON.stringify(value, null, 2) + "\n");
}
