// Minimal production server for dist/: clean URLs ("/products" → products.html),
// gzip for text so Lighthouse sees realistic transfer sizes, and no-cache so every
// run revalidates like a first visit.
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

const dist = path.join(path.dirname(fileURLToPath(import.meta.url)), "dist");
const port = Number(process.env.PORT) || 4100;

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};
const COMPRESSIBLE = new Set([".html", ".css", ".js", ".json", ".svg"]);

/** Maps a URL path to a file inside dist/, or null if it would escape it. */
function resolveFile(urlPath) {
  let pathname;
  try {
    pathname = decodeURIComponent(urlPath);
  } catch {
    return null;
  }
  if (pathname.endsWith("/")) pathname += "index";
  if (!path.extname(pathname)) pathname += ".html";
  const file = path.join(dist, pathname);
  return file.startsWith(dist + path.sep) ? file : null;
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  const file = resolveFile(url.pathname);
  let body;
  try {
    if (!file) throw new Error("outside dist");
    body = await readFile(file);
  } catch {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-cache" });
    res.end("Not found");
    return;
  }

  const ext = path.extname(file);
  const headers = { "Content-Type": TYPES[ext] ?? "application/octet-stream", "Cache-Control": "no-cache" };
  if (COMPRESSIBLE.has(ext) && /\bgzip\b/.test(String(req.headers["accept-encoding"] ?? ""))) {
    body = gzipSync(body);
    headers["Content-Encoding"] = "gzip";
    headers["Vary"] = "Accept-Encoding";
  }
  headers["Content-Length"] = body.length;
  res.writeHead(200, headers);
  res.end(req.method === "HEAD" ? undefined : body);
});

server.listen(port, () => console.log(`static-store listening on http://127.0.0.1:${port}`));

for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => server.close(() => process.exit(0)));
