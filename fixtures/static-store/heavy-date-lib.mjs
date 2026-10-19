// Generates the "full date library" used when PBG_FIXTURE_HEAVY=1. It simulates the
// classic regression of importing a whole date/timezone library to format one date:
// ~70 kB of locale and timezone tables plus top-level code that parses them and
// formats thousands of dates before the page can respond.
//
// Everything is derived from a fixed seed, so every heavy build is byte-identical.

/** Small deterministic PRNG (mulberry32). */
function prng(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const SYLLABLES = ["ka", "lo", "mi", "ne", "su", "ta", "ri", "vo", "be", "zu", "an", "el", "or", "ix", "um", "ya"];

function word(random, min, max) {
  const length = min + Math.floor(random() * (max - min + 1));
  let out = "";
  for (let i = 0; i < length; i++) out += SYLLABLES[Math.floor(random() * SYLLABLES.length)];
  return out[0].toUpperCase() + out.slice(1);
}

function locales(random, count) {
  const entries = [];
  for (let i = 0; i < count; i++) {
    const code = `${word(random, 1, 1).toLowerCase()}-${String.fromCharCode(65 + (i % 26), 65 + ((i * 7) % 26))}`;
    const months = Array.from({ length: 12 }, () => word(random, 2, 4));
    const days = Array.from({ length: 7 }, () => word(random, 2, 3));
    const pattern = ["dddd, MMMM D", "D MMMM, dddd", "MMMM D (dddd)", "dddd D. MMMM"][i % 4];
    entries.push(`  ${JSON.stringify(code)}: { m: ${JSON.stringify(months)}, d: ${JSON.stringify(days)}, p: ${JSON.stringify(pattern)} }`);
  }
  return `const LOCALES = {\n${entries.join(",\n")}\n};`;
}

function zones(random, count, transitions) {
  const entries = [];
  for (let i = 0; i < count; i++) {
    const name = `${word(random, 2, 3)}/${word(random, 2, 4)}`;
    let at = 1_262_304_000 + Math.floor(random() * 10_000_000);
    const rows = [];
    for (let t = 0; t < transitions; t++) {
      at += 15_000_000 + Math.floor(random() * 2_000_000);
      const offset = (Math.floor(random() * 57) - 24) * 15;
      rows.push(`${at.toString(36)}|${offset}`);
    }
    entries.push(`  ${JSON.stringify(name)}: ${JSON.stringify(rows.join(","))}`);
  }
  return `const ZONES = {\n${entries.join(",\n")}\n};`;
}

const ENGINE = `
function parseZone(packed) {
  return packed.split(",").map((row) => {
    const [at, offset] = row.split("|");
    return { at: parseInt(at, 36) * 1000, offset: Number(offset) };
  });
}

function offsetAt(transitions, time) {
  let lo = 0, hi = transitions.length - 1, found = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (transitions[mid].at <= time) { found = transitions[mid].offset; lo = mid + 1; } else { hi = mid - 1; }
  }
  return found;
}

function pad(value) { return value < 10 ? "0" + value : String(value); }

function format(date, locale, pattern) {
  const tokens = pattern.match(/dddd|MMMM|D|[^dMD]+/g) || [];
  let out = "";
  for (const token of tokens) {
    if (token === "dddd") out += locale.d[date.getUTCDay()];
    else if (token === "MMMM") out += locale.m[date.getUTCMonth()];
    else if (token === "D") out += date.getUTCDate();
    else out += token;
  }
  return out;
}

function parseIso(text) {
  const match = /^(\\d{4})-(\\d{2})-(\\d{2})T(\\d{2}):(\\d{2})/.exec(text);
  if (!match) return NaN;
  return Date.UTC(+match[1], +match[2] - 1, +match[3], +match[4], +match[5]);
}

// Library initialisation: unpack every zone and warm a formatting cache for each
// locale — the kind of eager top-level work that blocks the main thread.
const ZONE_TABLE = {};
for (const name of Object.keys(ZONES)) ZONE_TABLE[name] = parseZone(ZONES[name]);
const FORMAT_CACHE = new Map();
const zoneNames = Object.keys(ZONE_TABLE);
const localeCodes = Object.keys(LOCALES);
let checksum = 0;
for (let i = 0; i < WARM_ITERATIONS; i++) {
  const time = 1_600_000_000_000 + i * 3_600_000 * 7;
  const zone = ZONE_TABLE[zoneNames[i % zoneNames.length]];
  const local = new Date(time + offsetAt(zone, time) * 60_000);
  const iso = local.getUTCFullYear() + "-" + pad(local.getUTCMonth() + 1) + "-" + pad(local.getUTCDate()) + "T" + pad(local.getUTCHours()) + ":" + pad(local.getUTCMinutes());
  const locale = LOCALES[localeCodes[i % localeCodes.length]];
  const text = format(new Date(parseIso(iso)), locale, locale.p);
  FORMAT_CACHE.set(iso + locale.p, text);
  checksum = (checksum + text.length) % 1_000_003;
}

const DELIVERY_DAYS = 3;
const node = document.querySelector("[data-delivery]");
if (node) {
  const arrives = new Date(Date.now() + DELIVERY_DAYS * 86_400_000);
  const en = { m: ["January","February","March","April","May","June","July","August","September","October","November","December"], d: ["Sunday","Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"] };
  node.textContent = "Arrives by " + format(arrives, en, "dddd, MMMM D");
  node.dataset.checksum = String(checksum);
}
`;

/**
 * Returns the heavy delivery-date script. `warmIterations` controls how much
 * main-thread work the top-level initialisation does.
 */
export function heavyDeliveryScript({ localeCount = 120, zoneCount = 110, transitions = 30, warmIterations = 14_000 } = {}) {
  const random = prng(20240611);
  return [
    "// date-lib-full (generated fixture) — simulates importing an entire date/timezone library.",
    `const WARM_ITERATIONS = ${warmIterations};`,
    locales(random, localeCount),
    zones(random, zoneCount, transitions),
    ENGINE,
  ].join("\n");
}
