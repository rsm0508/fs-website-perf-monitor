# FullSession Performance Monitor — Design

## 1. Architecture

Scheduled GitHub Actions run Node scripts that invoke Lighthouse via its Node API. Results go into a SQLite file committed to the repo. Screenshots and full Lighthouse HTML reports go into `reports/`. A static dashboard is generated from SQLite and deployed to GitHub Pages. Regressions open GitHub Issues.

```
                   ┌─────────────────────────┐
                   │  GitHub Actions (cron)  │
                   └─────────────┬───────────┘
                                 │
          ┌──────────┬───────────┼───────────┬──────────┐
          ▼          ▼           ▼           ▼          ▼
     discover     tier0       core        posts      recheck
      (06:00)   (every 12h)  (3 days)  (daily 1/7)  (on flag)
          │          │           │           │          │
          └──────────┴───────────┼───────────┴──────────┘
                                 ▼
                   ┌─────────────────────────┐
                   │   run-lighthouse.js     │
                   │ (Lighthouse Node API)   │
                   └─────────────┬───────────┘
                                 │ writes
                                 ▼
                   ┌─────────────────────────┐
                   │ data/perf.db  (SQLite)  │
                   │ reports/*  (PNG + HTML) │
                   └─────────────┬───────────┘
                                 │
               ┌─────────────────┴──────────────────┐
               ▼                                    ▼
    detect-regressions.js                  build-dashboard.js
    → opens GH Issues                      → dashboard/index.html
                                           → GitHub Pages
```

## 2. Rationale for the key choices

- **Lighthouse Node API over CLI**: cleaner JSON access, no subprocess parsing, fewer edge cases.
- **SQLite in the repo**: real relational store, free, zero ops, git history = audit trail. Migrates cleanly to Turso or Postgres later.
- **GitHub Actions**: free at this volume, cron built in, secrets built in, Pages deployment built in. No servers.
- **Issues for alerting**: zero setup, already where engineering work lives. Slack is a 4-line addition later if needed.
- **Screenshots in git (compressed PNG ~50-150KB each)**: simplest durable storage. If it balloons, move to S3 with a hash-named key and store only the URL.

## 3. Cadence rules

| Tier | URLs | Cadence | Device | Runs |
|---|---|---|---|---|
| Tier 0 | `/`, `/book-a-demo/`, `/pricing/` | 12h | Mobile + Desktop | 1 warmup + 1 measure |
| Core | `/compare/*`, `/hotjar-alternatives/`, `/hotjar-review/`, `/signup/`, others flagged core | 3 days | Mobile | 1 warmup + 1 measure |
| Core desktop | Core URLs | 7 days | Desktop | 1 warmup + 1 measure |
| Posts | `post-sitemap.xml` | 1/7 of posts per day, rolling | Mobile | 1 warmup + 1 measure |
| New | Any URL discovered for the first time | within 1h | Mobile | 1 |
| Changed | Any URL with updated `lastmod` since last discovery | promoted into next scheduled run | Mobile | 1 |
| Flagged | Any URL that failed thresholds or regressed | 24h | Mobile (desktop if Tier 0) | 3, median |

**Warmup policy**: on every measured run we do one throwaway `fetch` of the URL (no Lighthouse) to warm the origin cache and any CDN tier, then run Lighthouse. This reduces between-run variance to roughly the level of a 3-run median at 1/3 the cost. Flagged URLs go back to true median-of-3 because that is where accuracy matters.

## 4. URL discovery logic

Daily at 06:00 UTC:

1. GET `https://www.fullsession.io/page-sitemap.xml` and `https://www.fullsession.io/post-sitemap.xml`.
2. Parse `<loc>` and `<lastmod>` with a small XML parser.
3. For each URL, compute `tier`:
   - Tier 0 if it matches the hardcoded Tier 0 list.
   - Core if it matches core path patterns (`/compare/`, `/pricing/`, `/signup/`, `/hotjar-`, etc.).
   - Post if it came from `post-sitemap.xml`.
   - Other otherwise.
4. Upsert into `urls`: set `last_seen` to now, update `lastmod`, compute `changed` flag if new `lastmod` > prior `lastmod`.
5. Diff: any URL not previously in `urls` is "new" and gets queued for the immediate new-URL workflow. Any URL in `urls` but not in today's sitemap gets `active = 0`.
6. Write a `data/discovery-queue.json` snapshot with new + changed URLs. The monitor workflows consume this.

## 5. Regression detection rules

Evaluated after every successful Lighthouse run:

