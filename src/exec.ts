import { spawn } from "node:child_process";
import type { Log } from "./types.js";

export interface RunCommandOptions {
  cwd: string;
  env?: NodeJS.ProcessEnv;
  log?: Log;
}

/**
 * Runs a shell command to completion, streaming its output to the log line by line.
 * Rejects with the exit code and the last lines of output if it fails.
 */
export function runCommand(command: string, { cwd, env, log }: RunCommandOptions): Promise<void> {
  return new Promise((resolve, reject) => {
    log?.(`$ ${command}  (in ${cwd})`);
    const child = spawn(command, { cwd, env: { ...process.env, ...env }, shell: true, stdio: ["ignore", "pipe", "pipe"] });
    const tail: string[] = [];
    const onData = (chunk: Buffer) => {
      for (const line of chunk.toString().split(/\r?\n/)) {
        if (!line) continue;
        log?.(`  ${line}`);
        tail.push(line);
        if (tail.length > 20) tail.shift();
      }
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`"${command}" exited with code ${code}\n${tail.join("\n")}`));
    });
  });
}
