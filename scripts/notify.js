// Notification dispatcher. Runs after detect-regressions. All channels are opt-in
// via env vars — if a channel's config is missing, it is silently skipped. The
// GitHub Issues path is owned by detect-regressions.js and always on.
//
// Channels:
//   1. SMTP email (if SMTP_HOST, SMTP_USER, SMTP_PASS, NOTIFY_EMAIL are set)
//   2. Slack webhook (if SLACK_WEBHOOK_URL is set)
//   3. Discord webhook (if DISCORD_WEBHOOK_URL is set)
//
// Only fires when detect-regressions created new rows in the last NOTIFY_WINDOW_HOURS.

import nodemailer from 'nodemailer';
import { getDb } from './utils/db.js';

const db = getDb();
const NOTIFY_WINDOW_HOURS = 2;
const now = new Date();
const cutoff = new Date(now.getTime() - NOTIFY_WINDOW_HOURS * 3600 * 1000).toISOString();

const regressions = db.prepare(`
  SELECT r.url, r.device, r.metric, r.current_value, r.baseline_value, r.pct_delta,
         r.severity, r.kind, r.detected_at, r.gh_issue
  FROM regressions r
  WHERE r.detected_at >= ?
  ORDER BY
    CASE r.severity WHEN 'fail' THEN 0 ELSE 1 END,
    r.detected_at DESC
`).all(cutoff);

if (regressions.length === 0) {
  console.log('No regressions in the last ' + NOTIFY_WINDOW_HOURS + 'h. Skipping notifications.');
  process.exit(0);
}

const failCount = regressions.filter((r) => r.severity === 'fail').length;
const warnCount = regressions.length - failCount;

const subject = `[fullsession-perf] ${regressions.length} regression${regressions.length > 1 ? 's' : ''} detected` +
  (failCount ? ` (${failCount} fail)` : '');

function fmtValue(v) {
  if (v == null) return 'n/a';
  if (typeof v !== 'number') return String(v);
  return v >= 1 ? Math.round(v).toString() : v.toFixed(3);
}

function formatLine(r) {
  const delta = r.pct_delta != null ? ` (+${(r.pct_delta * 100).toFixed(1)}%)` : '';
  const baseline = r.baseline_value != null ? ` vs ${fmtValue(r.baseline_value)}` : '';
  const issue = r.gh_issue ? ` [issue #${r.gh_issue}]` : '';
  return `- [${r.severity.toUpperCase()}] ${r.url} (${r.device}) ${r.metric}: ${fmtValue(r.current_value)}${baseline}${delta}${issue}`;
}

const repo = process.env.GITHUB_REPOSITORY || '';
const owner = repo.split('/')[0];
const name = repo.split('/')[1];
const pagesUrl = owner && name ? `https://${owner}.github.io/${name}/` : null;
const issuesUrl = repo ? `https://github.com/${repo}/issues?q=is%3Aissue+is%3Aopen+label%3Aperf` : null;

const textLines = [
  `${regressions.length} new regression${regressions.length > 1 ? 's' : ''} detected on fullsession.io.`,
  `${failCount} fail, ${warnCount} warn.`,
  '',
  ...regressions.slice(0, 25).map(formatLine),
];
if (regressions.length > 25) textLines.push('', `...and ${regressions.length - 25} more (see dashboard or Issues).`);
textLines.push('');
if (pagesUrl) textLines.push(`Dashboard: ${pagesUrl}`);
if (issuesUrl) textLines.push(`Open perf issues: ${issuesUrl}`);
const text = textLines.join('\n');

