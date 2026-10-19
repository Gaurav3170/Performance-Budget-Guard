import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";

/**
 * Thin wrappers around the git CLI. They use execFile (no shell) so refs and paths are
 * passed through untouched on every platform, and they turn git's exit codes into
 * errors that say which command failed and why.
 */

/** Runs git with the given arguments and resolves with trimmed stdout. */
export function git(args: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("git", args, { cwd, maxBuffer: 16 * 1024 * 1024, windowsHide: true }, (error, stdout, stderr) => {
      if (!error) {
        resolve(stdout.trim());
        return;
      }
      if ((error as NodeJS.ErrnoException).code === "ENOENT" && !existsSync(cwd)) {
        reject(new Error(`Directory does not exist: ${cwd}`));
        return;
      }
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        reject(new Error("git is not installed or not on PATH"));
        return;
      }
      const detail = stderr.trim() || stdout.trim() || error.message;
      reject(new Error(`git ${args.join(" ")} failed: ${detail}`));
    });
  });
}

/** True when `cwd` is inside a git working tree. */
export async function isGitRepo(cwd: string): Promise<boolean> {
  try {
    return (await git(["rev-parse", "--is-inside-work-tree"], cwd)) === "true";
  } catch {
    return false;
  }
}

/** Resolves a ref to a full commit SHA, or null when it doesn't exist locally. */
export async function resolveCommit(ref: string, cwd: string): Promise<string | null> {
  try {
    const sha = await git(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], cwd);
    return sha || null;
  } catch {
    return null;
  }
}

/** Resolves a ref to a full commit SHA; throws when it doesn't exist locally. */
export async function revParse(ref: string, cwd: string): Promise<string> {
  const sha = await resolveCommit(ref, cwd);
  if (!sha) throw new Error(`Can't resolve git ref "${ref}" in ${cwd}`);
  return sha;
}

/** Absolute path of the repository root that contains `cwd`. */
export function repoRoot(cwd: string): Promise<string> {
  return git(["rev-parse", "--show-toplevel"], cwd);
}

/**
 * The path of `cwd` relative to the repository root ("" at the root, "apps/web/" in a
 * monorepo package), so the same directory can be found inside another worktree.
 */
export function repoPrefix(cwd: string): Promise<string> {
  return git(["rev-parse", "--show-prefix"], cwd);
}

/** Checks out `ref` into a new detached worktree at `path`. */
export async function addWorktree(path: string, ref: string, cwd: string): Promise<void> {
  await git(["worktree", "add", "--detach", path, ref], cwd);
}

/**
 * Removes the worktree at `path`, including untracked files such as node_modules.
 * Also cleans up a directory left behind by a crashed run that git no longer tracks,
 * so it is safe to call whether or not the worktree exists.
 */
export async function removeWorktree(path: string, cwd: string): Promise<void> {
  if (existsSync(path)) {
    try {
      await git(["worktree", "remove", "--force", path], cwd);
    } catch {
      await rm(path, { recursive: true, force: true, maxRetries: 3 });
    }
  }
  await git(["worktree", "prune"], cwd);
}

/**
 * Fetches a single commit (or branch) from origin without history, for shallow CI
 * checkouts that only contain the PR's own commit. Resolves with the fetched SHA.
 */
export async function fetchCommit(ref: string, cwd: string): Promise<string> {
  await git(["fetch", "--no-tags", "--depth=1", "origin", ref], cwd);
  return revParse("FETCH_HEAD", cwd);
}
