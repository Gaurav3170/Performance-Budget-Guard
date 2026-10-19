// Builds the static store into dist/. Asset file names carry a content hash
// (main-<8 hex>.js), like a real bundler, so script-key normalization is exercised.
// PBG_FIXTURE_HEAVY=1 swaps the tiny delivery-date script for a generated heavy one.
import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { heavyDeliveryScript } from "./heavy-date-lib.mjs";

const root = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(root, "dist");
const heavy = process.env.PBG_FIXTURE_HEAVY === "1";

const PRODUCTS = [
  { slug: "blue-running-shoe", name: "Blue Running Shoe", price: "$89", color: "#3b6fd8", blurb: "Light, breathable and built for daily miles." },
  { slug: "trail-runner", name: "Trail Runner", price: "$119", color: "#5c8a3a", blurb: "Grippy outsole for wet rocks and loose gravel." },
  { slug: "court-classic", name: "Court Classic", price: "$74", color: "#d8d2c4", blurb: "A clean leather sneaker that goes with everything." },
  { slug: "rain-jacket", name: "Rain Jacket", price: "$139", color: "#e0a526", blurb: "Seam-sealed shell that packs into its own pocket." },
  { slug: "wool-socks", name: "Wool Socks (3 pack)", price: "$24", color: "#8a5a9c", blurb: "Merino blend, cushioned heel and toe." },
  { slug: "day-pack", name: "Day Pack 18 L", price: "$65", color: "#2f3b4c", blurb: "Padded laptop sleeve and a bottle pocket on each side." },
];

async function emit(name, contents) {
  const hash = createHash("sha256").update(contents).digest("hex").slice(0, 8);
  const ext = path.extname(name);
  const file = `${path.basename(name, ext)}-${hash}${ext}`;
  await writeFile(path.join(dist, "assets", file), contents);
  return `/assets/${file}`;
}

function layout({ title, description, assets, body, scripts = [] }) {
  const tags = [assets.main, ...scripts].map((src) => `    <script src="${src}" defer></script>`).join("\n");
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${title} · Static Store</title>
    <meta name="description" content="${description}">
    <link rel="stylesheet" href="${assets.css}">
${tags}
  </head>
  <body>
    <header class="site-header">
      <a class="brand" href="/">Static Store</a>
      <nav aria-label="Main"><a href="/products">Products</a><span class="cart-count" data-cart-count>Cart (0)</span></nav>
    </header>
    <main>
${body}
    </main>
    <footer class="site-footer">Static Store is a test fixture for perf-budget-guard.</footer>
  </body>
</html>
`;
}

function card(product) {
  return `        <li class="product-card">
          <div class="swatch" style="background:${product.color}" role="img" aria-label="${product.name}"></div>
          <h2><a href="/products/${product.slug}">${product.name}</a></h2>
          <p class="price">${product.price}</p>
        </li>`;
}

async function build() {
  await rm(dist, { recursive: true, force: true });
  await mkdir(path.join(dist, "assets"), { recursive: true });
  await mkdir(path.join(dist, "products"), { recursive: true });

  const source = (file) => readFile(path.join(root, "src", file), "utf8");
  const delivery = heavy ? heavyDeliveryScript() : await source("delivery-date.js");
  const assets = {
    css: await emit("styles.css", await source("styles.css")),
    main: await emit("main.js", await source("main.js")),
    delivery: await emit("delivery-date.js", delivery),
  };

  const home = layout({
    title: "Home",
    description: "Shoes and gear for everyday runs.",
    assets,
    body: `      <section class="hero">
        <h1>Gear for everyday runs</h1>
        <p class="lede">Shoes, layers and packs we actually run in. Free returns within 30 days.</p>
        <a class="button" href="/products">Shop all products</a>
      </section>
      <h2>Popular right now</h2>
      <ul class="product-grid">
${PRODUCTS.slice(0, 3).map(card).join("\n")}
      </ul>`,
  });

  const list = layout({
    title: "Products",
    description: "Every product in the Static Store.",
    assets,
    body: `      <h1>All products</h1>
      <p class="lede">${PRODUCTS.length} products.</p>
      <ul class="product-grid">
${PRODUCTS.map(card).join("\n")}
      </ul>`,
  });

  const shoe = PRODUCTS[0];
  const detail = layout({
    title: shoe.name,
    description: shoe.blurb,
    assets,
    scripts: [assets.delivery],
    body: `      <article class="product-detail">
        <div class="swatch" style="background:${shoe.color}" role="img" aria-label="${shoe.name}"></div>
        <div>
          <h1>${shoe.name}</h1>
          <p class="price">${shoe.price}</p>
          <p>${shoe.blurb}</p>
          <p class="delivery" data-delivery>Checking delivery date…</p>
          <button class="button" type="button" data-add-to-cart>Add to cart</button>
        </div>
      </article>`,
  });

  await writeFile(path.join(dist, "index.html"), home);
  await writeFile(path.join(dist, "products.html"), list);
  await writeFile(path.join(dist, "products", `${shoe.slug}.html`), detail);

  const kb = (Buffer.byteLength(delivery) / 1024).toFixed(1);
  console.log(`Built dist/ (${heavy ? "HEAVY" : "normal"} delivery-date script, ${kb} kB uncompressed)`);
}

await build();
