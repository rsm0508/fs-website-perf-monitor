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
  .metric.fail { color: #c0392b; }
  .metric.warn { color: #d35400; }
  .metric.ok   { color: #27ae60; }
  .metric-row { display: flex; gap: 16px; margin-top: 8px; }
  .metric-row div { flex: 1; }
  .metric-row label { font-size: 11px; color: #888; text-transform: uppercase; display: block; }
  table { width: 100%; border-collapse: collapse; background: white; border-radius: 8px; overflow: hidden; box-shadow: 0 1px 3px rgba(0,0,0,0.08); }
  th, td { padding: 8px 12px; text-align: left; border-bottom: 1px solid #eee; font-size: 13px; }
  th { background: #f0f0f0; cursor: pointer; user-select: none; }
  .badge { display: inline-block; padding: 2px 8px; border-radius: 4px; font-size: 11px; font-weight: 500; }
  .badge.tier0 { background: #e74c3c; color: white; }
  .badge.core { background: #3498db; color: white; }
  .badge.post { background: #95a5a6; color: white; }
  .badge.other { background: #bdc3c7; color: #333; }
  .badge.fail { background: #c0392b; color: white; }
  .badge.warn { background: #e67e22; color: white; }
  canvas { max-width: 100%; }
  a { color: #2980b9; }
`;

function cssClassForMetric(value, threshold, kind = 'above') {
  if (value == null) return '';
  if (kind === 'above') return value > threshold ? 'fail' : value > threshold * 0.8 ? 'warn' : 'ok';
  return value < threshold ? 'fail' : value < threshold * 1.2 ? 'warn' : 'ok';
}

function renderCard(url, latest) {
  if (!latest) return `<div class="card"><h3>${esc(url)}</h3><p class="muted">No runs yet.</p></div>`;
  const slug = slugify(url);
  const lcpClass = cssClassForMetric(latest.lcp_ms, 4000);
  const tbtClass = cssClassForMetric(latest.tbt_ms, 600);
  const clsClass = cssClassForMetric(latest.cls, 0.25);
  const scoreClass = cssClassForMetric(latest.performance_score, 40, 'below');
  return `
    <div class="card">
      <h3><a href="url/${slug}.html">${esc(url.replace('https://www.fullsession.io', ''))}</a></h3>
      <div class="muted">${esc(latest.device)} &middot; ${esc(latest.started_at.slice(0, 16))}</div>
      <div class="metric-row">
        <div><label>LCP</label><div class="metric ${lcpClass}">${Math.round(latest.lcp_ms || 0)}<span style="font-size:14px">ms</span></div></div>
        <div><label>TBT</label><div class="metric ${tbtClass}">${Math.round(latest.tbt_ms || 0)}<span style="font-size:14px">ms</span></div></div>
      </div>
      <div class="metric-row">
        <div><label>CLS</label><div class="metric ${clsClass}">${(latest.cls || 0).toFixed(3)}</div></div>
        <div><label>Score</label><div class="metric ${scoreClass}">${latest.performance_score ?? '-'}</div></div>
      </div>
    </div>`;
}

function renderPageHtml(title, body) {
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>${esc(title)}</title>
<style>${styles}</style>
<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.min.js"></script>
</head><body>${body}</body></html>`;
}

function indexPage() {
  const urls = db.prepare(`SELECT url, tier FROM urls WHERE active = 1 ORDER BY tier DESC, url`).all();

  const latestStmt = db.prepare(`
    SELECT * FROM runs WHERE url = ? AND status = 'ok' ORDER BY started_at DESC LIMIT 1
  `);

  const tier0 = urls.filter((u) => u.tier === 'tier0');
  const core = urls.filter((u) => u.tier === 'core');
  const posts = urls.filter((u) => u.tier === 'post');

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

  const allUrlsStmt = db.prepare(`
    SELECT urls.url, urls.tier, r.started_at, r.device, r.lcp_ms, r.tbt_ms, r.cls, r.performance_score
    FROM urls
    LEFT JOIN (
      SELECT url, MAX(started_at) AS started_at FROM runs WHERE status = 'ok' GROUP BY url
    ) latest ON latest.url = urls.url
    LEFT JOIN runs r ON r.url = urls.url AND r.started_at = latest.started_at
    WHERE urls.active = 1
    ORDER BY urls.tier DESC, urls.url
  `);
  const allUrls = allUrlsStmt.all();

  const body = `
    <h1>FullSession performance</h1>
    <p class="muted">Generated ${now.toISOString()} &middot; ${urls.length} active URLs tracked</p>

    <div class="grid" style="margin-top: 16px">
      <div class="card"><h3>Runs (last 24h)</h3><div class="metric ok">${runsIn24}</div></div>
      <div class="card"><h3>Failed runs (24h)</h3><div class="metric ${failsIn24 ? 'fail' : 'ok'}">${failsIn24}</div></div>
      <div class="card"><h3>Open regressions</h3><div class="metric ${openRegressions ? 'fail' : 'ok'}">${openRegressions}</div></div>
    </div>

    <h2>Tier 0</h2>
    <div class="grid">
      ${tier0.map((u) => renderCard(u.url, latestStmt.get(u.url))).join('')}
    </div>

    <h2>Open regressions (${openTable.length})</h2>
    ${openTable.length ? `<table>
      <thead><tr><th>When</th><th>URL</th><th>Device</th><th>Metric</th><th>Current</th><th>Baseline</th><th>Δ%</th><th>Severity</th><th>Issue</th></tr></thead>
      <tbody>
        ${openTable.map((r) => `
          <tr>
            <td>${esc(r.detected_at.slice(0, 16))}</td>
            <td><a href="url/${slugify(r.url)}.html">${esc(r.url.replace('https://www.fullsession.io', ''))}</a></td>
            <td>${esc(r.device)}</td>
            <td>${esc(r.metric)}</td>
            <td>${r.current_value != null ? (r.current_value >= 1 ? Math.round(r.current_value) : r.current_value.toFixed(3)) : '-'}</td>
            <td>${r.baseline_value != null ? (r.baseline_value >= 1 ? Math.round(r.baseline_value) : r.baseline_value.toFixed(3)) : '-'}</td>
            <td>${r.pct_delta != null ? (r.pct_delta * 100).toFixed(1) + '%' : '-'}</td>
            <td><span class="badge ${esc(r.severity)}">${esc(r.severity)}</span></td>
            <td>${r.gh_issue ? `#${r.gh_issue}` : '-'}</td>
          </tr>`).join('')}
      </tbody>
    </table>` : '<p class="muted">None. Nice.</p>'}

    <h2>Core pages (${core.length})</h2>
    <div class="grid">
      ${core.slice(0, 20).map((u) => renderCard(u.url, latestStmt.get(u.url))).join('')}
    </div>

    <h2>All monitored URLs (${allUrls.length})</h2>
    <table>
      <thead><tr><th>Tier</th><th>URL</th><th>Last run</th><th>Device</th><th>LCP</th><th>TBT</th><th>CLS</th><th>Score</th></tr></thead>
      <tbody>
        ${allUrls.map((u) => `
          <tr>
            <td><span class="badge ${esc(u.tier)}">${esc(u.tier)}</span></td>
            <td><a href="url/${slugify(u.url)}.html">${esc(u.url.replace('https://www.fullsession.io', ''))}</a></td>
            <td>${esc(u.started_at?.slice(0, 16) || '-')}</td>
            <td>${esc(u.device || '-')}</td>
            <td>${u.lcp_ms != null ? Math.round(u.lcp_ms) + 'ms' : '-'}</td>
            <td>${u.tbt_ms != null ? Math.round(u.tbt_ms) + 'ms' : '-'}</td>
            <td>${u.cls != null ? u.cls.toFixed(3) : '-'}</td>
            <td>${u.performance_score ?? '-'}</td>
          </tr>`).join('')}
      </tbody>
    </table>
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

    const series = (metric) => runs.map((r) => ({ x: r.started_at, y: r[metric], device: r.device }));
    const body = `
      <h1><a href="../index.html">&larr;</a> ${esc(u.url)}</h1>
      <p class="muted">Tier: <span class="badge ${esc(u.tier)}">${esc(u.tier)}</span> &middot; ${runs.length} runs in last 30 days</p>
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
              <td>${esc(r.device)}</td>
              <td>${r.lcp_ms != null ? Math.round(r.lcp_ms) + 'ms' : '-'}</td>
              <td>${r.tbt_ms != null ? Math.round(r.tbt_ms) + 'ms' : '-'}</td>
              <td>${r.cls != null ? r.cls.toFixed(3) : '-'}</td>
              <td>${r.performance_score ?? '-'}</td>
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
                { label: 'mobile', data: mobile.map(r => ({ x: r.started_at, y: r[metric] })), borderColor: '#3498db', tension: 0.1 },
                { label: 'desktop', data: desktop.map(r => ({ x: r.started_at, y: r[metric] })), borderColor: '#e67e22', tension: 0.1 },
              ]
            },
            options: { scales: { x: { type: 'time', time: { unit: 'day' } } }, parsing: false, spanGaps: true }
          });
        }
        chart('lcp', 'lcp_ms');
        chart('tbt', 'tbt_ms');
        chart('cls', 'cls');
        chart('score', 'performance_score');
      </script>
      <script src="https://cdn.jsdelivr.net/npm/chartjs-adapter-date-fns@3/dist/chartjs-adapter-date-fns.bundle.min.js"></script>
    `;
    fs.writeFileSync(path.join(URL_DIR, `${slug}.html`), renderPageHtml(u.url, body));
  }
  console.log(`Wrote ${urls.length} per-URL pages.`);
}

indexPage();
urlPages();
