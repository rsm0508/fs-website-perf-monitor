// Sitemap fetcher and parser.

import { XMLParser } from 'fast-xml-parser';

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  // sitemaps use <loc> and <lastmod> as text nodes, no attributes needed
});

export async function fetchSitemap(url) {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) {
    throw new Error(`Failed to fetch sitemap ${url}: ${res.status} ${res.statusText}`);
  }
  const xml = await res.text();
  const doc = parser.parse(xml);
  const urlset = doc.urlset || doc.sitemapindex;
  if (!urlset) return [];
  const entries = Array.isArray(urlset.url) ? urlset.url : urlset.url ? [urlset.url] : [];
  return entries.map((e) => ({
    loc: typeof e.loc === 'string' ? e.loc.trim() : e.loc?.['#text']?.trim(),
    lastmod: e.lastmod ? String(e.lastmod).trim() : null,
  })).filter((e) => e.loc);
}
