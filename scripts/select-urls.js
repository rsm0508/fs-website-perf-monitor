// Selects URLs to test for the current workflow invocation.
// Run as: node scripts/select-urls.js --mode <tier0|core|core-desktop|posts|new|recheck>
// Writes selected URLs (one per line, TAB device) to stdout.

import { getDb } from './utils/db.js';
import { POSTS_SLICES } from './config.js';

const mode = process.argv.slice(2).reduce((acc, arg, i, arr) => {
  if (arg === '--mode') acc.mode = arr[i + 1];
  return acc;
}, { mode: null });

const db = getDb();
const now = new Date();
const nowIso = now.toISOString();

function emit(url, device) {
  process.stdout.write(`${url}\t${device}\n`);
}

function lastCheckedBefore(hours) {
  // URLs where last_checked is null or older than N hours ago
  return new Date(now.getTime() - hours * 3600 * 1000).toISOString();
}

switch (mode.mode) {
  case 'tier0': {
    // All active tier0 URLs if none checked in last 11 hours, mobile + desktop.
    const cutoff = lastCheckedBefore(11);
    const rows = db.prepare(`
      SELECT url FROM urls
      WHERE tier = 'tier0' AND active = 1
        AND (last_checked IS NULL OR last_checked < ?)
    `).all(cutoff);
    for (const r of rows) {
      emit(r.url, 'mobile');
      emit(r.url, 'desktop');
    }
    break;
  }
  case 'core': {
    // All active core URLs not checked in last 70 hours (3-day cadence with slop).
    const cutoff = lastCheckedBefore(70);
    const rows = db.prepare(`
      SELECT url FROM urls
      WHERE tier = 'core' AND active = 1
        AND (last_checked IS NULL OR last_checked < ?)
    `).all(cutoff);
    for (const r of rows) emit(r.url, 'mobile');
    break;
  }
  case 'core-desktop': {
    // Weekly desktop pass for core URLs.
    const cutoff = lastCheckedBefore(24 * 6);
    const rows = db.prepare(`
      SELECT urls.url FROM urls
      LEFT JOIN (
        SELECT url, MAX(started_at) AS last_desktop
        FROM runs
        WHERE device = 'desktop'
        GROUP BY url
      ) r ON r.url = urls.url
      WHERE urls.tier IN ('core', 'tier0') AND urls.active = 1
        AND (r.last_desktop IS NULL OR r.last_desktop < ?)
    `).all(cutoff);
    for (const r of rows) emit(r.url, 'desktop');
    break;
  }
  case 'posts': {
    // Daily slice of 1/POSTS_SLICES posts, rolling by stable hash of URL.
    const dayOfYear = Math.floor((now - new Date(now.getFullYear(), 0, 0)) / 86400000);
    const slice = dayOfYear % POSTS_SLICES;
    const rows = db.prepare(`
      SELECT url FROM urls
      WHERE tier = 'post' AND active = 1
    `).all();
    for (const r of rows) {
      // Simple stable bucket: char-sum mod slices.
      let h = 0;
      for (let i = 0; i < r.url.length; i++) h = (h + r.url.charCodeAt(i)) % 10000;
      if (h % POSTS_SLICES === slice) emit(r.url, 'mobile');
    }
    break;
  }
  case 'new': {
    // URLs in queue with reason='new' or 'changed' not yet processed.
    const rows = db.prepare(`
      SELECT DISTINCT q.url, q.device FROM queue q
      WHERE q.processed_at IS NULL AND q.reason IN ('new', 'changed')
    `).all();
    for (const r of rows) emit(r.url, r.device);
    break;
  }
  case 'recheck': {
    // Flagged URLs queued for retest.
    const rows = db.prepare(`
      SELECT DISTINCT q.url, q.device, q.runs_required FROM queue q
      WHERE q.processed_at IS NULL AND q.reason = 'flagged'
    `).all();
    for (const r of rows) {
      for (let i = 0; i < (r.runs_required || 3); i++) emit(r.url, r.device);
    }
    break;
  }
  default:
    console.error(`Unknown --mode: ${mode.mode}. Valid: tier0, core, core-desktop, posts, new, recheck`);
    process.exit(2);
}
