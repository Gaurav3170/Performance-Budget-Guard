# Perf Budget Guard

Perf Budget Guard catches pull requests that make your pages slower. On every PR it builds your app twice, once from the base branch and once from the PR, measures both with Lighthouse on the same runner, and compares JavaScript size, total transfer size and the Lighthouse lab metrics page by page. When something got worse it names the scripts that caused it, checks the result against your budget, and posts it as a single PR comment that is updated in place on every push. It runs as a GitHub Action or as a CLI on your own machine.

## In plain words

Code review checks whether a change is correct. It rarely checks whether the change made the site slower, so pages get slower a little at a time: a large library in one PR, an unoptimised image in the next.

Perf Budget Guard is that check, run on every pull request:

1. It builds your site twice: as it is on your main branch, and with the pull request's changes.
2. It loads the pages you list in Lighthouse on a simulated phone, several times each, and keeps the typical result so one slow load doesn't count.
3. It compares the two builds: how much JavaScript each page downloads, how long the main content takes to appear, and how long the page is too busy to respond.
4. It checks the PR build against the limits you set, such as "the home page downloads at most 300 kB of JavaScript" or "one PR may not slow down Largest Contentful Paint by more than 10%".
5. It posts the result on the pull request: 🟢 fine, 🟡 worth a look or 🔴 over budget. On 🔴 the check fails, so the PR can be blocked from merging.

You add two files to your repository, a workflow that runs the check and a budget file with your limits, and every pull request is checked from then on.

## Example comment

> **Example.** The numbers below are illustrative, not a real measurement. The PR adds a date library to the product page.

---

### 🔴 Perf Budget Guard: 1 of 3 pages over budget
Mobile · median of 5 runs · Lighthouse 12.8.2 · `3f2a91c` (base) → `8c1d0e2` (head)

#### 🔴 `/products/blue-running-shoe`

| Metric | Base | Head | Change | Budget |
| --- | --- | --- | --- | --- |
| Performance score | 92 | 81 | **-11 (-12%)** | max -5 |
| Largest Contentful Paint | 2.1 s | 2.8 s | **+650 ms (+31%)** | 2.5 s · max +10% |
| Total Blocking Time | 120 ms | 290 ms | **+170 ms (+142%)** | 200 ms |
| Speed Index | 2.0 s | 2.4 s | **+350 ms (+17%)** | — |
| JavaScript (transferred) | 125 kB | 198 kB | **+73.1 kB (+59%)** | 170 kB · max +10.0 kB |
| Total transferred | 455 kB | 528 kB | **+73.0 kB (+16%)** | — |

- **Performance score:** -11 (-12%), more than the allowed -5
- **Largest Contentful Paint:** over the 2.5 s budget
- **Largest Contentful Paint:** +650 ms (+31%), more than the allowed +10%
- **Total Blocking Time:** over the 200 ms budget
- **Speed Index:** got worse by 350 ms
- **JavaScript (transferred):** over the 170 kB budget
- **JavaScript (transferred):** +73.1 kB (+59%), more than the allowed +10.0 kB
- **Total transferred:** got worse by 73.0 kB

**Scripts that changed**
| Script | Base | Head | Change |
| --- | --- | --- | --- |
| `/_next/static/chunks/moment-with-locales-*.js` | — | 72.0 kB | +72.0 kB (added) |
| `/_next/static/chunks/pages/products/[slug]-*.js` | 11.8 kB | 12.9 kB | +1.1 kB |

<details><summary>All metrics</summary>

| Metric | Base | Head | Change | Budget |
| --- | --- | --- | --- | --- |
| Performance score | 92 | 81 | **-11 (-12%)** | max -5 |
| Largest Contentful Paint | 2.1 s | 2.8 s | **+650 ms (+31%)** | 2.5 s · max +10% |
| First Contentful Paint | 1.1 s | 1.2 s | +30 ms (+3%) | — |
| Total Blocking Time | 120 ms | 290 ms | **+170 ms (+142%)** | 200 ms |
| Cumulative Layout Shift | 0.01 | 0.01 | ±0 | — |
| Speed Index | 2.0 s | 2.4 s | **+350 ms (+17%)** | — |
| JavaScript (transferred) | 125 kB | 198 kB | **+73.1 kB (+59%)** | 170 kB · max +10.0 kB |
| Total transferred | 455 kB | 528 kB | **+73.0 kB (+16%)** | — |

