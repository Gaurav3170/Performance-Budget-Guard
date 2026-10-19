import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { Result } from "lighthouse";
import { extractRunResult } from "../src/measure/lighthouse.js";
import { slug } from "../src/measure/index.js";

function fakeLhr(overrides: { score?: number | null; dropAudit?: string; items?: unknown[] } = {}): Result {
  const audits: Record<string, unknown> = {
    "largest-contentful-paint": { numericValue: 1234.5 },
    "first-contentful-paint": { numericValue: 800 },
    "total-blocking-time": { numericValue: 120 },
    "cumulative-layout-shift": { numericValue: 0.02 },
    "speed-index": { numericValue: 1500 },
    "total-byte-weight": { numericValue: 50_000 },
    "network-requests": {
      details: {
        items: overrides.items ?? [
          { url: "http://127.0.0.1:4100/products", resourceType: "Document", transferSize: 2000 },
          { url: "http://127.0.0.1:4100/assets/main-1a2b3c4d.js", resourceType: "Script", transferSize: 700 },
          { url: "http://127.0.0.1:4100/assets/delivery-date-9f8e7d6c.js?v=2", resourceType: "Script", transferSize: 30_000 },
          { url: "https://cdn.example.com/lib.js", resourceType: "Script", transferSize: 1000 },
          { url: "http://127.0.0.1:4100/assets/styles-0a1b2c3d.css", resourceType: "Stylesheet", transferSize: 900 },
        ],
      },
    },
  };
  if (overrides.dropAudit) delete audits[overrides.dropAudit];
  return {
    lighthouseVersion: "12.8.2",
    requestedUrl: "http://127.0.0.1:4100/products",
    finalDisplayedUrl: "http://127.0.0.1:4100/products",
    categories: { performance: { score: overrides.score === undefined ? 0.87 : overrides.score } },
    audits,
    runWarnings: [],
  } as unknown as Result;
}

describe("extractRunResult", () => {
  it("maps Lighthouse audits to metrics in base units", () => {
    const { values } = extractRunResult(fakeLhr());
    assert.deepEqual(values, {
      performance: 87,
      lcp: 1234.5,
      fcp: 800,
      tbt: 120,
      cls: 0.02,
      speedIndex: 1500,
      totalBytes: 50_000,
      jsBytes: 31_700,
    });
  });

  it("lists scripts with normalized keys", () => {
    const { scripts } = extractRunResult(fakeLhr());
    assert.deepEqual(
      scripts.map(({ key, transferBytes }) => [key, transferBytes]),
      [
        ["/assets/main-*.js", 700],
        ["/assets/delivery-date-*.js", 30_000],
        ["cdn.example.com/lib.js", 1000],
      ],
    );
    assert.equal(scripts[1]?.url, "http://127.0.0.1:4100/assets/delivery-date-9f8e7d6c.js?v=2");
  });

  it("reports zero JavaScript when the page loads no scripts", () => {
    const result = extractRunResult(fakeLhr({ items: [{ url: "http://127.0.0.1:4100/", resourceType: "Document", transferSize: 1 }] }));
    assert.equal(result.values.jsBytes, 0);
    assert.deepEqual(result.scripts, []);
  });

  it("throws when a metric is missing so the run is retried", () => {
    assert.throws(() => extractRunResult(fakeLhr({ dropAudit: "largest-contentful-paint" })), /NO_METRICS: missing lcp/);
    assert.throws(() => extractRunResult(fakeLhr({ score: null })), /missing performance/);
    assert.throws(() => extractRunResult(fakeLhr({ dropAudit: "network-requests" })), /network-requests/);
  });
});

describe("slug", () => {
  it("turns page paths into file-name-safe slugs", () => {
    assert.equal(slug("/"), "home");
    assert.equal(slug("/products"), "products");
    assert.equal(slug("/products/blue-running-shoe"), "products-blue-running-shoe");
    assert.equal(slug("/search?q=Shoes"), "search");
  });
});
