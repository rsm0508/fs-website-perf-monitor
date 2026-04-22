// Builds a single static HTML dashboard from SQLite.
// Output: dashboard/index.html (plus per-URL pages at dashboard/url/<slug>.html).

import fs from 'node:fs';
import path from 'node:path';
import { getDb } from './utils/db.js';

const db = getDb();
const OUT_DIR = 'dashboard';
const URL_DIR = path.join(OUT_DIR, 'url');
fs.mkdirSync(URL_DIR, { recursive: true });

const now = new Date();
const H24 = new Date(now.getTime() - 24 * 3600 * 1000).toISOString();
const H30D = new Date(now.getTime() - 30 * 86400 * 1000).toISOString();

function slugify(url) {
  return url.replace(/https?:\/\//, '').replace(/[^a-z0-9]/gi, '_').slice(0, 120);
}

function esc(s) {
  if (s == null) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

const styles = `
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; margin: 0; padding: 24px; background: #fafafa; color: #222; }
  h1 { margin: 0 0 4px; }
  h2 { margin: 32px 0 12px; font-size: 20px; border-bottom: 1px solid #ddd; padding-bottom: 6px; }
  .muted { color: #666; font-size: 13px; }
  .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 16px; }
  .card { background: white; padding: 16px; border-radius: 8px; box-shadow: 0 1px 3px rgba(0,0,0,0.08); }
  .card h3 { margin: 0 0 8px; font-size: 14px; }
  .metric { font-size: 28px; font-weight: 600; }
  .metric.fail, .val.fail { color: #c0392b; font-weight: 600; }
  .metric.warn, .val.warn { color: #d35400; font-weight: 600; }
  .metric.ok,   .val.ok   { color: #27ae60; font-weight: 600; }
  table { width: 100%; border-collapse: collapse; background: white; border-radius: 8px; overflow: hidden; box-shadow: 0 1px 3px rgba(0,0,0,0.08); }
  th, td { padding: 8px 12px; text-align: left; border-bottom: 1px solid #eee; font-size: 13px; }
  th { background: #f0f0f0; }
  tr.url-group-start td { border-top: 2px solid #888; }
  tr.url-group-start.first td { border-top: none; }
  .badge { display: inline-block; padding: 2px 8px; border-radius: 4px; font-size: 11px; font-weight: 500; }
  .badge.tier0 { background: #e74c3c; color: white; }
  .badge.core { background: #3498db; color: white; }
  .badge.post { background: #95a5a6; color: white; }
  .badge.other { background: #bdc3c7; color: #333; }
  .badge.fail { background: #c0392b; color: white; }
  .badge.warn { background: #e67e22; color: white; }
  .badge.mobile { background: #9b59b6; color: white; }
  .badge.desktop { background: #16a085; color: white; }
  canvas { max-width: 100%; }
  a { color: #2980b9; }
  ul.bare { margin: 0; padding-left: 20px; color: #555; font-size: 13px; }
  ul.bare li { margin-bottom: 2px; }
  table.summary-stats th { text-align: center; }
  table.summary-stats td { text-align: center; font-size: 24px; font-weight: 600; padding: 12px; }
  .chart-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(380px, 1fr)); gap: 16px; margin-top: 12px; }
  .chart-panel { background: white; padding: 16px; border-radius: 8px; box-shadow: 0 1px 3px rgba(0,0,0,0.08); }
  .chart-panel h3 { margin: 0 0 8px; font-size: 14px; }
`;

function classAbove(value, threshold) {
  if (value == null) return '';
  return value > threshold ? 'fail' : value > threshold * 0.8 ? 'warn' : 'ok';
}
function classBelow(value, threshold) {
  if (value == null) return '';
  return value < threshold ? 'fail' : value < threshold * 1.2 ? 'warn' : 'ok';
}

function fmtMs(v) { return v != null ? Math.round(v) + 'ms' : '-'; }
function fmtCls(v) { return v != null ? v.toFixed(3) : '-'; }
function fmtScore(v) { return v != null ? String(v) : '-'; }
function shortUrl(url) { return url.replace('https://www.fullsession.io', '') || '/'; }

function renderPageHtml(title, body) {
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>${esc(title)}</title>
<style>${styles}</style>
<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/chartjs-adapter-date-fns@3/dist/chartjs-adapter-date-fns.bundle.min.js"></script>
</head><body>${body}</body></html>`;
}

const latestByDeviceStmt = db.prepare(`
  SELECT device, MAX(started_at) AS started_at, lcp_ms, tbt_ms, cls, performance_score
  FROM runs WHERE url = ? AND status = 'ok'
  GROUP BY device
`);

function medianOf(nums) {
  const sorted = nums.slice().sort((a, b) => a - b);
  if (!sorted.length) return null;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function medianScoreSeries(tier) {
  const since = new Date(now.getTime() - 180 * 86400 * 1000).toISOString();
  const rows = db.prepare(`
    SELECT date(r.started_at) AS day, r.device, r.performance_score
    FROM runs r
    JOIN urls u ON u.url = r.url
    WHERE r.started_at >= ?
      AND r.status = 'ok'
      AND u.tier = ?
      AND r.performance_score IS NOT NULL
  `).all(since, tier);

  // Bucket scores by day × device.
  const buckets = { mobile: new Map(), desktop: new Map() };
  for (const row of rows) {
    const dev = row.device;
    if (!buckets[dev]) continue;
    if (!buckets[dev].has(row.day)) buckets[dev].set(row.day, []);
    buckets[dev].get(row.day).push(row.performance_score);
  }
  const toSeries = (devMap) => Array.from(devMap.entries())
    .map(([day, scores]) => ({ x: day, y: medianOf(scores) }))
    .sort((a, b) => a.x.localeCompare(b.x));

  return {
    mobile: toSeries(buckets.mobile),
    desktop: toSeries(buckets.desktop),
  };
}

function renderMetricsTable(rows, opts = {}) {
  // rows: [{ url, tier, latest: [{device, started_at, ...}, ...] }]
  // Each URL contributes 1-2 table rows (one per device that has a run) or a single "no runs yet" row.
  if (!rows.length) return '<p class="muted">None.</p>';
  const includeTier = !!opts.includeTier;
  const colCount = (includeTier ? 1 : 0) + 7;
  const header = `
    <thead>
      <tr>
        ${includeTier ? '<th>Tier</th>' : ''}
        <th>URL</th>
        <th>Device</th>
        <th>Last run</th>
        <th>LCP</th>
        <th>TBT</th>
        <th>CLS</th>
        <th>Score</th>
      </tr>
    </thead>`;

  const body = rows.map((r, i) => {
    const devices = r.latest.length
      ? r.latest.slice().sort((a, b) => a.device.localeCompare(b.device))
      : [null];
    return devices.map((d, j) => {
      const groupClass = j === 0 ? `url-group-start${i === 0 ? ' first' : ''}` : '';
      if (!d) {
        return `
          <tr class="${groupClass}">
            ${includeTier ? `<td><span class="badge ${esc(r.tier)}">${esc(r.tier)}</span></td>` : ''}
            <td><a href="url/${slugify(r.url)}.html">${esc(shortUrl(r.url))}</a></td>
            <td colspan="${colCount - (includeTier ? 2 : 1)}" class="muted">No runs yet.</td>
          </tr>`;
      }
      const lcpCls = classAbove(d.lcp_ms, 4000);
      const tbtCls = classAbove(d.tbt_ms, 600);
      const clsCls = classAbove(d.cls, 0.25);
      const scoreCls = classBelow(d.performance_score, 40);
      return `
        <tr class="${groupClass}">
          ${includeTier ? `<td>${j === 0 ? `<span class="badge ${esc(r.tier)}">${esc(r.tier)}</span>` : ''}</td>` : ''}
          <td>${j === 0 ? `<a href="url/${slugify(r.url)}.html">${esc(shortUrl(r.url))}</a>` : ''}</td>
          <td><span class="badge ${esc(d.device)}">${esc(d.device)}</span></td>
          <td>${esc(d.started_at ? d.started_at.slice(0, 16) : '-')}</td>
          <td class="val ${lcpCls}">${fmtMs(d.lcp_ms)}</td>
          <td class="val ${tbtCls}">${fmtMs(d.tbt_ms)}</td>
          <td class="val ${clsCls}">${fmtCls(d.cls)}</td>
          <td class="val ${scoreCls}">${fmtScore(d.performance_score)}</td>
        </tr>`;
    }).join('');
  }).join('');

  return `<table>${header}<tbody>${body}</tbody></table>`;
}

function indexPage() {
  const urls = db.prepare(`SELECT url, tier FROM urls WHERE active = 1 ORDER BY tier DESC, url`).all();

  const urlsWithLatest = urls.map((u) => ({
    url: u.url,
    tier: u.tier,
    latest: latestByDeviceStmt.all(u.url),
  }));

  const tier0 = urlsWithLatest.filter((u) => u.tier === 'tier0');
  const core = urlsWithLatest.filter((u) => u.tier === 'core');
  const coreWithoutRuns = core.filter((u) => u.latest.length === 0);

  const runsIn24 = db.prepare(`SELECT COUNT(*) AS c FROM runs WHERE started_at >= ?`).get(H24).c;
  const failsIn24 = db.prepare(`
    SELECT COUNT(*) AS c FROM runs WHERE started_at >= ? AND status != 'ok'
  `).get(H24).c;
  const openRegressions = db.prepare(`
    SELECT COUNT(*) AS c FROM regressions WHERE cleared_at IS NULL
  `).get().c;

  const openTable = db.prepare(`
    SELECT r.url, r.device, r.metric, r.current_value, r.baseline_value, r.pct_delta, r.severity, r.detected_at, r.gh_issue
    FROM regressions r WHERE r.cleared_at IS NULL
    ORDER BY r.detected_at DESC LIMIT 50
  `).all();

  const coreSeries = medianScoreSeries('core');
  const postSeries = medianScoreSeries('post');

  const body = `
    <h1>FullSession performance</h1>
    <p class="muted">Generated ${now.toISOString()} &middot; ${urls.length} active URLs tracked</p>

    <table class="summary-stats" style="margin-top: 16px">
      <thead>
        <tr>
          <th>Runs (last 24h)</th>
          <th>Failed runs (24h)</th>
          <th>Open regressions</th>
        </tr>
      </thead>
      <tbody>
        <tr>
          <td class="val ok">${runsIn24}</td>
          <td class="val ${failsIn24 ? 'fail' : 'ok'}">${failsIn24}</td>
          <td class="val ${openRegressions ? 'fail' : 'ok'}">${openRegressions}</td>
        </tr>
      </tbody>
    </table>

    <h2>Median performance score (last 6 months)</h2>
    <div class="chart-grid">
      <div class="chart-panel">
        <h3>Core pages</h3>
        <canvas id="coreScoreChart" height="90"></canvas>
      </div>
      <div class="chart-panel">
        <h3>Blog posts</h3>
        <canvas id="postScoreChart" height="90"></canvas>
      </div>
    </div>

    <h2>Tier 0</h2>
    ${renderMetricsTable(tier0)}

    <h2>Open regressions (${openTable.length})</h2>
    ${openTable.length ? `<table>
      <thead><tr><th>When</th><th>URL</th><th>Device</th><th>Metric</th><th>Current</th><th>Baseline</th><th>Δ%</th><th>Severity</th><th>Issue</th></tr></thead>
      <tbody>
        ${openTable.map((r) => `
          <tr>
            <td>${esc(r.detected_at.slice(0, 16))}</td>
            <td><a href="url/${slugify(r.url)}.html">${esc(shortUrl(r.url))}</a></td>
            <td><span class="badge ${esc(r.device)}">${esc(r.device)}</span></td>
            <td>${esc(r.metric)}</td>
            <td>${r.current_value != null ? (r.current_value >= 1 ? Math.round(r.current_value) : r.current_value.toFixed(3)) : '-'}</td>
            <td>${r.baseline_value != null ? (r.baseline_value >= 1 ? Math.round(r.baseline_value) : r.baseline_value.toFixed(3)) : '-'}</td>
            <td>${r.pct_delta != null ? (r.pct_delta * 100).toFixed(1) + '%' : '-'}</td>
            <td><span class="badge ${esc(r.severity)}">${esc(r.severity)}</span></td>
            <td>${r.gh_issue ? `#${r.gh_issue}` : '-'}</td>
          </tr>`).join('')}
      </tbody>
    </table>` : '<p class="muted">None. Nice.</p>'}

    <h2>Core pages without runs (${coreWithoutRuns.length})</h2>
    ${coreWithoutRuns.length ? `<ul class="bare">
      ${coreWithoutRuns.map((u) => `<li><a href="url/${slugify(u.url)}.html">${esc(shortUrl(u.url))}</a></li>`).join('')}
    </ul>` : '<p class="muted">All core pages have at least one run.</p>'}

    <h2>All monitored URLs (${urlsWithLatest.length})</h2>
    ${renderMetricsTable(urlsWithLatest, { includeTier: true })}

    <script>
      const coreSeries = ${JSON.stringify(coreSeries)};
      const postSeries = ${JSON.stringify(postSeries)};
      function scoreChart(ctxId, series) {
        const ctx = document.getElementById(ctxId);
        if (!ctx) return;
        new Chart(ctx, {
          type: 'line',
          data: {
            datasets: [
              { label: 'mobile',  data: series.mobile,  borderColor: '#9b59b6', tension: 0.1 },
              { label: 'desktop', data: series.desktop, borderColor: '#16a085', tension: 0.1 },
            ]
          },
          options: {
            scales: {
              x: { type: 'time', time: { unit: 'day' } },
              y: { min: 0, max: 100, title: { display: true, text: 'Median perf score' } }
            },
            spanGaps: true
          }
        });
      }
      scoreChart('coreScoreChart', coreSeries);
      scoreChart('postScoreChart', postSeries);
    </script>
  `;
  fs.writeFileSync(path.join(OUT_DIR, 'index.html'), renderPageHtml('FullSession performance', body));
  console.log(`Wrote ${OUT_DIR}/index.html`);
}

function urlPages() {
  const urls = db.prepare(`SELECT url, tier FROM urls WHERE active = 1`).all();
  const runsStmt = db.prepare(`
    SELECT started_at, device, lcp_ms, tbt_ms, cls, ttfb_ms, performance_score, screenshot_path, report_path
    FROM runs
    WHERE url = ? AND started_at >= ? AND status = 'ok'
    ORDER BY started_at ASC
  `);

  for (const u of urls) {
    const runs = runsStmt.all(u.url, H30D);
    const slug = slugify(u.url);

    const body = `
      <h1><a href="../index.html">&larr;</a> ${esc(u.url)}</h1>
      <p class="muted">Tier: <span class="badge ${esc(u.tier)}">${esc(u.tier)}</span> &middot; ${runs.length} runs in last 30 days</p>
      ${runs.length === 0 ? '<p class="muted">No successful runs in the last 30 days.</p>' : `
      <h2>LCP (ms)</h2><canvas id="lcp" height="80"></canvas>
      <h2>TBT (ms)</h2><canvas id="tbt" height="80"></canvas>
      <h2>CLS</h2><canvas id="cls" height="80"></canvas>
      <h2>Performance score</h2><canvas id="score" height="80"></canvas>
      <h2>Recent runs</h2>
      <table>
        <thead><tr><th>When</th><th>Device</th><th>LCP</th><th>TBT</th><th>CLS</th><th>Score</th><th>Report</th><th>Screenshot</th></tr></thead>
        <tbody>
          ${runs.slice(-30).reverse().map((r) => `
            <tr>
              <td>${esc(r.started_at.slice(0, 16))}</td>
              <td><span class="badge ${esc(r.device)}">${esc(r.device)}</span></td>
              <td class="val ${classAbove(r.lcp_ms, 4000)}">${fmtMs(r.lcp_ms)}</td>
              <td class="val ${classAbove(r.tbt_ms, 600)}">${fmtMs(r.tbt_ms)}</td>
              <td class="val ${classAbove(r.cls, 0.25)}">${fmtCls(r.cls)}</td>
              <td class="val ${classBelow(r.performance_score, 40)}">${fmtScore(r.performance_score)}</td>
              <td>${r.report_path ? `<a href="../../${esc(r.report_path)}">html</a>` : '-'}</td>
              <td>${r.screenshot_path ? `<a href="../../${esc(r.screenshot_path)}">png</a>` : '-'}</td>
            </tr>`).join('')}
        </tbody>
      </table>
      <script>
        const mobile = ${JSON.stringify(runs.filter((r) => r.device === 'mobile'))};
        const desktop = ${JSON.stringify(runs.filter((r) => r.device === 'desktop'))};
        function chart(ctxId, metric) {
          const ctx = document.getElementById(ctxId);
          if (!ctx) return;
          new Chart(ctx, {
            type: 'line',
            data: {
              datasets: [
                { label: 'mobile', data: mobile.map(r => ({ x: r.started_at, y: r[metric] })), borderColor: '#9b59b6', tension: 0.1 },
                { label: 'desktop', data: desktop.map(r => ({ x: r.started_at, y: r[metric] })), borderColor: '#16a085', tension: 0.1 },
              ]
            },
            options: { scales: { x: { type: 'time', time: { unit: 'day' } } }, spanGaps: true }
          });
        }
        chart('lcp', 'lcp_ms');
        chart('tbt', 'tbt_ms');
        chart('cls', 'cls');
        chart('score', 'performance_score');
      </script>
      `}
    `;
    fs.writeFileSync(path.join(URL_DIR, `${slug}.html`), renderPageHtml(u.url, body));
  }
  console.log(`Wrote ${urls.length} per-URL pages.`);
}

indexPage();
urlPages();
