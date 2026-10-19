import * as core from "@actions/core";
import * as github from "@actions/github";
import { COMMENT_MARKER } from "./report.js";
import { fetchCommit, resolveCommit } from "./git.js";
import { runGuard } from "./run.js";

/**
 * Entry point of the GitHub Action (run by action.yml's composite step).
 *
 * Inputs arrive as PBG_* environment variables, mapped one by one in action.yml.
 * Composite actions don't populate INPUT_* for the node process they start, and
 * core.getInput would need keys such as INPUT_BASE-REF, which are awkward to write in
 * YAML and not valid shell variable names. Our own prefix avoids both problems.
 */

type Octokit = ReturnType<typeof github.getOctokit>;

function input(name: string, fallback = ""): string {
  const value = process.env[`PBG_${name.toUpperCase().replace(/-/g, "_")}`];
  return value === undefined || value.trim() === "" ? fallback : value.trim();
}

function booleanInput(name: string, fallback: boolean): boolean {
  const value = input(name, String(fallback)).toLowerCase();
  if (["true", "yes", "1", "on"].includes(value)) return true;
  if (["false", "no", "0", "off"].includes(value)) return false;
  throw new Error(`Input "${name}" must be true or false, got "${value}"`);
}

interface PullRequest {
  number: number;
  baseSha: string;
  headSha: string;
}

function pullRequestFromEvent(): PullRequest | null {
  const { eventName, payload } = github.context;
  if (eventName !== "pull_request") return null;
  const pr = payload.pull_request as { number: number; base: { sha: string }; head: { sha: string } } | undefined;
  if (!pr) return null;
  return { number: pr.number, baseSha: pr.base.sha, headSha: pr.head.sha };
}

/**
 * Makes sure the base commit exists locally. actions/checkout fetches only one commit by
 * default, so the base usually has to be fetched; a ref that already resolves is used as is.
 */
async function ensureCommit(ref: string, cwd: string): Promise<string> {
  const local = await resolveCommit(ref, cwd);
  if (local) return local;
  core.info(`Fetching ${ref} from origin`);
  try {
    return await fetchCommit(ref, cwd);
  } catch (error) {
    throw new Error(
      `Can't fetch the base ref "${ref}": ${(error as Error).message}. ` +
        `Use actions/checkout with fetch-depth: 0, or pass a fetchable base-ref.`,
    );
  }
}

function httpStatus(error: unknown): number | undefined {
  const status = (error as { status?: unknown } | null)?.status;
  return typeof status === "number" ? status : undefined;
}

/** Finds the comment this tool posted on an earlier run, so it can be updated in place. */
async function findPreviousComment(octokit: Octokit, issueNumber: number): Promise<{ id: number; body: string } | null> {
  const comments = await octokit.paginate(octokit.rest.issues.listComments, {
    ...github.context.repo,
    issue_number: issueNumber,
    per_page: 100,
  });
  const previous = comments.find((comment) => comment.body?.includes(COMMENT_MARKER) && comment.user?.type === "Bot");
  return previous ? { id: previous.id, body: previous.body ?? "" } : null;
}

async function upsertComment(
  octokit: Octokit,
  issueNumber: number,
  previousId: number | undefined,
  body: string,
): Promise<string> {
  if (previousId !== undefined) {
    const { data } = await octokit.rest.issues.updateComment({ ...github.context.repo, comment_id: previousId, body });
    return data.html_url;
  }
  const { data } = await octokit.rest.issues.createComment({ ...github.context.repo, issue_number: issueNumber, body });
  return data.html_url;
}

function warnNoPermission(error: unknown): void {
  core.warning(
    `Could not post the PR comment (HTTP ${httpStatus(error)}): the token can't write to pull requests. ` +
      `Pull requests from forks get a read-only GITHUB_TOKEN; otherwise add "permissions: pull-requests: write" ` +
      `to the job. The results are in the job summary.`,
  );
}

async function run(): Promise<void> {
  const cwd = process.cwd();
  // The tool installs, builds and starts the PR's code. Under pull_request_target that code
  // would run with a write token and the repository's secrets, so a fork could steal them.
  if (github.context.eventName === "pull_request_target") {
    throw new Error(
      `perf-budget-guard runs the pull request's code, so it refuses pull_request_target, where that code ` +
        `would get a write token and the repository's secrets. Use the pull_request event instead.`,
    );
  }
  const pr = pullRequestFromEvent();
  const baseRefInput = input("base-ref");
  if (!pr && !baseRefInput) {
    throw new Error(
      `perf-budget-guard compares a pull request with its base branch, but this run was triggered by ` +
        `${github.context.eventName ? `"${github.context.eventName}"` : "an unknown event"}. ` +
        `Run it on pull_request, or set the base-ref input.`,
    );
  }
  const failOnBudget = booleanInput("fail-on-budget", true);
  const wantComment = booleanInput("comment", true) && pr !== null;
  const token = input("github-token");

  const baseSha = await core.group("Fetch base", () => ensureCommit(baseRefInput || pr!.baseSha, cwd));
  if (pr) {
    core.info(
      `PR #${pr.number}: head ${pr.headSha}. Measuring the checked-out commit, which is the ` +
        `merge commit unless actions/checkout was given ref: \${{ github.event.pull_request.head.sha }}.`,
    );
  }

  let octokit: Octokit | null = null;
  let previous: { id: number; body: string } | null = null;
  if (wantComment) {
    if (!token) {
      core.warning("No github-token given; skipping the PR comment.");
    } else {
      octokit = github.getOctokit(token);
      try {
        previous = await findPreviousComment(octokit, pr!.number);
      } catch (error) {
        core.warning(`Could not read existing PR comments: ${(error as Error).message}`);
      }
    }
  }

  const { serverUrl, runId } = github.context;
  const repository = process.env.GITHUB_REPOSITORY;
  const result = await runGuard({
    cwd,
    configPath: input("config", "perf-budget.json"),
    baseRef: baseSha,
    skipHeadInstall: booleanInput("skip-head-install", false),
    skipHeadBuild: booleanInput("skip-head-build", false),
    runUrl: repository && runId ? `${serverUrl}/${repository}/actions/runs/${runId}` : undefined,
    previousBody: previous?.body,
    log: (message) => core.info(message),
    phase: core.group,
  });
  const { comparison, markdown } = result;
  core.setOutput("status", comparison.status);

  let commented = false;
  if (octokit && pr) {
    try {
      const url = await upsertComment(octokit, pr.number, previous?.id, markdown);
      core.setOutput("comment-url", url);
      core.info(`${previous ? "Updated" : "Posted"} PR comment: ${url}`);
      commented = true;
    } catch (error) {
      if (httpStatus(error) === 403) warnNoPermission(error);
      else throw error;
    }
  }

  try {
    await core.summary.addRaw(markdown).write();
  } catch (error) {
    core.warning(`Could not write the job summary: ${(error as Error).message}`);
  }

  if (comparison.status === "fail" && failOnBudget) {
    const failed = comparison.pages.filter((page) => page.status === "fail").length;
    const where = commented ? "the PR comment" : "the job summary";
    core.setFailed(`${failed} ${failed === 1 ? "page" : "pages"} over budget — see ${where}`);
  }
}

run().catch((error: unknown) => {
  core.setFailed(error instanceof Error ? error.message : String(error));
});