const htmlLines = [
  `<p><strong>${regressions.length} new regression${regressions.length > 1 ? 's' : ''}</strong> detected on fullsession.io. ${failCount} fail, ${warnCount} warn.</p>`,
  '<ul>',
  ...regressions.slice(0, 25).map((r) => {
    const delta = r.pct_delta != null ? ` (+${(r.pct_delta * 100).toFixed(1)}%)` : '';
    const baseline = r.baseline_value != null ? ` vs ${fmtValue(r.baseline_value)}` : '';
    const issueLink = r.gh_issue ? ` <a href="https://github.com/${repo}/issues/${r.gh_issue}">#${r.gh_issue}</a>` : '';
    const color = r.severity === 'fail' ? '#c0392b' : '#e67e22';
    return `<li><span style="color:${color};font-weight:600">[${r.severity.toUpperCase()}]</span> <a href="${r.url}">${r.url}</a> (${r.device}) <code>${r.metric}</code>: ${fmtValue(r.current_value)}${baseline}${delta}${issueLink}</li>`;
  }),
  '</ul>',
];
if (regressions.length > 25) htmlLines.push(`<p>...and ${regressions.length - 25} more.</p>`);
if (pagesUrl) htmlLines.push(`<p><a href="${pagesUrl}">Open dashboard</a></p>`);
if (issuesUrl) htmlLines.push(`<p><a href="${issuesUrl}">Open perf issues</a></p>`);
const html = htmlLines.join('\n');

async function sendEmail() {
  const { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, SMTP_FROM, SMTP_SECURE, NOTIFY_EMAIL } = process.env;
  if (!SMTP_HOST || !SMTP_USER || !SMTP_PASS || !NOTIFY_EMAIL) {
    console.log('SMTP not fully configured. Skipping email.');
    return;
  }
  const transporter = nodemailer.createTransport({
    host: SMTP_HOST,
    port: Number(SMTP_PORT || 587),
    secure: SMTP_SECURE === 'true' || Number(SMTP_PORT) === 465,
    auth: { user: SMTP_USER, pass: SMTP_PASS },
  });
  try {
    const info = await transporter.sendMail({
      from: SMTP_FROM || SMTP_USER,
      to: NOTIFY_EMAIL,
      subject,
      text,
      html,
    });
    console.log(`Email sent: ${info.messageId}`);
  } catch (err) {
    console.error(`Email send failed: ${err.message}`);
    process.exitCode = 0; // do not fail the workflow because a side-channel failed
  }
}

async function sendSlack() {
  const url = process.env.SLACK_WEBHOOK_URL;
  if (!url) {
    console.log('SLACK_WEBHOOK_URL not set. Skipping Slack.');
    return;
  }
  const body = {
    text: subject,
    blocks: [
      { type: 'header', text: { type: 'plain_text', text: subject } },
      {
        type: 'section',
        text: { type: 'mrkdwn', text: `*${failCount}* fail, *${warnCount}* warn` },
      },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: regressions.slice(0, 15).map(formatLine).join('\n'),
        },
      },
      pagesUrl && {
        type: 'actions',
        elements: [
          { type: 'button', text: { type: 'plain_text', text: 'Dashboard' }, url: pagesUrl },
          issuesUrl && { type: 'button', text: { type: 'plain_text', text: 'Open issues' }, url: issuesUrl },
        ].filter(Boolean),
      },
    ].filter(Boolean),
  };
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${await res.text()}`);
    console.log('Slack notification sent.');
  } catch (err) {
    console.error(`Slack send failed: ${err.message}`);
  }
}

async function sendDiscord() {
  const url = process.env.DISCORD_WEBHOOK_URL;
  if (!url) {
    console.log('DISCORD_WEBHOOK_URL not set. Skipping Discord.');
    return;
  }
  const lines = [
    `**${subject}**`,
    `${failCount} fail, ${warnCount} warn`,
    '',
    ...regressions.slice(0, 15).map(formatLine),
  ];
  if (pagesUrl) lines.push('', `Dashboard: ${pagesUrl}`);
  const content = lines.join('\n').slice(0, 1900); // Discord 2000-char limit
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${await res.text()}`);
    console.log('Discord notification sent.');
  } catch (err) {
    console.error(`Discord send failed: ${err.message}`);
  }
}

await Promise.all([sendEmail(), sendSlack(), sendDiscord()]);
