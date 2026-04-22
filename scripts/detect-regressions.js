// Scans recent runs, flags absolute and relative regressions, queues retests,
// opens GitHub Issues via the gh CLI (available in Actions), and writes a
// human-readable summary to regressions-summary.md.
//
// Designed to be idempotent: if a regression is already open for the same url+metric
// within the last 48h, it adds a comment instead of creating a duplicate.

import fs from 'node:fs';
import { execSync } from 'node:child_process';
import { getDb } from './utils/db.js';
import {
  ABSOLUTE_THRESHOLDS,
  DESKTOP_MULTIPLIER,
  RELATIVE_METRICS,
  PCT_WORSE_THRESHOLD,
  MIN_HISTORY_FOR_RELATIVE,
  BASELINE_WINDOW_DAYS,
  BASELINE_SAMPLE_SIZE,
} from './config.js';

const GH_REPO = process.env.GITHUB_REPOSITORY;
const CAN_OPEN_ISSUES = !!GH_REPO && process.env.CI === 'true';

const db = getDb();
const now = new Date();

function thresholdFor(metric, device) {
  const base = ABSOLUTE_THRESHOLDS[metric];
  if (base == null) return null;
  if (device === 'desktop' && DESKTOP_MULTIPLIER[metric] != null) {
    return base * DESKTOP_MULTIPLIER[metric];
  }
  return base;
}

function isAbsoluteFail(run) {
  const failures = [];
  for (const metric of ['lcp_ms', 'cls', 'tbt_ms', 'ttfb_ms']) {
    const v = run[metric];
    if (v == null) continue;
    const threshold = thresholdFor(metric, run.device);
    if (v > threshold) failures.push({ metric, current: v, threshold });
  }
  if (run.performance_score != null) {
    const threshold = thresholdFor('performance_score', run.device);
    if (run.performance_score < threshold) {
      failures.push({ metric: 'performance_score', current: run.performance_score, threshold });
    }
  }
  return failures;
}

function baselineFor(url, device, excludeRunId) {
  const windowStart = new Date(now.getTime() - BASELINE_WINDOW_DAYS * 86400 * 1000).toISOString();
  const rows = db.prepare(`
    SELECT lcp_ms, tbt_ms, cls, total_byte_weight FROM runs
    WHERE url = ? AND device = ? AND status = 'ok' AND id != ?
      AND started_at >= ?
    ORDER BY started_at DESC
    LIMIT ?
  `).all(url, device, excludeRunId, windowStart, BASELINE_SAMPLE_SIZE);
  if (rows.length < MIN_HISTORY_FOR_RELATIVE) return null;

  function median(values) {
    const nums = values.filter((v) => v != null).sort((a, b) => a - b);
    if (!nums.length) return null;
    const mid = Math.floor(nums.length / 2);
    return nums.length % 2 ? nums[mid] : (nums[mid - 1] + nums[mid]) / 2;
  }

  return {
    lcp_ms: median(rows.map((r) => r.lcp_ms)),
    tbt_ms: median(rows.map((r) => r.tbt_ms)),
    cls: median(rows.map((r) => r.cls)),
    total_byte_weight: median(rows.map((r) => r.total_byte_weight)),
    sample_size: rows.length,
  };
}

function relativeRegressions(run) {
  const baseline = baselineFor(run.url, run.device, run.id);
  if (!baseline) return [];
  const out = [];
  for (const metric of RELATIVE_METRICS) {
    const curr = run[metric];
    const base = baseline[metric];
    if (curr == null || base == null || base === 0) continue;
    const pctDelta = (curr - base) / base;
    if (pctDelta > PCT_WORSE_THRESHOLD) {
      out.push({ metric, current: curr, baseline: base, pct_delta: pctDelta });
    }
  }
  return out;
}

function consoleRegression(run) {
  const prior = db.prepare(`
    SELECT console_errors FROM runs
    WHERE url = ? AND device = ? AND status = 'ok' AND id < ?
    ORDER BY started_at DESC
    LIMIT 1
  `).get(run.url, run.device, run.id);
  if (!prior) return null;
  if ((run.console_errors || 0) > (prior.console_errors || 0)) {
    return { prior_count: prior.console_errors || 0, current_count: run.console_errors };
  }
  return null;
}

