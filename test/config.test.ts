import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, parseConfig, parseLimit, parseQuantity } from "../src/config.js";

const SRC = "perf-budget.json";

test("parseQuantity: sizes use SI kB and binary KiB", () => {
  assert.equal(parseQuantity("170 kB", "jsBytes"), 170_000);
  assert.equal(parseQuantity("166 KiB", "jsBytes"), 166 * 1024);
  assert.equal(parseQuantity("512 B", "jsBytes"), 512);
  assert.equal(parseQuantity("1.5 MB", "totalBytes"), 1_500_000);
  assert.equal(parseQuantity("1 MiB", "totalBytes"), 1_048_576);
  assert.equal(parseQuantity("170KB", "jsBytes"), 170_000, "unit is case-insensitive and the space optional");
  assert.equal(parseQuantity(4096, "jsBytes"), 4096);
});

test("parseQuantity: durations, scores and unitless values", () => {
  assert.equal(parseQuantity("200 ms", "tbt"), 200);
  assert.equal(parseQuantity("2.5 s", "lcp"), 2500);
  assert.equal(parseQuantity(1800, "lcp"), 1800);
  assert.equal(parseQuantity(90, "performance"), 90);
  assert.equal(parseQuantity("90", "performance"), 90);
  assert.equal(parseQuantity(0.1, "cls"), 0.1);
});

test("parseQuantity: rejects wrong units, negatives and junk", () => {
  assert.throws(() => parseQuantity("2 s", "jsBytes"), /"2 s" is a duration, but this metric needs a size/);
  assert.throws(() => parseQuantity("170 kB", "lcp"), /is a size, but this metric needs a duration/);
  assert.throws(() => parseQuantity("170 kb/s", "jsBytes"), /is not a size \(use B, kB, KiB, MB or MiB\)/);
  assert.throws(() => parseQuantity("90 ms", "performance"), /needs a score/);
  assert.throws(() => parseQuantity(-1, "tbt"), /must not be negative/);
  assert.throws(() => parseQuantity(120, "performance"), /between 0 and 100/);
});

test("parseLimit: percent or absolute", () => {
  assert.deepEqual(parseLimit("5%", "jsBytes"), { kind: "percent", value: 5 });
  assert.deepEqual(parseLimit("50 ms", "tbt"), { kind: "absolute", value: 50 });
  assert.deepEqual(parseLimit("10 kB", "jsBytes"), { kind: "absolute", value: 10_000 });
  assert.throws(() => parseLimit("0%", "jsBytes"), /percentage above 0/);
});

test("parseConfig: applies defaults", () => {
  const config = parseConfig({ pages: ["/products", "/"] }, SRC);
  assert.deepEqual(config, {
    pages: ["/products", "/"],
    runs: 5,
    formFactor: "mobile",
    server: { build: "npm run build", start: "npm run start", port: 4100, readyPath: "/products", readyTimeoutMs: 60000 },
    budgets: {},
    maxIncrease: {},
  });
  assert.equal("install" in config.server, false, "install stays undefined so the CLI can detect a lockfile");
});

test("parseConfig: converts budgets and limits", () => {
  const config = parseConfig(
    {
      pages: ["/"],
      runs: 3,
      formFactor: "desktop",
      server: { install: "npm ci", port: 5000, readyPath: "/health" },
      budgets: { jsBytes: "170 kB", lcp: "2.5 s", tbt: "200 ms", performance: 90 },
      maxIncrease: { jsBytes: "5%", tbt: "50 ms" },
    },
    SRC,
  );
  assert.equal(config.server.install, "npm ci");
  assert.equal(config.server.readyPath, "/health");
  assert.deepEqual(config.budgets, { jsBytes: 170_000, lcp: 2500, tbt: 200, performance: 90 });
  assert.deepEqual(config.maxIncrease, { jsBytes: { kind: "percent", value: 5 }, tbt: { kind: "absolute", value: 50 } });
});

test("parseConfig: error messages name the source and field", () => {
  const bad = (raw: unknown, message: RegExp) => assert.throws(() => parseConfig(raw, SRC), message);
  bad({}, /^Error: perf-budget.json: pages: required/);
  bad({ pages: [] }, /pages: required/);
  bad({ pages: ["products"] }, /pages\[0\]: "products" must be a path starting with "\/"/);
  bad({ pages: ["/", "/"] }, /pages\[1\]: "\/" is listed more than once/);
  bad({ pages: ["/"], runs: 0 }, /runs: 0 must be a whole number from 1 to 15/);
  bad({ pages: ["/"], runs: 2.5 }, /runs:/);
  bad({ pages: ["/"], formFactor: "tablet" }, /formFactor: "tablet"/);
  bad({ pages: ["/"], server: { port: 80 } }, /server.port: 80 must be a whole number from 1024 to 65000/);
  bad({ pages: ["/"], server: { readyPath: "health" } }, /server.readyPath: "health" must start with/);
  bad({ pages: ["/"], budgets: { jsBytes: "170 kb/s" } }, /^Error: perf-budget.json: budgets.jsBytes: "170 kb\/s" is not a size \(use B, kB, KiB, MB or MiB\)$/);
});

test("parseConfig: unknown keys and metric ids", () => {
  assert.throws(() => parseConfig({ pages: ["/"], budget: {} }, SRC), /^Error: perf-budget.json: unknown key "budget" \(did you mean "budgets"\?\)$/);
  assert.throws(() => parseConfig({ pages: ["/"], server: { buld: "x" } }, SRC), /unknown key "server.buld" \(did you mean "server.build"\?\)/);
  assert.throws(() => parseConfig({ pages: ["/"], colour: "red" }, SRC), /unknown key "colour"$/);
  assert.throws(
    () => parseConfig({ pages: ["/"], budgets: { jsSize: 1 } }, SRC),
    /budgets: unknown metric "jsSize" .*\(valid: performance, lcp, fcp, tbt, cls, speedIndex, jsBytes, totalBytes\)/,
  );
});

test("loadConfig: reads the file and reports JSON errors with its name", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pbg-"));
  const good = join(dir, "perf-budget.json");
  await writeFile(good, "﻿" + JSON.stringify({ pages: ["/"], budgets: { tbt: "200 ms" } }));
  assert.equal((await loadConfig(good)).budgets.tbt, 200);

  const broken = join(dir, "broken.json");
  await writeFile(broken, "{ pages: ");
  await assert.rejects(loadConfig(broken), (error: Error) => error.message.startsWith(`${broken}: invalid JSON`));
});
