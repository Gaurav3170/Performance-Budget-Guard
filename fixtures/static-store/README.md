# static-store fixture

A tiny zero-dependency store (`/`, `/products`, `/products/blue-running-shoe`) used to test perf-budget-guard end to end, locally and in CI.
`npm run build` writes `dist/` with content-hashed asset names; `npm run start` serves it gzip-compressed on `$PORT` (default 4100).
Build with `PBG_FIXTURE_HEAVY=1` to swap the product page's tiny `Intl`-based delivery-date script for a generated ~65 kB (~30 kB gzipped) "full date library" that does eager parsing/formatting work at load, simulating the "imported a whole date library" regression that `perf-budget.json` should catch.
