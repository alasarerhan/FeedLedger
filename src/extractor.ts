// src/extractor.ts
import * as cheerio from 'cheerio';
import { config } from './config.js';
import { createLogger } from './logger.js';
import type { QueueEntry } from './types.js';

const log = createLogger('extractor');

// Domain-level rate limiting
const lastFetchByDomain = new Map<string, number>();

function getDomain(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

async function waitForDomainRateLimit(domain: string): Promise<void> {
  const lastFetch = lastFetchByDomain.get(domain);
  if (lastFetch) {
    const elapsed = Date.now() - lastFetch;
    if (elapsed < config.scrapingDomainDelayMs) {
      await new Promise(resolve => setTimeout(resolve, config.scrapingDomainDelayMs - elapsed));
    }
  }
}

function recordDomainFetch(domain: string): void {
  lastFetchByDomain.set(domain, Date.now());
}

async function scrapeArticle(url: string): Promise<string | null> {
  const domain = getDomain(url);
  if (!domain) return null;

  await waitForDomainRateLimit(domain);

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), config.scrapingTimeoutMs);

    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; FeedLedger/2.0; +https://github.com/alasarerhan/feedledger)',
        'Accept': 'text/html',
      },
    });

    clearTimeout(timeout);
    recordDomainFetch(domain);

    if (!response.ok) {
      log.warn(`Scraping failed for ${url}: HTTP ${response.status}`);
      return null;
    }

    const html = await response.text();
    return extractTextFromHtml(html);
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      log.warn(`Scraping timeout for ${url}`);
    } else {
      log.warn(`Scraping error for ${url}: ${err}`);
    }
    recordDomainFetch(domain);
    return null;
  }
}

function extractTextFromHtml(html: string): string | null {
  const $ = cheerio.load(html);

  // Remove boilerplate elements
  $('nav, footer, aside, script, style, noscript, iframe, svg, form, header').remove();
  $('[class*="ad-"], [class*="advertisement"], [class*="sidebar"], [id*="ad-"], [id*="sidebar"]').remove();
  $('[role="navigation"], [role="complementary"], [role="banner"]').remove();

  // Try to find article content in order of specificity
  let contentEl = $('article').first();
  if (contentEl.length === 0) contentEl = $('main').first();
  if (contentEl.length === 0) contentEl = $('[role="main"]').first();

  let text: string;
  if (contentEl.length > 0) {
    text = contentEl.text();
  } else {
    // Fallback: collect first 6 <p> tags
    const paragraphs: string[] = [];
    $('p').each((i, el) => {
      if (i >= 6) return false;
      const pText = $(el).text().trim();
      if (pText.length > 30) {
        paragraphs.push(pText);
      }
    });
    text = paragraphs.join('\n\n');
  }

  // Clean up whitespace
  text = text
    .replace(/\s+/g, ' ')
    .replace(/\n\s*\n/g, '\n\n')
    .trim();

  if (text.length < 50) return null;
  return text.slice(0, config.enrichedContentMaxLength);
}

export async function enrichEntry(entry: QueueEntry): Promise<{ enrichedContent: string; wasScraped: boolean }> {
  // arXiv: abstract is already complete in RSS
  const isArxiv = entry.feedName.startsWith(config.arxivFeedPrefix);
  if (isArxiv) {
    return { enrichedContent: entry.snippet, wasScraped: false };
  }

  // Snippet long enough?
  if (entry.snippet.length >= config.snippetMinLength) {
    return { enrichedContent: entry.snippet, wasScraped: false };
  }

  // Scrape full article
  log.info(`Snippet too short (${entry.snippet.length} chars), scraping: ${entry.link}`);
  const scraped = await scrapeArticle(entry.link);

  if (scraped) {
    log.info(`Scraped ${scraped.length} chars from: ${entry.link}`);
    return { enrichedContent: scraped, wasScraped: true };
  }

  // Fallback to snippet
  log.info(`Scraping failed, falling back to snippet for: ${entry.link}`);
  return { enrichedContent: entry.snippet, wasScraped: false };
}
