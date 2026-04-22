// Fetches both sitemaps, upserts into urls table, enqueues new + changed URLs.
// Writes a human-readable summary to stdout.

import fs from 'node:fs';
import { getDb } from './utils/db.js';
import { fetchSitemap } from './utils/sitemap.js';
import {
  SITEMAPS,
  TIER0_URLS,
  TIER0_PATH_PATTERNS,
  CORE_PATH_PATTERNS,
  EXCLUDED_PATH_PATTERNS,
  SITE_ORIGIN,
} from './config.js';

function isExcluded(url) {
  try {
    const p = new URL(url).pathname;
    return EXCLUDED_PATH_PATTERNS.some((re) => re.test(p));
  } catch (_) {
    return false;
  }
}

function tierFor(url, source) {
  if (TIER0_URLS.includes(url)) return 'tier0';
  try {
    const p = new URL(url).pathname;
    if (TIER0_PATH_PATTERNS.some((re) => re.test(p))) return 'tier0';
    if (source === 'posts') return 'post';
    if (CORE_PATH_PATTERNS.some((re) => re.test(p))) return 'core';
  } catch (_) {
    if (source === 'posts') return 'post';
  }
  return 'other';
}

async function run() {
  const db = getDb();
  const now = new Date().toISOString();

  const pages = await fetchSitemap(SITEMAPS.pages);
  const posts = await fetchSitemap(SITEMAPS.posts);
  console.log(`Discovered ${pages.length} pages and ${posts.length} posts from sitemaps.`);

  const seen = new Set();
  const newUrls = [];
  const changedUrls = [];

  const upsert = db.prepare(`
    INSERT INTO urls (url, tier, first_seen, last_seen, lastmod, active)
    VALUES (@url, @tier, @now, @now, @lastmod, 1)
    ON CONFLICT(url) DO UPDATE SET
      last_seen = @now,
      lastmod   = excluded.lastmod,
      active    = 1,
      tier      = CASE WHEN urls.tier = 'tier0' THEN 'tier0' ELSE excluded.tier END
  `);

  const getExisting = db.prepare(`SELECT url, lastmod, first_seen FROM urls WHERE url = ?`);
  const enqueue = db.prepare(`
    INSERT INTO queue (url, reason, device, runs_required, enqueued_at)
    VALUES (?, ?, ?, ?, ?)
  `);

  const processEntry = db.transaction((entry, source) => {
    const { loc, lastmod } = entry;
    if (!loc.startsWith(SITE_ORIGIN)) return; // ignore off-domain entries
    if (isExcluded(loc)) return; // skip pages explicitly excluded in config
    const tier = tierFor(loc, source);
    const prior = getExisting.get(loc);

    upsert.run({ url: loc, tier, now, lastmod });

    if (!prior) {
      newUrls.push({ url: loc, tier });
      enqueue.run(loc, 'new', 'mobile', 1, now);
    } else if (lastmod && prior.lastmod && lastmod > prior.lastmod) {
      changedUrls.push({ url: loc, tier, prior: prior.lastmod, current: lastmod });
      enqueue.run(loc, 'changed', 'mobile', 1, now);
    }
    seen.add(loc);
  });

  for (const e of pages) processEntry(e, 'pages');
  for (const e of posts) processEntry(e, 'posts');

  // Mark URLs present previously but not in this discovery as inactive.
  const allUrls = db.prepare(`SELECT url FROM urls WHERE active = 1`).all();
  const deactivate = db.prepare(`UPDATE urls SET active = 0 WHERE url = ?`);
  let deactivated = 0;
  for (const row of allUrls) {
    if (!seen.has(row.url)) {
      deactivate.run(row.url);
      deactivated++;
    }
  }

  // Write discovery-queue.json for workflow visibility.
  const snapshot = {
    ran_at: now,
    pages_count: pages.length,
    posts_count: posts.length,
    new: newUrls,
    changed: changedUrls,
    deactivated,
  };
  fs.mkdirSync('data', { recursive: true });
  fs.writeFileSync('data/discovery-queue.json', JSON.stringify(snapshot, null, 2));

  console.log(`New URLs: ${newUrls.length}`);
  console.log(`Changed URLs (lastmod advanced): ${changedUrls.length}`);
  console.log(`Deactivated URLs: ${deactivated}`);
  if (newUrls.length) {
    console.log('New:');
    for (const u of newUrls) console.log(`  [${u.tier}] ${u.url}`);
  }
  if (changedUrls.length) {
    console.log('Changed:');
    for (const u of changedUrls) console.log(`  [${u.tier}] ${u.url} (${u.prior} -> ${u.current})`);
  }
}

run().catch((err) => {
  console.error('Discovery failed:', err);
  process.exit(1);
});
