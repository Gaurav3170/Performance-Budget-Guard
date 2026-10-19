#!/usr/bin/env node
import { readFileSync, realpathSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { DEFAULT_CONFIG_FILE } from "./config.js";
import { resolveCommit } from "./git.js";
import type { Measurement } from "./types.js";

const USAGE = `Usage:
  perf-budget-guard run [options]
      Build and measure the base ref and the current checkout, then compare them.
      --config <file>        Budget config (default: ${DEFAULT_CONFIG_FILE})
      --base <ref>           Ref to compare against (default: origin/main, else main)
      --out <dir>            Output directory (default: .perf-budget-guard)
      --skip-head-install    Don't install dependencies in the current checkout
      --skip-head-build      Don't build the current checkout (it's already built)
      --no-fail              Exit 0 even when the budget fails
      --json                 Print the comparison as JSON instead of markdown

  perf-budget-guard compare --base-file <file> --head-file <file> [options]
      Recompare saved measurements (base.json, head.json) without re-measuring,
      e.g. while tuning budgets.
      --config <file>        Budget config (default: ${DEFAULT_CONFIG_FILE})
      --no-fail              Exit 0 even when the budget fails
      --json                 Print the comparison as JSON instead of markdown

  perf-budget-guard --help | --version

Exit codes: 0 pass or warn, 1 budget failed, 2 usage or tool error.`;

export type CliCommand =
  | { kind: "help" }
  | { kind: "version" }
  | {
      kind: "run";
      config: string;
      /** Undefined means "origin/main if it exists, else main". */
      base?: string;
      /** Undefined means runGuard's default, .perf-budget-guard. */
      out?: string;
      skipHeadBuild: boolean;
      skipHeadInstall: boolean;
      fail: boolean;
      json: boolean;
    }
  | { kind: "compare"; config: string; baseFile: string; headFile: string; fail: boolean; json: boolean };

/** A mistake in the command line; reported with the usage hint and exit code 2. */
export class UsageError extends Error {}

/** Parses the command line (without the node and script paths). Pure, so it can be unit tested. */
export function parseCli(argv: readonly string[]): CliCommand {
  const [command, ...rest] = argv;
  if (command === undefined || command === "--help" || command === "-h" || command === "help") return { kind: "help" };
  if (command === "--version" || command === "-v") return { kind: "version" };
  if (command !== "run" && command !== "compare") {
    throw new UsageError(`Unknown command "${command}"`);
  }

  let values: Record<string, string | boolean | undefined>;
  try {
    ({ values } = parseArgs({
      args: [...rest],
      allowPositionals: false,
      strict: true,
      options: {
        config: { type: "string" },
        base: { type: "string" },
        out: { type: "string" },
        "skip-head-build": { type: "boolean" },
        "skip-head-install": { type: "boolean" },
        "no-fail": { type: "boolean" },
        json: { type: "boolean" },
        "base-file": { type: "string" },
        "head-file": { type: "string" },
        help: { type: "boolean", short: "h" },
      },
    }));
  } catch (error) {
    throw new UsageError((error as Error).message);
  }
  if (values.help) return { kind: "help" };

  const allowed =
    command === "run"
      ? ["config", "base", "out", "skip-head-build", "skip-head-install", "no-fail", "json"]
      : ["config", "base-file", "head-file", "no-fail", "json"];
  for (const name of Object.keys(values)) {
    if (!allowed.includes(name)) throw new UsageError(`--${name} is not an option of "${command}"`);
  }
  const string = (name: string): string | undefined => {
    const value = values[name];
    if (value === "") throw new UsageError(`--${name} needs a value`);
    return typeof value === "string" ? value : undefined;
  };
  const config = string("config") ?? DEFAULT_CONFIG_FILE;
  const fail = !values["no-fail"];
  const json = values.json === true;

  if (command === "run") {
    return {
      kind: "run",
      config,
      base: string("base"),
      out: string("out"),
      skipHeadBuild: values["skip-head-build"] === true,
      skipHeadInstall: values["skip-head-install"] === true,
      fail,
      json,
    };
  }
  const baseFile = string("base-file");
  const headFile = string("head-file");
  if (!baseFile || !headFile) throw new UsageError(`"compare" needs both --base-file and --head-file`);
  return { kind: "compare", config, baseFile, headFile, fail, json };
}

function version(): string {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };
  return pkg.version;
}

async function readMeasurement(path: string): Promise<Measurement> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as Measurement;
  } catch (error) {
    throw new Error(`Can't read measurement ${path}: ${(error as Error).message}`);
  }
}

/** Runs the CLI and returns the process exit code. */
export async function main(argv: readonly string[]): Promise<number> {
  const cwd = process.cwd();
  const log = (message: string) => process.stderr.write(`${message}\n`);
  let command: CliCommand;
  try {
    command = parseCli(argv);
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    process.stderr.write(`perf-budget-guard: ${error.message}\nRun "perf-budget-guard --help" for usage.\n`);
    return 2;
  }

  switch (command.kind) {
    case "help":
      process.stdout.write(`${USAGE}\n`);
      return 0;
    case "version":
      process.stdout.write(`${version()}\n`);
      return 0;
    case "run": {
      // Loaded lazily: measuring pulls in Lighthouse, which --help and usage errors don't need.
      const { runGuard } = await import("./run.js");
      const baseRef = command.base ?? ((await resolveCommit("origin/main", cwd)) ? "origin/main" : "main");
      const result = await runGuard({
        cwd,
        configPath: command.config,
        baseRef,
        outDir: command.out,
        skipHeadBuild: command.skipHeadBuild,
        skipHeadInstall: command.skipHeadInstall,
        log,
      });
      process.stdout.write(command.json ? `${JSON.stringify(result.comparison, null, 2)}\n` : `${result.markdown}\n`);
      return result.comparison.status === "fail" && command.fail ? 1 : 0;
    }
    case "compare": {
      const [{ loadConfig }, { compare }, { renderComment }] = await Promise.all([
        import("./config.js"),
        import("./compare.js"),
        import("./report.js"),
      ]);
      const config = await loadConfig(resolve(cwd, command.config));
      const base = await readMeasurement(resolve(cwd, command.baseFile));
      const head = await readMeasurement(resolve(cwd, command.headFile));
      const comparison = compare(base, head, config);
      process.stdout.write(command.json ? `${JSON.stringify(comparison, null, 2)}\n` : `${renderComment(comparison)}\n`);
      return comparison.status === "fail" && command.fail ? 1 : 0;
    }
  }
}

/** Only run when executed directly (also through npm's bin symlink), so tests can import parseCli. */
function isEntryPoint(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isEntryPoint()) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`perf-budget-guard: ${message.split("\n")[0]}\n`);
      if (process.env.DEBUG && error instanceof Error) process.stderr.write(`${error.stack}\n`);
      process.exitCode = 2;
    },
  );
}
