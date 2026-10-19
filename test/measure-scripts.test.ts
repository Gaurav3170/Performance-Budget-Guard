import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { normalizeScriptKey } from "../src/measure/scripts.js";

const origin = "http://127.0.0.1:4100";
const key = (url: string) => normalizeScriptKey(url, origin);

describe("normalizeScriptKey", () => {
  it("replaces Next.js chunk ids and content hashes", () => {
    assert.equal(key(`${origin}/_next/static/chunks/117-d5568bb59c0c8623.js`), "/_next/static/chunks/*-*.js");
    assert.equal(key(`${origin}/_next/static/chunks/app/page-3f2a91c0e1b2.js`), "/_next/static/chunks/app/page-*.js");
    assert.equal(key(`${origin}/_next/static/chunks/webpack-59c5c889f52620d6.js`), "/_next/static/chunks/webpack-*.js");
    assert.equal(key(`${origin}/_next/static/chunks/framework-8e0e0f4a6b83a956.js`), "/_next/static/chunks/framework-*.js");
  });

  it("replaces Vite hashes that mix letters and digits", () => {
    assert.equal(key(`${origin}/assets/index-BxT9kQ2a.js`), "/assets/index-*.js");
    assert.equal(key(`${origin}/assets/vendor.4f8a2c1e.js`), "/assets/vendor.*.js");
  });

  it("replaces hashes from the fixture build", () => {
    assert.equal(key(`${origin}/assets/main-1a2b3c4d.js`), "/assets/main-*.js");
    assert.equal(key(`${origin}/assets/delivery_9f8e7d6c.js`), "/assets/delivery_*.js");
  });

  it("keeps readable names unchanged", () => {
    assert.equal(key(`${origin}/js/main.js`), "/js/main.js");
    assert.equal(key(`${origin}/static/js/vendors~main.chunk.js`), "/static/js/vendors~main.chunk.js");
    assert.equal(key(`${origin}/scripts/analytics.min.js`), "/scripts/analytics.min.js");
  });

  it("keeps short numbers and long words without digits", () => {
    // Version numbers and two-digit ids are part of the name, not a hash.
    assert.equal(key(`${origin}/lib/react-18.2.0.js`), "/lib/react-18.2.0.js");
    assert.equal(key(`${origin}/chunks/42.js`), "/chunks/42.js");
    assert.equal(key(`${origin}/js/internationalization.js`), "/js/internationalization.js");
  });

  it("replaces pure-digit chunk ids of three or more digits", () => {
    assert.equal(key(`${origin}/_next/static/chunks/972.js`), "/_next/static/chunks/*.js");
    assert.equal(key(`${origin}/static/js/123.chunk.js`), "/static/js/*.chunk.js");
  });

  it("drops query strings and hashes", () => {
    assert.equal(key(`${origin}/js/main.js?v=1234567890`), "/js/main.js");
    assert.equal(key(`${origin}/js/main.js#section`), "/js/main.js");
  });

  it("prefixes cross-origin scripts with their host", () => {
    assert.equal(key("https://cdn.example.com/npm/lodash@4.17.21/lodash.min.js"), "cdn.example.com/npm/lodash@4.17.21/lodash.min.js");
    assert.equal(key("https://www.googletagmanager.com/gtag/js?id=G-ABC123"), "www.googletagmanager.com/gtag/js");
    assert.equal(key("https://cdn.example.com/build/app-3f2a91c0e1.js"), "cdn.example.com/build/app-*.js");
  });

  it("treats a different port on the same host as cross-origin", () => {
    assert.equal(key("http://127.0.0.1:4101/js/main.js"), "127.0.0.1:4101/js/main.js");
  });

  it("gives base and head builds of the same script the same key", () => {
    const base = key(`${origin}/_next/static/chunks/pages/products-0a1b2c3d4e5f6789.js`);
    const head = key(`${origin}/_next/static/chunks/pages/products-9876f5e4d3c2b1a0.js`);
    assert.equal(base, head);
  });

  it("does not throw on data: URLs or garbage", () => {
    assert.equal(key("data:application/javascript;base64,YWxlcnQoMSk="), "data:application/javascript");
    assert.equal(typeof key("http://[bad"), "string");
  });
});
