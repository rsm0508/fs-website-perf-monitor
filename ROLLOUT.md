# Rollout Checklist

## Prerequisites (30 minutes)

- [ ] Create a GitHub repo (public required for free-tier GitHub Pages; private is fine if you pay).
- [ ] Copy the **contents** of this `perf-monitor/` folder to the repo root — do not nest. Workflows assume a flat layout (package.json at root, .github/ at root, scripts/ at root, etc.).
- [ ] Push to `main`.
- [ ] Repo Settings → Pages → Source: **GitHub Actions**.
- [ ] Repo Settings → Actions → General → Workflow permissions: **Read and write**, and allow GitHub Actions to create and approve PRs + issues.
- [ ] Install `gh` CLI locally if you want to dry-run. Not required for production runs.

## Local smoke test (15 minutes)

Goal: prove the pipeline end-to-end on your machine before trusting cron. Run from the repo root.

```bash
npm install
npm run init-db
npm run discover
# Expect: "Discovered N pages and M posts..." and data/discovery-queue.json
node scripts/run-lighthouse.js --url https://www.fullsession.io/ --device mobile
# Expect: an OK line with metrics printed, files under reports/
npm run detect-regressions
# Expect: either "No regressions" or a list; regressions-summary.md written
npm run build-dashboard
# Then open dashboard/index.html
```

Verify:
- [ ] `data/perf.db` has `urls` rows (`sqlite3 data/perf.db 'SELECT tier, COUNT(*) FROM urls GROUP BY tier'`).
- [ ] `data/perf.db` has at least one row in `runs`.
- [ ] `reports/screenshots/` has one JPG.
- [ ] `reports/lighthouse/` has one HTML.
- [ ] `dashboard/index.html` renders in a browser.

## First workflow run (manual)

- [ ] Push everything to `main`.
- [ ] In the GitHub Actions tab, manually run `Discover URLs` workflow. Confirm green.
- [ ] Confirm commit landed with `data/perf.db` populated.
- [ ] Manually run `Monitor Tier 0`. Confirm green, three URLs tested for each device.
- [ ] Manually run `Build Dashboard`. Confirm green.
- [ ] Visit the Pages URL (Settings → Pages shows it). Confirm dashboard renders with your Tier 0 runs.

## Configure alerting (optional, do this before enabling schedules)

See `ALERTING.md` for full details. Quick version:

- [ ] Decide which channels you want: email (recommended), Slack webhook, or Discord webhook.
- [ ] Email: pick SES (you are already on AWS), Gmail app password, or Resend. Add the SMTP secrets listed in ALERTING.md.
- [ ] Slack: if you have a free app slot, install Incoming Webhooks and set `SLACK_WEBHOOK_URL`. If not, use Discord.
- [ ] Discord: fastest — make a webhook and set `DISCORD_WEBHOOK_URL`.
- [ ] Always-on path: GitHub Issues. Ensure you're watching the repo with "Issues" notifications turned on.

You can set zero channels initially and still get GitHub Issues. Add email or a webhook later.

## Enable the schedules

- [ ] Leave the cron schedules in place. They are already written into the workflows.
- [ ] Watch the first 48 hours closely. Expected:
  - 2 Tier 0 runs (noon and midnight UTC)
  - 1 Discover run (06:00 UTC)
  - 1 Posts slice run (04:00 UTC)
  - 0-few New URL runs (only if your sitemaps grew)
  - 0 Recheck runs (unless Tier 0 flagged something)

## Validation criteria (end of week 1)

- [ ] Tier 0 runs are consistent. Variance of LCP across 12h runs should be < 15% in normal conditions. If higher, revisit warmup logic.
- [ ] At least one Core run completed. Inspect the dashboard cards.
- [ ] No workflow failures except ones you expected (e.g. a URL that legitimately 404s).
- [ ] Any `perf:fail` issues opened reflect real problems, not infra noise.
- [ ] Total Actions minutes used is under 400 for the week (leaves plenty of headroom).

## Tuning (week 2+)

- [ ] Review dashboard. Are the `ABSOLUTE_THRESHOLDS` in `config.js` realistic for this site, or are you drowning in false positives?
- [ ] If Tier 0 has LCP in the 2500-3500 range consistently, consider lowering the fail threshold to catch earlier regressions.
- [ ] Check the weekly Core desktop pass completed.
- [ ] Add any new high-value pages to `TIER0_URLS` or Core patterns in `config.js`.

## When things go wrong

- **Git conflicts in `data/perf.db`**: SQLite is binary, merges can fail. The `concurrency: perf-monitor-write` group in each workflow prevents concurrent writes. If you see a conflict anyway, resolve by taking the latest workflow's version (DB can always be rebuilt from HTML reports if needed, though this rarely matters).
- **Workflow fails with Chrome crash**: bump Chrome version, or add `--no-sandbox` which is already set. If persistent, reduce parallelism.
- **All metrics show as null**: Lighthouse config error. Check the stored `report_path` HTML; Lighthouse errors are usually visible there.
- **Dashboard shows wrong URLs**: active=0 URLs are excluded. Check `urls` table; if something got deactivated by mistake, flip it with a SQL UPDATE.
- **Actions minutes running out**: disable the Posts workflow first (lowest ROI). Then tighten Core cadence to 5 days.

## Phase 2 triggers

Only bolt on Phase 2 features once Phase 1 has been quietly green for two weeks.

- [ ] Add Slack/Discord webhook alerts (15 minutes).
- [ ] Tune per-URL budgets based on observed baselines.
- [ ] Add a `/rebaseline` slash command support in the regressions workflow.
- [ ] Consider moving screenshots to S3 if repo size > 1GB.
