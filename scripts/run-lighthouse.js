// Runs Lighthouse against one URL with warmup, writes metrics and report/screenshot.
// Usage: node scripts/run-lighthouse.js --url <url> --device <mobile|desktop> [--retest]
// Can also read newline-separated "url\tdevice" lines from stdin (for workflow batching).

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import lighthouse from 'lighthouse';
import * as chromeLauncher from 'chrome-launcher';
import sharp from 'sharp';
import { getDb } from './utils/db.js';
import {
  CHROME_FLAGS,
  LH_DEVICE_CONFIG,
  SCREENSHOTS_DIR,
  LH_REPORTS_DIR,
} from './config.js';

const args = process.argv.slice(2);
function getArg(name) {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : null;
}
const hasFlag = (name) => args.includes(`--${name}`);
const GH_RUN_ID = process.env.GITHUB_RUN_ID || null;
const IS_RETEST = hasFlag('retest');

fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });
fs.mkdirSync(LH_REPORTS_DIR, { recursive: true });

function safeSlug(url) {
  return url.replace(/https?:\/\//, '').replace(/[^a-z0-9]/gi, '_').slice(0, 120);
}

async function warmup(url) {
  // Simple GET to warm origin + CDN. Ignore errors, they will surface in the LH run.
  try {
    await fetch(url, { redirect: 'follow', headers: { 'User-Agent': 'perf-monitor-warmup' } });
  } catch (_) {
    // intentional: warmup failures are non-fatal
  }
}

function extractMetrics(lhr) {
  const audits = lhr.audits || {};
  const metrics = audits['metrics']?.details?.items?.[0] || {};
  const byteWeight = audits['total-byte-weight']?.numericValue ?? null;
  const requestCount = audits['network-requests']?.details?.items?.length ?? null;
  const speedIndex = audits['speed-index']?.numericValue ?? null;

  // Top resources: pull from network-requests, sort by transferSize.
  const networkItems = audits['network-requests']?.details?.items || [];
  const topResources = [...networkItems]
    .sort((a, b) => (b.transferSize || 0) - (a.transferSize || 0))
    .slice(0, 10)
    .map((r) => ({
      url: r.url,
      resourceType: r.resourceType,
      transferSize: r.transferSize,
      startTime: r.startTime,
      endTime: r.endTime,
      statusCode: r.statusCode,
    }));

  return {
    lcp_ms: metrics.largestContentfulPaint ?? audits['largest-contentful-paint']?.numericValue ?? null,
    fcp_ms: metrics.firstContentfulPaint ?? audits['first-contentful-paint']?.numericValue ?? null,
    tbt_ms: metrics.totalBlockingTime ?? audits['total-blocking-time']?.numericValue ?? null,
    cls: metrics.cumulativeLayoutShift ?? audits['cumulative-layout-shift']?.numericValue ?? null,
    ttfb_ms: audits['server-response-time']?.numericValue ?? metrics.observedTimeOriginTs ?? null,
    speed_index_ms: speedIndex,
    total_byte_weight: byteWeight ? Math.round(byteWeight) : null,
    request_count: requestCount,
    performance_score: lhr.categories?.performance?.score != null
      ? Math.round(lhr.categories.performance.score * 100)
      : null,
    top_resources: topResources,
  };
}

function extractConsoleErrors(lhr) {
  const items = lhr.audits?.['errors-in-console']?.details?.items || [];
  return items
    .filter((i) => i.source === 'console.error' || i.level === 'error')
    .map((i) => i.description || i.source);
}

async function runOne(url, device) {
  const db = getDb();
  const startedAt = new Date().toISOString();
  const slug = safeSlug(url);
  const stamp = startedAt.replace(/[:.]/g, '-');
  const reportPath = path.join(LH_REPORTS_DIR, `${slug}__${device}__${stamp}.html`);
  const screenshotPath = path.join(SCREENSHOTS_DIR, `${slug}__${device}__${stamp}.jpg`);

  let chrome;
  const insert = db.prepare(`
    INSERT INTO runs (
      url, gh_run_id, device, started_at, finished_at, status, error_message,
      lcp_ms, fcp_ms, tbt_ms, cls, ttfb_ms, speed_index_ms,
      total_byte_weight, request_count, performance_score,
      screenshot_path, report_path, console_errors, console_errors_json,
      top_resources_json, is_retest
    ) VALUES (
      @url, @gh_run_id, @device, @started_at, @finished_at, @status, @error_message,
      @lcp_ms, @fcp_ms, @tbt_ms, @cls, @ttfb_ms, @speed_index_ms,
      @total_byte_weight, @request_count, @performance_score,
      @screenshot_path, @report_path, @console_errors, @console_errors_json,
      @top_resources_json, @is_retest
    )
  `);
  const updateUrl = db.prepare(`UPDATE urls SET last_checked = ? WHERE url = ?`);
  const markQueueProcessed = db.prepare(`
    UPDATE queue SET processed_at = ?
    WHERE url = ? AND device = ? AND processed_at IS NULL
  `);

  try {
    await warmup(url);

    chrome = await chromeLauncher.launch({ chromeFlags: CHROME_FLAGS });
    const config = LH_DEVICE_CONFIG[device];
    const flags = {
      port: chrome.port,
      logLevel: 'error',
      output: ['html'],
    };
    const result = await lighthouse(url, flags, config);
    if (!result || !result.lhr) {
      throw new Error('Lighthouse returned no result');
    }
    const { lhr, report } = result;
    const htmlReport = Array.isArray(report) ? report[0] : report;
    fs.writeFileSync(reportPath, htmlReport, 'utf8');

    // Extract and save the final screenshot (base64 in lhr.audits['final-screenshot'].details.data).
    const ss = lhr.audits?.['final-screenshot']?.details?.data;
    if (ss && ss.startsWith('data:image/')) {
      const base64 = ss.split(',')[1];
      const buf = Buffer.from(base64, 'base64');
      await sharp(buf).jpeg({ quality: 70 }).toFile(screenshotPath);
    }

    const metrics = extractMetrics(lhr);
    const consoleErrors = extractConsoleErrors(lhr);

    insert.run({
      url,
      gh_run_id: GH_RUN_ID,
      device,
      started_at: startedAt,
      finished_at: new Date().toISOString(),
      status: 'ok',
      error_message: null,
      lcp_ms: metrics.lcp_ms,
      fcp_ms: metrics.fcp_ms,
      tbt_ms: metrics.tbt_ms,
      cls: metrics.cls,
      ttfb_ms: metrics.ttfb_ms,
      speed_index_ms: metrics.speed_index_ms,
      total_byte_weight: metrics.total_byte_weight,
      request_count: metrics.request_count,
      performance_score: metrics.performance_score,
      screenshot_path: fs.existsSync(screenshotPath) ? screenshotPath : null,
      report_path: reportPath,
      console_errors: consoleErrors.length,
      console_errors_json: consoleErrors.length ? JSON.stringify(consoleErrors) : null,
      top_resources_json: JSON.stringify(metrics.top_resources),
      is_retest: IS_RETEST ? 1 : 0,
    });
    updateUrl.run(new Date().toISOString(), url);
    markQueueProcessed.run(new Date().toISOString(), url, device);

    console.log(`OK   ${device.padEnd(7)} ${url}  LCP=${Math.round(metrics.lcp_ms)}ms TBT=${Math.round(metrics.tbt_ms)}ms CLS=${metrics.cls?.toFixed(3)} score=${metrics.performance_score}`);
  } catch (err) {
    insert.run({
      url,
      gh_run_id: GH_RUN_ID,
      device,
      started_at: startedAt,
      finished_at: new Date().toISOString(),
      status: 'error',
      error_message: err.message?.slice(0, 500) || String(err),
      lcp_ms: null, fcp_ms: null, tbt_ms: null, cls: null, ttfb_ms: null,
      speed_index_ms: null, total_byte_weight: null, request_count: null, performance_score: null,
      screenshot_path: null, report_path: null,
      console_errors: 0, console_errors_json: null, top_resources_json: null,
      is_retest: IS_RETEST ? 1 : 0,
    });
    console.error(`FAIL ${device.padEnd(7)} ${url}  ${err.message}`);
  } finally {
    if (chrome) await chrome.kill();
  }
}

async function main() {
  const singleUrl = getArg('url');
  const singleDevice = getArg('device');

  if (singleUrl && singleDevice) {
    await runOne(singleUrl, singleDevice);
    return;
  }

  // Read from stdin: one "url\tdevice" per line.
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const input = Buffer.concat(chunks).toString('utf8').trim();
  if (!input) {
    console.log('No URLs to run.');
    return;
  }
  const lines = input.split('\n').map((l) => l.trim()).filter(Boolean);
  for (const line of lines) {
    const [url, device] = line.split('\t');
    if (!url || !device) continue;
    await runOne(url, device);
  }
}

main().catch((err) => {
  console.error('Runner crashed:', err);
  process.exit(1);
});
