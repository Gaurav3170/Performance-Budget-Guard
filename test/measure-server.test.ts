import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { startServer } from "../src/measure/server.js";
import type { ServerConfig, Target } from "../src/types.js";

const quiet = () => {};

/** A free port picked by the OS. */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once("error", reject);
    probe.listen(0, () => {
      const { port } = probe.address() as net.AddressInfo;
      probe.close(() => resolve(port));
    });
  });
}

async function respondsOn(port: number): Promise<boolean> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(1_000) });
    await response.body?.cancel();
    return true;
  } catch {
    return false;
  }
}

async function withDir(files: Record<string, string>, fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "pbg-server-"));
  try {
    for (const [name, contents] of Object.entries(files)) await writeFile(path.join(dir, name), contents);
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
}

const HTTP_SERVER = `
const http = require("node:http");
const delay = Number(process.env.DELAY_MS || 0);
setTimeout(() => {
  http.createServer((req, res) => res.end("ok")).listen(Number(process.env.PORT), () => console.log("listening " + process.env.PORT + " " + process.env.NODE_ENV));
}, delay);
`;

// A parent that spawns the real server as a child, like `npm run start` does.
const PARENT = `
const { spawn } = require("node:child_process");
spawn(process.execPath, ["server.cjs"], { stdio: "inherit" });
setInterval(() => {}, 1000);
`;

function serverConfig(start: string, overrides: Partial<ServerConfig> = {}): ServerConfig {
  return { build: "true", start, port: 0, readyPath: "/", readyTimeoutMs: 10_000, ...overrides };
}

function target(cwd: string, port: number): Target {
  return { label: "head", ref: "test", cwd, port };
}

describe("startServer", () => {
  it("waits until the server responds, passes PORT and NODE_ENV, and stops the whole tree", async () => {
    await withDir({ "server.cjs": HTTP_SERVER, "parent.cjs": PARENT }, async (dir) => {
      const port = await freePort();
      const lines: string[] = [];
      const handle = await startServer(target(dir, port), serverConfig("node parent.cjs"), (line) => lines.push(line));
      assert.ok(await respondsOn(port), "server should respond once ready");
      assert.ok(lines.some((line) => line === `[head] listening ${port} production`), lines.join("\n"));

      await handle.stop();
      assert.equal(await respondsOn(port), false, "grandchild server must be gone after stop()");
      await handle.stop(); // idempotent
    });
  });

  it("polls until a slow server comes up", async () => {
    await withDir({ "server.cjs": HTTP_SERVER }, async (dir) => {
      const port = await freePort();
      process.env.DELAY_MS = "1500";
      try {
        const handle = await startServer(target(dir, port), serverConfig("node server.cjs"), quiet);
        await handle.stop();
      } finally {
        delete process.env.DELAY_MS;
      }
    });
  });

  it("fails fast with a clear message when the port is already in use", async () => {
    const blocker = net.createServer().listen(0);
    await new Promise((resolve) => blocker.once("listening", resolve));
    const { port } = blocker.address() as net.AddressInfo;
    try {
      await assert.rejects(
        startServer(target(os.tmpdir(), port), serverConfig("node -e \"setInterval(()=>{},1000)\""), quiet),
        /Port \d+ \(for the head build\) is already in use/,
      );
    } finally {
      blocker.close();
    }
  });

  it("reports the last output lines when the server exits before it is ready", async () => {
    await withDir({ "crash.cjs": `console.log("booting"); console.error("Error: missing .next build"); process.exit(3);` }, async (dir) => {
      const port = await freePort();
      await assert.rejects(startServer(target(dir, port), serverConfig("node crash.cjs"), quiet), (error: Error) => {
        assert.match(error.message, /exited with code 3 before it was ready/);
        assert.match(error.message, /missing \.next build/);
        return true;
      });
    });
  });

  it("times out, and cleans up, when the server never responds", async () => {
    await withDir({ "hang.cjs": `console.log("never listens"); setInterval(() => {}, 1000);` }, async (dir) => {
      const port = await freePort();
      const startedAt = Date.now();
      await assert.rejects(
        startServer(target(dir, port), serverConfig("node hang.cjs", { readyTimeoutMs: 1_500 }), quiet),
        /did not respond on http:\/\/127\.0\.0\.1:\d+\/ within 2 s[\s\S]*never listens/,
      );
      assert.ok(Date.now() - startedAt < 10_000);
    });
  });
});