**Absolute fail thresholds (mobile)**
- LCP > 4000 ms
- CLS > 0.25
- TBT > 600 ms
- TTFB > 1500 ms
- Performance score < 40

Any one of these opens a `perf:fail` issue.

**Relative regression**
- Rolling baseline = median of last 10 good runs for same `url + device`, excluding the current run.
- If current value is > 20% worse than baseline on LCP, TBT, CLS, or total_byte_weight: open `perf:regression` issue.
- If fewer than 5 historical runs exist, skip relative check (not enough signal).

**New console errors**
- Count distinct console error messages. If count > previous run's count for same URL, open `perf:js-error` issue with diff.

**Retest policy**
- Any flagged URL is queued for retest in 24h with 3 runs, median-of-3.
- Retest pass → auto-close issue with comment "cleared on retest".
- Retest fail → comment with confirmed values, leave open.

## 6. Data model

See `schema.sql`. Three tables:

- `urls` — one row per URL discovered. Fields: url (PK), tier, first_seen, last_seen, last_checked, lastmod, active.
- `runs` — one row per Lighthouse run. Fields include all metrics, device, status, timestamps, screenshot_path, report_path, top_resources_json, console_errors.
- `regressions` — one row per regression event. Links to `runs.id`, carries metric, current/baseline, pct_delta, severity, acknowledged flag, opened GH issue number.

Indexes on `runs.url`, `runs.started_at`, `regressions.url`.

## 7. Dashboard

A static HTML page generated by `build-dashboard.js` after each monitor run. Pulls from SQLite and outputs to `dashboard/index.html`. Deployed to GitHub Pages.

Sections:
- **Headline scorecard**: last 24h runs, failure count, regression count.
- **Tier 0 cards**: current LCP/CLS/TBT/score per URL, 30-day sparkline each.
- **Watchlist**: URLs with open regressions, sorted by severity.
- **All URLs table**: sortable, links to latest Lighthouse HTML report and screenshot.
- **Per-URL page**: trend charts for each metric, list of recent regressions, last 10 runs.

Chart library: Chart.js via CDN. No build step, no framework.

## 8. Phased rollout

**Phase 1 (MVP, this week)**
- Schema, discovery, Tier 0 + Core monitoring, regression detection (absolute only), GitHub Issues alerting, a very basic dashboard.
- Ship one workflow at a time, verify output, then schedule.
- Days to ship: 2-3 focused.

**Phase 2 (next month, only if Phase 1 is stable)**
- Posts monitoring, relative regression detection, retest workflow, lastmod-driven priority, console-error tracking, Pages dashboard with trend charts.

**Phase 3 (later, only if needed)**
- Playwright journey tests (book-a-demo flow, signup flow).
- Slack alerts.
- Per-page budgets tuned from observed baselines.
- Migrate to Turso if DB size > 500MB or query speed degrades.

## 9. Maintenance checklist

**Weekly (10 minutes)**
- Review open `perf:*` issues; triage or close.
- Check that all scheduled workflows ran successfully (green in the Actions tab).
- Skim the dashboard for new regressions not yet alerted.

**Monthly (30 minutes)**
- Prune old `runs` rows beyond 12 months (archive to a separate file if you want long history).
- Vacuum the SQLite file (`sqlite3 data/perf.db 'VACUUM;'`).
- Compress or purge old screenshots (keep last 90 days by default).
- Re-check Tier 0 and Core URL lists; adjust if site IA changed.
- Re-check absolute thresholds against observed baselines; tighten if you are consistently well under.

**Quarterly**
- Review whether cadences are right given traffic/revenue patterns.
- Consider expanding to Phase 3 features.

## 10. Risk register

| Risk | Likelihood | Mitigation |
|---|---|---|
| GitHub Actions rate limits | Low | Well under free tier limits at proposed cadence. |
| Site blocks GH Actions runners | Low | If it happens, whitelist GH Actions IP ranges in Cloudflare, or proxy through a small VM. |
| SQLite corruption on concurrent writes | Low | Workflows are serialized by `concurrency:` group per script. |
| Screenshot repo bloat | Medium | Retention policy in maintenance. At 100 screenshots/day × 100KB = 10MB/day, 3.6GB/year. Acceptable for 1-2 years; after that, move to S3. |
| Lighthouse version drift changing scores | Medium | Pin `lighthouse` version in `package.json`. Review before upgrading. Document the upgrade date. |
| Regression false positives on days with legitimate changes | Medium | Issue contains a "dismiss and re-baseline" link; future enhancement to acknowledge & rebase. |
