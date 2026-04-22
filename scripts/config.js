// FullSession Performance Monitor — configuration
// Edit this file to change tier membership, thresholds, and Chrome flags.

export const SITE_ORIGIN = 'https://www.fullsession.io';

export const SITEMAPS = {
  pages: `${SITE_ORIGIN}/page-sitemap.xml`,
  posts: `${SITE_ORIGIN}/post-sitemap.xml`,
};

// Exact-match URLs that get Tier 0 treatment (12h cadence, mobile + desktop).
// Purpose: conversion-critical pages where a silent regression costs money in 12h.
export const TIER0_URLS = [
  `${SITE_ORIGIN}/`,
  `${SITE_ORIGIN}/book-a-demo/`,
  `${SITE_ORIGIN}/pricing/`,
];

// Path-prefix patterns that also promote to Tier 0.
// Note: /solutions/ and /product/ here are marketing pages, requested by Roman.
// Tier 0 is 12h cadence mobile+desktop; if noisy, demote to CORE_PATH_PATTERNS.
export const TIER0_PATH_PATTERNS = [
  /^\/solutions\//,
  /^\/product\//,
];

// Path-prefix patterns that promote a page-sitemap URL to Core tier (3 days).
// Everything else from page-sitemap.xml that is not Tier 0 falls into 'other'.
export const CORE_PATH_PATTERNS = [
  /^\/compare\//,
  /^\/integrations\/?$/,
  /^\/mobile-session-replay\/?$/,
  /^\/safety-security\/?$/,
  /^\/hotjar-alternatives\/?$/,
  /^\/hotjar-review\/?$/,
  /^\/signup\/?$/,
];

// URLs (or path-prefix patterns) to skip entirely — not tested by any scheduled job.
// Confirmed excluded by Roman 2026-04-22: low-value static content.
export const EXCLUDED_PATH_PATTERNS = [
  /^\/privacy-policy\/?$/,
  /^\/terms-of-use\/?$/,
  /^\/about-fullsession\/?$/,
  /^\/contact\/?$/,
  /^\/resources\/glossary\/?$/,
  /^\/blog\/?$/, // the /blog/ index page itself; individual posts still come from post-sitemap.xml
  /^\/security-dpa\/?$/,
];

// Absolute fail thresholds (mobile). Desktop is more generous, see DESKTOP_MULTIPLIER.
export const ABSOLUTE_THRESHOLDS = {
  lcp_ms: 4000,
  cls: 0.25,
  tbt_ms: 600,
  ttfb_ms: 1500,
  performance_score: 40, // fail if BELOW this
};

// Desktop absolute thresholds are these multipliers × mobile. Desktop should be easier.
export const DESKTOP_MULTIPLIER = {
  lcp_ms: 0.6,   // desktop LCP should be < 2400ms
  cls: 1.0,      // CLS threshold is device-agnostic
  tbt_ms: 0.5,   // desktop TBT should be < 300ms
  ttfb_ms: 0.8,  // desktop TTFB should be < 1200ms
  performance_score: 1.2, // desktop score floor is 48
};

// Relative regression: current > baseline × (1 + PCT_WORSE_THRESHOLD) on these metrics.
export const RELATIVE_METRICS = ['lcp_ms', 'tbt_ms', 'cls', 'total_byte_weight'];
export const PCT_WORSE_THRESHOLD = 0.20; // 20%
export const MIN_HISTORY_FOR_RELATIVE = 5; // need at least 5 prior good runs

// Retention: keep run rows this many days. Beyond this they get archived by maintenance.
export const RUN_RETENTION_DAYS = 365;

// How many days back to sample for the rolling baseline.
export const BASELINE_WINDOW_DAYS = 30;
export const BASELINE_SAMPLE_SIZE = 10;

// Posts cadence: we test 1/POSTS_SLICES of posts per day, rolling.
export const POSTS_SLICES = 7;

// Chrome launch flags for Lighthouse.
export const CHROME_FLAGS = [
  '--headless=new',
  '--no-sandbox',
  '--disable-gpu',
  '--disable-dev-shm-usage',
  '--disable-background-networking',
  '--disable-default-apps',
  '--disable-extensions',
  '--disable-sync',
];

// Lighthouse config presets per device.
export const LH_DEVICE_CONFIG = {
  mobile: {
    extends: 'lighthouse:default',
    settings: {
      formFactor: 'mobile',
      throttling: {
        rttMs: 150,
        throughputKbps: 1638.4,
        cpuSlowdownMultiplier: 4,
        requestLatencyMs: 562.5,
        downloadThroughputKbps: 1474.56,
        uploadThroughputKbps: 675,
      },
      screenEmulation: {
        mobile: true,
        width: 412,
        height: 823,
        deviceScaleFactor: 1.75,
        disabled: false,
      },
      emulatedUserAgent:
        'Mozilla/5.0 (Linux; Android 11; moto g power (2022)) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/114.0.0.0 Mobile Safari/537.36 Chrome-Lighthouse',
      onlyCategories: ['performance'],
      maxWaitForLoad: 45000,
    },
  },
  desktop: {
    extends: 'lighthouse:default',
    settings: {
      formFactor: 'desktop',
      throttling: {
        rttMs: 40,
        throughputKbps: 10240,
        cpuSlowdownMultiplier: 1,
        requestLatencyMs: 0,
        downloadThroughputKbps: 0,
        uploadThroughputKbps: 0,
      },
      screenEmulation: {
        mobile: false,
        width: 1350,
        height: 940,
        deviceScaleFactor: 1,
        disabled: false,
      },
      emulatedUserAgent:
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/114.0.0.0 Safari/537.36 Chrome-Lighthouse',
      onlyCategories: ['performance'],
      maxWaitForLoad: 45000,
    },
  },
};

export const DB_PATH = 'data/perf.db';
export const REPORTS_DIR = 'reports';
export const SCREENSHOTS_DIR = 'reports/screenshots';
export const LH_REPORTS_DIR = 'reports/lighthouse';