</details>

✅ No significant changes: `/`, `/products`

<sub>Changes smaller than run-to-run noise are ignored. [Workflow run](#)</sub>

---

Script names have their content hashes replaced with `*`, so the same chunk can be matched between the two builds. When you push a fix, the comment is rewritten and the earlier result is kept in a collapsed "Previous run" section, so the PR shows both the regression and the fix.

## Quick start

Your app needs:

- a production build command and a start command in `package.json` (for example `next build` and `next start`);
- a start command that listens on the port in the `PORT` environment variable (`next start` and most Node servers already do);
- a repository on GitHub, for the PR comment. To try the tool without GitHub, see [Run it locally](#run-it-locally).

Then:

1. Add `.github/workflows/perf-budget.yml` (also in [`examples/perf-budget.yml`](examples/perf-budget.yml)):

   ```yaml
   name: Perf budget

   on:
     pull_request:

   permissions:
     contents: read
     pull-requests: write

   concurrency:
     group: perf-budget-${{ github.event.pull_request.number }}
     cancel-in-progress: true

   jobs:
     perf-budget:
       runs-on: ubuntu-latest
       timeout-minutes: 30
       steps:
         - uses: actions/checkout@v4

         - uses: actions/setup-node@v4
           with:
             node-version: 20
             cache: npm

         - uses: Gaurav3170/Performance-Budget-Guard@v1
           with:
             config: perf-budget.json
   ```

2. Add `perf-budget.json` at the root of your app:

   ```json
   {
     "pages": ["/", "/products"],
     "server": {
       "build": "npm run build",
       "start": "npm run start"
     },
     "budgets": {
       "jsBytes": "170 kB",
       "lcp": "2.5 s"
     },
     "maxIncrease": {
       "jsBytes": "10 kB",
       "lcp": "10%"
     }
   }
   ```

   The `start` command must serve the production build on the port given in the `PORT` environment variable. `next start`, `vite preview --port $PORT` and most Node servers already do this. [`examples/perf-budget.json`](examples/perf-budget.json) is a fuller config for a Next.js app.

3. Open a pull request. You don't need `fetch-depth: 0`: the action fetches the base commit itself.

`@v1` follows the latest 1.x release. To pin an exact release, use `@v1.0.0`.

The first run takes a while, often 10–15 minutes for 3 pages at 5 runs each: it installs and builds your app twice, then runs Lighthouse `runs × pages × 2` times. Run it once on a PR that changes nothing, look at the numbers, and set your budgets a little above them.

### Action inputs

| Input | Default | Meaning |
| --- | --- | --- |
| `config` | `perf-budget.json` | Budget file, relative to `working-directory`. |
| `working-directory` | `.` | The app to build and measure. Use this in monorepos. |
| `base-ref` | the PR's base commit | Branch, tag or SHA to compare against. Setting it also lets the action run outside `pull_request` events, with results going only to the job summary. |
| `github-token` | `${{ github.token }}` | Used to read and write the PR comment. |
| `comment` | `true` | Post or update the PR comment. The job summary is always written. |
| `fail-on-budget` | `true` | Fail the job when a page breaks the budget. |
| `skip-head-install` | `false` | Your workflow already installed the PR's dependencies. |
| `skip-head-build` | `false` | Your workflow already built the PR. |

Outputs: `status` (`pass`, `warn` or `fail`) and `comment-url`.

## Configuration reference

Every field except `pages` is optional.

| Field | Default | Meaning |
| --- | --- | --- |
| `pages` | (required) | Paths to measure, each starting with `/`. |
| `runs` | `5` | Lighthouse runs per page per build (1–15). The median is compared. |
| `formFactor` | `"mobile"` | `"mobile"` (Lighthouse's default throttled phone) or `"desktop"`. |
| `server.install` | from the lockfile | Install command run in each checkout before the build. Without it, the lockfile decides: `package-lock.json` → `npm ci`, `pnpm-lock.yaml` → `pnpm install --frozen-lockfile`, `yarn.lock` → `yarn install --frozen-lockfile`, no lockfile → no install. |
| `server.build` | `"npm run build"` | Production build command. |
| `server.start` | `"npm run start"` | Starts the production server. It must listen on `$PORT`. |
| `server.port` | `4100` | Port for the PR build. The base build uses `port + 1`. |
| `server.readyPath` | the first page | Polled until it responds, before measuring starts. |
| `server.readyTimeoutMs` | `60000` | How long to wait for the server to become ready. |
| `budgets` | `{}` | Absolute limits on the PR build's median, keyed by metric id. For the performance score this is a minimum; for every other metric it is a maximum. |
| `maxIncrease` | `{}` | The largest regression allowed from base to PR, keyed by metric id. |

**Metric ids**

| Id | Metric | Units |
| --- | --- | --- |
| `performance` | Lighthouse performance score | score 0–100 (higher is better) |
| `lcp` | Largest Contentful Paint | `ms`, `s` |
| `fcp` | First Contentful Paint | `ms`, `s` |
| `tbt` | Total Blocking Time | `ms`, `s` |
| `cls` | Cumulative Layout Shift | unitless, e.g. `0.1` |
| `speedIndex` | Speed Index | `ms`, `s` |
| `jsBytes` | JavaScript transferred | `B`, `kB`, `KiB`, `MB`, `MiB` |
| `totalBytes` | Everything transferred | `B`, `kB`, `KiB`, `MB`, `MiB` |

Write values as strings with a unit (`"170 kB"`, `"2.5 s"`, `"200 ms"`) or as plain numbers in the base unit (bytes, milliseconds, score points). `kB` and `MB` are decimal (1 kB = 1000 bytes), which matches what Chrome DevTools shows. `KiB` and `MiB` are binary (1 KiB = 1024 bytes). Sizes are transfer sizes, so after compression.

**`budgets` vs `maxIncrease`.** A budget is a fixed line the page must stay within, whatever the base branch does. `maxIncrease` limits how much one PR may make things worse, even when the page is still well inside its budget. Use both: budgets stop slow creep across many PRs, and `maxIncrease` catches one large jump early.

`maxIncrease` takes either a percentage of the base value (`"10%"`) or an absolute amount in the metric's units (`"10 kB"`, `"50 ms"`, or `5` for five score points). A percentage is easy to apply across pages of different sizes. An absolute amount behaves more predictably on small values, where a few bytes can be a large percentage.

Unknown keys are rejected with a "did you mean" hint, so a typo like `"lpc"` can't silently turn a budget off.

## How it decides

1. Each page is measured `runs` times per build. Base and PR runs are interleaved, and the order flips every round, so slow drift on the runner (thermal throttling, a noisy neighbour) affects both builds equally.
2. Each metric is compared on its median, along with the min and max.
3. A change counts only if it is larger than all three of: the metric's noise floor, its relative floor (a share of the base value), and half the run-to-run spread (max − min) observed in either build. A single slow run can't fail a PR.

   | Metric | Noise floor | Relative floor |
   | --- | --- | --- |
   | Performance score | 3 points | — |
   | LCP, FCP | 100 ms | 5% |
   | Total Blocking Time | 30 ms | 15% |
   | CLS | 0.01 | — |
   | Speed Index | 150 ms | 5% |
   | JavaScript | 1 KiB (1,024 B) | — |
   | Total transferred | 2 KiB (2,048 B) | — |

   The relative floor exists because timing noise grows with the value. On a page with 800 ms of blocking time, two runs of the same commit can differ by 100 ms; on a page with 50 ms they barely move. Byte counts are the same on every run, so their small absolute floor is enough. Budgets are checked on the medians whether or not a change is significant.

4. Each metric then gets a status:
   - **fail**: the PR build breaks a budget.
   - **warn**: over budget, but the base branch is over budget too and the PR doesn't make it worse. Existing debt doesn't block unrelated PRs.
   - **fail**: a significant regression larger than `maxIncrease`.
   - **warn**: a significant regression on a metric with no limit set.
   - **pass**: anything else, including improvements.

A page takes the worst status of its metrics, and the run takes the worst status of its pages. The job fails only on `fail`, and only when `fail-on-budget` is on.

## Architecture

```
 actions/checkout (PR)
        │
        ▼
 git worktree add --detach <tmp> <base sha>      base checkout, outside the repo
        │
        ▼
 install + build base  ──►  install + build PR   sequential, one at a time
        │
        ▼
 start both servers:  PR on :port   base on :port+1
        │
        ▼
 Lighthouse runs, interleaved:  base, PR, PR, base, ...  (runs × pages × 2)
        │
        ▼
 compare   medians, noise floors, budgets  ──►  comparison.json
        │
        ▼
 render    one markdown comment  ──►  comment.md
        │
        ▼
 update the existing PR comment (or create it)  +  write the job summary
```

The base checkout lives in a temporary directory outside your repository. If it were inside, tools that scan sub-directories (TypeScript, ESLint, Next.js) and Node's module resolution could pick up the other build's files. It is removed when the run ends, and leftovers from a crashed run are cleaned up on the next one. The builds run one after the other because two parallel builds on a 2-core runner slow each other down and mix their logs.

## Run it locally

From your app's directory, in a git repository:

```sh
npx perf-budget-guard run
```

This compares your working tree, uncommitted changes included, with `origin/main` (or `main` if there is no `origin/main`). Progress goes to stderr and the markdown comment to stdout. Results are saved in `.perf-budget-guard/`: `base.json`, `head.json`, `comparison.json`, `comment.md` and the raw Lighthouse reports under `lighthouse/`. Add the folder to `.gitignore`.

```
perf-budget-guard run [--config perf-budget.json] [--base origin/main] [--out .perf-budget-guard]
                      [--skip-head-build] [--skip-head-install] [--no-fail] [--json]
perf-budget-guard compare --base-file base.json --head-file head.json [--config perf-budget.json] [--json]
perf-budget-guard --help | --version
```

`compare` recomputes the result from saved measurements without building or measuring again. Use it to tune budgets against a real run:

```sh
npx perf-budget-guard compare \
  --base-file .perf-budget-guard/base.json \
  --head-file .perf-budget-guard/head.json
```

`--json` prints the comparison as JSON instead of markdown. Exit codes: `0` pass or warn, `1` budget failed (unless `--no-fail`), `2` usage or tool error. Set `DEBUG=1` to see stack traces.

You need Node 18.17 or later, git, and a local Chrome or Chromium.

## Limitations

- **INP is not measured.** Interaction to Next Paint needs real user input. Total Blocking Time is the lab metric that tracks it most closely.
- **GitHub-hosted runners have no GPU.** Pages that rely on WebGL or heavy canvas work show more blocking time than they would on real devices. Use the comparison between base and PR, and don't read the absolute numbers as what users experience.
- **This is lab data, not field data.** It tells you whether a PR made a page slower under fixed conditions. It doesn't replace real-user monitoring.
- **It takes time.** A run costs roughly `runs × pages × 2` Lighthouse runs plus two installs and two production builds. With 5 runs and 3 pages that's 30 Lighthouse runs. Keep `pages` to the routes that matter, and use `concurrency` to cancel superseded runs.
- **PRs from forks can't comment with the default token.** GitHub gives them a read-only `GITHUB_TOKEN`. The action logs a warning, skips the comment and still writes the full result to the job summary.
- **`pull_request_target` is refused on purpose.** The action installs, builds and starts the pull request's code. Under `pull_request_target` that code would run with a write token and your repository's secrets, so a fork could steal them. Use `pull_request`.
- **It measures the merge commit by default.** `actions/checkout` checks out the PR merged into its base branch, so that's what gets built and measured, and the comment shows that commit's SHA. To measure the PR branch as pushed, check out `ref: ${{ github.event.pull_request.head.sha }}`.
- **Lighthouse version.** The tool pins Lighthouse 12.8.2 so it runs on Node 18.17 and later. Lighthouse's upstream dependencies carry `npm audit` advisories. They only matter if Lighthouse loads untrusted sites, and this tool only loads your own build on localhost.

## Development

```sh
npm install
npm test            # unit tests (node:test)
npm run typecheck
npm run build       # compiles to dist/
```

`fixtures/static-store` is a small zero-dependency store used to test the tool end to end. Building it with `PBG_FIXTURE_HEAVY=1` swaps a small script for a heavy "full date library" to simulate a regression:

```sh
cd fixtures/static-store
npm run build                        # normal build
PBG_FIXTURE_HEAVY=1 npm run build    # regressed build
```

## License

[MIT](LICENSE) © 2026 Gaurav Keswani