function hasOpenRegression(url, metric) {
  const cutoff = new Date(now.getTime() - 48 * 3600 * 1000).toISOString();
  const row = db.prepare(`
    SELECT id, gh_issue FROM regressions
    WHERE url = ? AND metric = ? AND cleared_at IS NULL AND detected_at >= ?
    ORDER BY detected_at DESC LIMIT 1
  `).get(url, metric, cutoff);
  return row || null;
}

function recordRegression(run, metric, kind, current, baseline, pctDelta, severity) {
  const existing = hasOpenRegression(run.url, metric);
  const insert = db.prepare(`
    INSERT INTO regressions (run_id, url, device, metric, current_value, baseline_value, pct_delta, severity, kind, detected_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const result = insert.run(
    run.id, run.url, run.device, metric,
    current, baseline, pctDelta, severity, kind,
    new Date().toISOString(),
  );
  return { id: result.lastInsertRowid, existing };
}

function queueRetest(url, device, isTier0) {
  const exists = db.prepare(`
    SELECT 1 FROM queue WHERE url = ? AND reason = 'flagged' AND processed_at IS NULL
  `).get(url);
  if (exists) return;
  const dev = isTier0 ? device : 'mobile';
  db.prepare(`
    INSERT INTO queue (url, reason, device, runs_required, enqueued_at)
    VALUES (?, 'flagged', ?, 3, ?)
  `).run(url, dev, new Date().toISOString());
}

function openIssue(title, body, labels) {
  if (!CAN_OPEN_ISSUES) {
    console.log(`[DRY RUN] Would open issue: ${title}`);
    return null;
  }
  try {
    const labelArgs = labels.map((l) => `--label ${JSON.stringify(l)}`).join(' ');
    const cmd = `gh issue create --title ${JSON.stringify(title)} --body ${JSON.stringify(body)} ${labelArgs}`;
    const out = execSync(cmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    const match = out.match(/\/issues\/(\d+)/);
    return match ? Number(match[1]) : null;
  } catch (err) {
    console.error('Failed to open issue:', err.message);
    return null;
  }
}

function commentIssue(issueNumber, body) {
  if (!CAN_OPEN_ISSUES || !issueNumber) return;
  try {
    execSync(`gh issue comment ${issueNumber} --body ${JSON.stringify(body)}`, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (err) {
    console.error('Failed to comment on issue:', err.message);
  }
}

function formatBody(run, reasons, baseline) {
  const lines = [
    `**URL:** ${run.url}`,
    `**Device:** ${run.device}`,
    `**Run started:** ${run.started_at}`,
    `**GH run:** ${run.gh_run_id || 'n/a'}`,
    '',
    '**Metrics this run:**',
    `- LCP: ${run.lcp_ms != null ? Math.round(run.lcp_ms) + 'ms' : 'n/a'}`,
    `- TBT: ${run.tbt_ms != null ? Math.round(run.tbt_ms) + 'ms' : 'n/a'}`,
    `- CLS: ${run.cls != null ? run.cls.toFixed(3) : 'n/a'}`,
    `- TTFB: ${run.ttfb_ms != null ? Math.round(run.ttfb_ms) + 'ms' : 'n/a'}`,
    `- Perf score: ${run.performance_score ?? 'n/a'}`,
    `- Total bytes: ${run.total_byte_weight ?? 'n/a'}`,
    '',
    '**Why this was flagged:**',
    ...reasons.map((r) => `- ${r}`),
  ];
  if (baseline) {
    lines.push('', '**Baseline (rolling median):**');
    if (baseline.lcp_ms != null) lines.push(`- LCP baseline: ${Math.round(baseline.lcp_ms)}ms`);
    if (baseline.tbt_ms != null) lines.push(`- TBT baseline: ${Math.round(baseline.tbt_ms)}ms`);
    if (baseline.cls != null) lines.push(`- CLS baseline: ${baseline.cls.toFixed(3)}`);
    lines.push(`- Sample size: ${baseline.sample_size}`);
  }
  if (run.report_path) lines.push('', `**Report:** \`${run.report_path}\``);
  if (run.screenshot_path) lines.push(`**Screenshot:** \`${run.screenshot_path}\``);
  lines.push('', '_Retest queued for 24h with median-of-3._');
  return lines.join('\n');
}

