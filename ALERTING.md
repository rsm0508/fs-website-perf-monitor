# Alerting Setup

Three alerting channels, all opt-in. Configure whichever you want; the rest stay dormant.

| Channel | Status | Cost | Setup time |
|---|---|---|---|
| GitHub Issues | Always on | Free | 0 minutes (you are already subscribed to your own repo) |
| Email (SMTP) | Opt-in | Free with Gmail/AWS SES | 5-10 minutes |
| Slack webhook | Opt-in | Free (incoming webhooks app does not count against free-plan app limit, but see note) | 5 minutes |
| Discord webhook | Opt-in | Free, no limits | 2 minutes |

Rule of thumb: if you want push notifications, pick **one** of Slack/Discord + email for redundancy. Do not wire up all three or you will fatigue yourself.

## GitHub Issues (already on)

No setup. Any regression opens an issue labeled `perf:fail` or `perf:regression`. To get email, ensure you are watching the repo: repo page → Watch → Custom → check "Issues".

If you only want the big ones, filter by label `perf:fail`.

## Email via SMTP

Pick a provider. Add secrets to the repo: **Settings → Secrets and variables → Actions → New repository secret**.

Required secrets for email:

| Secret | Example | Notes |
|---|---|---|
| `SMTP_HOST` | `smtp.gmail.com` or `email-smtp.us-east-1.amazonaws.com` | Provider's SMTP server |
| `SMTP_PORT` | `587` | Usually 587 (TLS) or 465 (SSL) |
| `SMTP_SECURE` | `false` | `true` only for port 465 |
| `SMTP_USER` | Gmail username or SES SMTP username | |
| `SMTP_PASS` | Gmail app password or SES SMTP password | Not your login password for Gmail |
| `SMTP_FROM` | `perf-monitor@fullsession.io` | Any sender address the provider allows |
| `NOTIFY_EMAIL` | `roman@fullsession.io` | Where alerts go |

### Option A — AWS SES (recommended since you are already on AWS)

1. In AWS console, open SES in your preferred region.
2. Verify a sender identity: either the full `perf-monitor@fullsession.io` address or the domain `fullsession.io`. Domain verification uses DNS records and is more flexible.
3. If you are still in the SES sandbox, also verify the recipient (`roman@fullsession.io`) or request production access.
4. Create SMTP credentials: SES console → SMTP settings → Create SMTP credentials. This generates an IAM user with SMTP-specific credentials.
5. Fill in the secrets above with the values from step 4.

Cost: ~$0.10 per 1,000 emails. You will send maybe 30-50 a month. This is effectively free.

### Option B — Gmail (fastest to set up)

1. Turn on 2FA for the Gmail account.
2. Go to Google Account → Security → App passwords (requires 2FA). Generate one for "Mail".
3. Use:
   - `SMTP_HOST = smtp.gmail.com`
   - `SMTP_PORT = 587`
   - `SMTP_SECURE = false`
   - `SMTP_USER` = the full Gmail address
   - `SMTP_PASS` = the 16-character app password
   - `SMTP_FROM` = the Gmail address
   - `NOTIFY_EMAIL` = `roman@fullsession.io`

Limit: 500 emails/day on regular Gmail, plenty for this use.

### Option C — Resend

1. Sign up at resend.com, create an API key.
2. Set:
   - `SMTP_HOST = smtp.resend.com`
   - `SMTP_PORT = 465`
   - `SMTP_SECURE = true`
   - `SMTP_USER = resend`
   - `SMTP_PASS` = your API key
   - Verify your sending domain in Resend.

Free tier: 3,000 emails/month.

## Slack webhook

**Free plan note**: On Slack's free plan, workspaces are capped at **10 apps/integrations**. The "Incoming Webhooks" app counts as one. If you are at the cap, remove an unused app first, or use Discord instead.

1. Go to your Slack workspace's app directory.
2. Install the **Incoming Webhooks** app.
3. Pick a channel (e.g. `#perf-alerts`) and click "Add Incoming Webhook Integration".
4. Copy the webhook URL (looks like `https://hooks.slack.com/services/T.../B.../...`).
5. Add as a repo secret: `SLACK_WEBHOOK_URL`.

That is it. The notifier sends formatted messages with severity counts, a per-regression list, and a button to the dashboard.

## Discord webhook (recommended if Slack slots are scarce)

Discord webhooks are free, unlimited, and do not count against anything.

1. In your Discord server, go to Server Settings → Integrations → Webhooks → New Webhook.
2. Pick a channel (e.g. `#perf-alerts`).
3. Copy the webhook URL.
4. Add as a repo secret: `DISCORD_WEBHOOK_URL`.

Done.

## Testing notifications without waiting for a real regression

You can force a test by inserting a fake regression row and running notify.js locally:

```bash
sqlite3 data/perf.db "INSERT INTO regressions (run_id, url, device, metric, current_value, baseline_value, pct_delta, severity, kind, detected_at) VALUES (1, 'https://www.fullsession.io/', 'mobile', 'lcp_ms', 5000, 2000, 1.5, 'fail', 'absolute', datetime('now'));"

# Export your secrets and run (substitute your values):
export SMTP_HOST=... SMTP_USER=... SMTP_PASS=... NOTIFY_EMAIL=roman@fullsession.io SMTP_PORT=587
export SLACK_WEBHOOK_URL=...
export DISCORD_WEBHOOK_URL=...
export GITHUB_REPOSITORY=you/fullsession-perf-monitor
node scripts/notify.js
```

Then clean up: `sqlite3 data/perf.db "DELETE FROM regressions WHERE url='https://www.fullsession.io/' AND current_value=5000;"`

## Dashboard visibility note

The dashboard is deployed to GitHub Pages. On a free-tier GitHub plan, Pages **requires a public repo**. The perf data itself is not sensitive (it is just metrics on your public marketing site), so making the repo public is usually fine. If you want the repo private and the dashboard private:
- GitHub Pro plan enables private Pages with access control.
- Alternatively, skip Pages and read `dashboard/index.html` directly from the repo, or host it on Cloudflare Pages / Netlify with password protection.
