import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseCli, UsageError } from "../src/cli.js";

describe("parseCli", () => {
  it("shows help with no arguments or --help", () => {
    assert.deepEqual(parseCli([]), { kind: "help" });
    assert.deepEqual(parseCli(["--help"]), { kind: "help" });
    assert.deepEqual(parseCli(["-h"]), { kind: "help" });
    assert.deepEqual(parseCli(["run", "--help"]), { kind: "help" });
  });

  it("shows the version", () => {
    assert.deepEqual(parseCli(["--version"]), { kind: "version" });
  });

  it("parses run with defaults", () => {
    assert.deepEqual(parseCli(["run"]), {
      kind: "run",
      config: "perf-budget.json",
      base: undefined,
      out: undefined,
      skipHeadBuild: false,
      skipHeadInstall: false,
      fail: true,
      json: false,
    });
  });

  it("parses every run option", () => {
    assert.deepEqual(
      parseCli([
        "run",
        "--config",
        "budgets/perf.json",
        "--base=origin/develop",
        "--out",
        "tmp/out",
        "--skip-head-build",
        "--skip-head-install",
        "--no-fail",
        "--json",
      ]),
      {
        kind: "run",
        config: "budgets/perf.json",
        base: "origin/develop",
        out: "tmp/out",
        skipHeadBuild: true,
        skipHeadInstall: true,
        fail: false,
        json: true,
      },
    );
  });

  it("parses compare", () => {
    assert.deepEqual(parseCli(["compare", "--base-file", "a.json", "--head-file", "b.json", "--json"]), {
      kind: "compare",
      config: "perf-budget.json",
      baseFile: "a.json",
      headFile: "b.json",
      fail: true,
      json: true,
    });
  });

  it("requires both measurement files for compare", () => {
    assert.throws(() => parseCli(["compare", "--base-file", "a.json"]), UsageError);
  });

  it("rejects unknown commands and options", () => {
    assert.throws(() => parseCli(["measure"]), /Unknown command "measure"/);
    assert.throws(() => parseCli(["run", "--bogus"]), UsageError);
    assert.throws(() => parseCli(["run", "extra"]), UsageError);
  });

  it("rejects options that belong to the other command", () => {
    assert.throws(() => parseCli(["run", "--base-file", "a.json"]), /not an option of "run"/);
    assert.throws(() => parseCli(["compare", "--base", "main", "--base-file", "a", "--head-file", "b"]), /not an option/);
  });

  it("rejects a string option without a value", () => {
    assert.throws(() => parseCli(["run", "--config"]), UsageError);
    assert.throws(() => parseCli(["run", "--config="]), /needs a value/);
  });
});