function run() {
  // Runs from this workflow invocation's monitor step only (last 2h, not already regressed).
  const cutoff = new Date(now.getTime() - 2 * 3600 * 1000).toISOString();
  const newRuns = db.prepare(`
    SELECT * FROM runs
    WHERE status = 'ok' AND started_at >= ?
      AND id NOT IN (SELECT run_id FROM regressions)
    ORDER BY started_at ASC
  `).all(cutoff);

  console.log(`Checking ${newRuns.length} recent runs.`);

  const summary = [];
  let flagCount = 0;

  for (const runRow of newRuns) {
    const absoluteFails = isAbsoluteFail(runRow);
    const relativeFails = relativeRegressions(runRow);
    const consoleFail = consoleRegression(runRow);
    if (!absoluteFails.length && !relativeFails.length && !consoleFail) continue;

    const tier = db.prepare(`SELECT tier FROM urls WHERE url = ?`).get(runRow.url)?.tier;
    const isTier0 = tier === 'tier0';
    const reasons = [];

    for (const f of absoluteFails) {
      reasons.push(`Absolute: ${f.metric} = ${typeof f.current === 'number' ? f.current.toFixed(2) : f.current} exceeds threshold ${f.threshold}`);
      recordRegression(runRow, f.metric, 'absolute', f.current, null, null, 'fail');
    }
    for (const f of relativeFails) {
      reasons.push(`Relative: ${f.metric} current ${f.current?.toFixed(2)} vs baseline ${f.baseline?.toFixed(2)} (+${(f.pct_delta * 100).toFixed(1)}%)`);
      recordRegression(runRow, f.metric, 'relative', f.current, f.baseline, f.pct_delta, 'warn');
    }
    if (consoleFail) {
      reasons.push(`Console errors rose from ${consoleFail.prior_count} to ${consoleFail.current_count}`);
      recordRegression(runRow, 'console_errors', 'console', consoleFail.current_count, consoleFail.prior_count, null, 'warn');
    }

    queueRetest(runRow.url, runRow.device, isTier0);
    flagCount++;

    const severity = absoluteFails.length ? 'fail' : 'regression';
    const labelMain = absoluteFails.length ? 'perf:fail' : 'perf:regression';
    const labels = ['perf', labelMain, `tier:${tier}`];
    if (consoleFail) labels.push('perf:js-error');

    const baseline = baselineFor(runRow.url, runRow.device, runRow.id);
    const title = `[${severity}] ${runRow.url} (${runRow.device})`;
    const body = formatBody(runRow, reasons, baseline);

    // Deduplicate: if we already have an open regression on this url+device within 48h, comment instead.
    const primaryMetric = (absoluteFails[0]?.metric) || (relativeFails[0]?.metric) || 'console_errors';
    const dup = hasOpenRegression(runRow.url, primaryMetric);
    if (dup && dup.gh_issue) {
      commentIssue(dup.gh_issue, `New occurrence detected at ${runRow.started_at}.\n\n${body}`);
    } else {
      const issueNumber = openIssue(title, body, labels);
      if (issueNumber) {
        db.prepare(`UPDATE regressions SET gh_issue = ? WHERE run_id = ? AND gh_issue IS NULL`)
          .run(issueNumber, runRow.id);
      }
    }

    summary.push(`- ${severity.toUpperCase()} ${runRow.url} (${runRow.device}): ${reasons.join('; ')}`);
  }

  const summaryPath = 'data/regressions-summary.md';
  fs.writeFileSync(summaryPath, summary.length
    ? `# Regressions detected\n\nRan at ${now.toISOString()}\n\n${summary.join('\n')}\n`
    : `# No regressions\n\nRan at ${now.toISOString()}\n`);
  console.log(`Flagged ${flagCount} runs. Summary at ${summaryPath}.`);
}

run();
