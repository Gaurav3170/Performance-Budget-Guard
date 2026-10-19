import { spawn, type ChildProcess } from "node:child_process";
import net from "node:net";
import treeKill from "tree-kill";
import type { Log, ServerConfig, Target } from "../types.js";

const POLL_INTERVAL_MS = 500;
const KILL_GRACE_MS = 5_000;
const TAIL_LINES = 20;
const isWindows = process.platform === "win32";

export interface ServerHandle {
  target: Target;
  /** Stops the server and every process it spawned. Safe to call more than once. */
  stop(): Promise<void>;
}

/**
 * Starts a target's production server and resolves once it answers on `readyPath`.
 * Rejects (after cleaning up) if the port is taken, the process exits early, or it
 * isn't ready within `readyTimeoutMs`.
 */
export async function startServer(target: Target, server: ServerConfig, log: Log): Promise<ServerHandle> {
  const prefix = `[${target.label}]`;
  await assertPortFree(target.port, target.label);

  log(`${prefix} $ ${server.start}  (port ${target.port}, in ${target.cwd})`);
  const child = spawn(server.start, {
    cwd: target.cwd,
    env: { ...process.env, PORT: String(target.port), NODE_ENV: "production" },
    shell: true,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
    // On POSIX the server leads its own process group, so one signal reaches
    // `sh -c` → npm → node even if an intermediate process exits early.
    detached: !isWindows,
  });

  const tail: string[] = [];
  const onData = (chunk: Buffer) => {
    for (const line of chunk.toString().split(/\r?\n/)) {
      if (!line.trim()) continue;
      log(`${prefix} ${line}`);
      tail.push(line);
      if (tail.length > TAIL_LINES) tail.shift();
    }
  };
  child.stdout?.on("data", onData);
  child.stderr?.on("data", onData);

  let spawnError: Error | undefined;
  child.on("error", (error) => (spawnError = error));
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));

  const handle: ServerHandle = { target, stop: once(() => killTree(child, exited)) };

  try {
    await waitUntilReady(child, target, server, () => spawnError);
  } catch (error) {
    await handle.stop();
    const output = tail.length ? `\nLast output:\n${tail.join("\n")}` : "\n(no output)";
    throw new Error(`${(error as Error).message}${output}`);
  }
  log(`${prefix} ready on http://127.0.0.1:${target.port}`);
  return handle;
}

async function waitUntilReady(
  child: ChildProcess,
  target: Target,
  server: ServerConfig,
  spawnError: () => Error | undefined,
): Promise<void> {
  const url = `http://127.0.0.1:${target.port}${server.readyPath}`;
  const deadline = Date.now() + server.readyTimeoutMs;
  for (;;) {
    const error = spawnError();
    if (error) throw new Error(`The ${target.label} server could not be started: ${error.message}`);
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`The ${target.label} server ("${server.start}") exited with code ${child.exitCode ?? child.signalCode} before it was ready.`);
    }
    try {
      const response = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(5_000) });
      await response.body?.cancel();
      if (response.status < 500) return;
    } catch {
      // Not listening yet.
    }
    if (Date.now() >= deadline) {
      throw new Error(`The ${target.label} server did not respond on ${url} within ${Math.round(server.readyTimeoutMs / 1000)} s.`);
    }
    await sleep(POLL_INTERVAL_MS);
  }
}

/**
 * Fails fast when something already listens on the port: otherwise the readiness
 * check would happily measure that other process instead of this build.
 */
async function assertPortFree(port: number, label: string): Promise<void> {
  const inUse = (await canConnect(port)) || !(await canListen(port));
  if (inUse) {
    throw new Error(
      `Port ${port} (for the ${label} build) is already in use. Stop whatever is listening on it or set a different "server.port".`,
    );
  }
}

function canConnect(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host: "127.0.0.1" });
    socket.setTimeout(1_000);
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("timeout", () => {
      socket.destroy();
      resolve(false);
    });
    socket.once("error", () => resolve(false));
  });
}

function canListen(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.unref();
    probe.once("error", () => resolve(false));
    probe.listen(port, () => probe.close(() => resolve(true)));
  });
}

/**
 * Graceful stop, then force after a grace period. Windows has no process groups or
 * SIGTERM for console apps, so tree-kill walks the tree with `taskkill /T /F`; on
 * POSIX the whole process group is signalled.
 */
async function killTree(child: ChildProcess, exited: Promise<void>): Promise<void> {
  const pid = child.pid;
  if (pid === undefined) return;
  if (isWindows) {
    await new Promise<void>((resolve) => treeKill(pid, "SIGTERM", () => resolve()));
    await Promise.race([exited, sleep(KILL_GRACE_MS)]);
    return;
  }
  signalGroup(pid, "SIGTERM");
  const deadline = Date.now() + KILL_GRACE_MS;
  while (groupAlive(pid) && Date.now() < deadline) await sleep(100);
  if (groupAlive(pid)) {
    signalGroup(pid, "SIGKILL");
    await new Promise<void>((resolve) => treeKill(pid, "SIGKILL", () => resolve()));
    while (groupAlive(pid) && Date.now() < deadline + KILL_GRACE_MS) await sleep(100);
  }
  await Promise.race([exited, sleep(1_000)]);
}

function signalGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch {
    // Group already gone.
  }
}

function groupAlive(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch {
    return false;
  }
}

function once(fn: () => Promise<void>): () => Promise<void> {
  let promise: Promise<void> | undefined;
  return () => (promise ??= fn());
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
