# FullSession Performance Monitor

Synthetic performance monitoring for fullsession.io. Scheduled Lighthouse runs, SQLite history, regression alerts via GitHub Issues, static dashboard on GitHub Pages.

See `DESIGN.md` for full design rationale, `ALERTING.md` for email/Slack/Discord setup, `ROLLOUT.md` for the step-by-step deploy checklist. This file is the operator's cheat sheet.

## Prerequisites

- A GitHub repository (private is fine).
- GitHub Pages enabled for the repo (Settings → Pages → Source: GitHub Actions).
- A `GITHUB_TOKEN` is provided automatically to workflows. No secrets to set up for MVP.

## Local development

Run from the repo root (all perf-monitor/ contents are flattened to root).

```bash
npm install
# Initialize the database
npm run init-db
# Discover URLs and write data/discovery-queue.json
npm run discover
# Run a single URL for testing
node scripts/run-lighthouse.js --url https://www.fullsession.io/ --device mobile
# Check for regressions
npm run detect-regressions
# Build the dashboard
npm run build-dashboard
# Then open dashboard/index.html
```

## Deployment

Push to `main`. The workflows take over from there.

Schedules, in repo time (UTC):
- `discover.yml` — daily 06:00
- `monitor-tier0.yml` — 02:00 and 14:00
- `monitor-core.yml` — 03:00 every 3 days
- `monitor-posts.yml` — daily 04:00 (tests 1/7 of posts)
- `monitor-new.yml` — hourly, tests anything in the new-URL queue
- `recheck-failed.yml` — hourly, tests anything flagged in the last 24h
- `build-dashboard.yml` — after any monitor workflow succeeds

## Tuning

Edit `scripts/config.js` for:
- Tier 0 URL list
- Core path patterns
- Threshold values
- Lighthouse Chrome flags

## Reading a regression issue

Each issue has:
- URL, device, run ID
- Current metric values vs baseline median
- Link to the Lighthouse HTML report
- Link to the screenshot
- Auto-closes if a 24h retest clears.

If the issue is a true regression, fix it and the next scheduled run will close the issue automatically.

If it is a false positive and you want to rebaseline, comment `/rebaseline` (future enhancement — for now, close manually).

## Scaling notes

At the proposed cadence this system runs roughly 2,500 Lighthouse audits per month. GitHub Actions free tier is 2,000 minutes/month for private repos, and each audit takes ~20 seconds including warmup + overhead. Budget: ~850 minutes/month. Within free tier.

If posts list grows past ~500, the 1/7 daily sample keeps per-day load linear; adjust the slice if you want faster full coverage.
