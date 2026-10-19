import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { addWorktree, isGitRepo, removeWorktree, repoPrefix, resolveCommit, revParse } from "../src/git.js";

describe("git helpers", () => {
  let dir: string;
  let repo: string;
  let first: string;
  let second: string;

  const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();

  before(() => {
    dir = mkdtempSync(join(tmpdir(), "pbg-git-test-"));
    repo = join(dir, "repo");
    mkdirSync(join(repo, "app"), { recursive: true });
    git("init", "--quiet");
    git("config", "user.email", "test@example.com");
    git("config", "user.name", "Test");
    git("config", "commit.gpgsign", "false");
    writeFileSync(join(repo, "app", "file.txt"), "one\n");
    git("add", ".");
    git("commit", "--quiet", "-m", "first");
    first = git("rev-parse", "HEAD");
    writeFileSync(join(repo, "app", "file.txt"), "two\n");
    git("commit", "--quiet", "-am", "second");
    second = git("rev-parse", "HEAD");
  });

  after(() => rmSync(dir, { recursive: true, force: true }));

  it("detects git repositories", async () => {
    assert.equal(await isGitRepo(repo), true);
    const plain = join(dir, "plain");
    mkdirSync(plain);
    assert.equal(await isGitRepo(plain), false);
  });

  it("resolves refs to full SHAs", async () => {
    assert.equal(await revParse("HEAD", repo), second);
    assert.equal(await revParse("HEAD~1", repo), first);
    assert.equal(await revParse(first.slice(0, 8), repo), first);
    assert.match(second, /^[0-9a-f]{40}$/);
  });

  it("reports unknown refs", async () => {
    assert.equal(await resolveCommit("no-such-branch", repo), null);
    await assert.rejects(revParse("no-such-branch", repo), /Can't resolve git ref "no-such-branch"/);
  });

  it("gives the path of a sub-directory inside the repo", async () => {
    assert.equal(await repoPrefix(repo), "");
    assert.equal(await repoPrefix(join(repo, "app")), "app/");
  });

  it("adds and removes a detached worktree", async () => {
    const worktree = join(dir, "base-worktree");
    await addWorktree(worktree, first, repo);
    assert.equal(readFileSync(join(worktree, "app", "file.txt"), "utf8").replace(/\r\n/g, "\n"), "one\n");
    assert.equal(await revParse("HEAD", worktree), first);
    // Untracked build output must not block removal.
    writeFileSync(join(worktree, "app", "build.out"), "x");

    await removeWorktree(worktree, repo);
    assert.equal(existsSync(worktree), false);
    assert.doesNotMatch(git("worktree", "list"), /base-worktree/);
    // The main checkout is untouched.
    assert.equal(git("rev-parse", "HEAD"), second);
  });

  it("cleans up leftovers from a crashed run so the path can be reused", async () => {
    const worktree = join(dir, "crashed-worktree");
    await addWorktree(worktree, first, repo);
    // Simulate a crash that left the directory registered...
    await assert.rejects(addWorktree(worktree, first, repo), /git worktree add/);
    await removeWorktree(worktree, repo);
    await addWorktree(worktree, second, repo);
    assert.equal(await revParse("HEAD", worktree), second);
    await removeWorktree(worktree, repo);

    // ...and a stray directory git no longer knows about.
    mkdirSync(join(worktree, "node_modules"), { recursive: true });
    await removeWorktree(worktree, repo);
    assert.equal(existsSync(worktree), false);
  });

  it("is a no-op to remove a worktree that doesn't exist", async () => {
    await removeWorktree(join(dir, "never-created"), repo);
  });
});
