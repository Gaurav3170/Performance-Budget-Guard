import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { measure } from "../src/measure/index.js";
import type { BudgetConfig } from "../src/types.js";

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

describe("measure", () => {
  it("stops the servers that did start when another target's server fails", async () => {
    const good = await mkdtemp(path.join(os.tmpdir(), "pbg-good-"));
    const bad = await mkdtemp(path.join(os.tmpdir(), "pbg-bad-"));
    try {
      // Same start command for both checkouts; only the "bad" one crashes.
      const script = (crash: boolean) =>
        crash
          ? `console.error("boom: build output missing"); process.exit(1);`
          : `require("node:http").createServer((q, s) => s.end("ok")).listen(Number(process.env.PORT));`;
      await writeFile(path.join(good, "start.cjs"), script(false));
      await writeFile(path.join(bad, "start.cjs"), script(true));

      const [basePort, headPort] = [await freePort(), await freePort()];
      const config: BudgetConfig = {
        pages: ["/"],
        runs: 1,
        formFactor: "mobile",
        server: { build: "true", start: "node start.cjs", port: headPort, readyPath: "/", readyTimeoutMs: 10_000 },
        budgets: {},
        maxIncrease: {},
      };
      await assert.rejects(
        measure(
          [
            { label: "base", ref: "main", cwd: good, port: basePort },
            { label: "head", ref: "pr", cwd: bad, port: headPort },
          ],
          config,
          () => {},
        ),
        /head server .* exited with code 1[\s\S]*boom: build output missing/,
      );
      assert.equal(await respondsOn(basePort), false, "the base server must be stopped");
    } finally {
      await rm(good, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
      await rm(bad, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    }
  });
});
