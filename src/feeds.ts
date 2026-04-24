// src/feeds.ts
import Parser from 'rss-parser';
import { config } from './config.js';
import { createLogger } from './logger.js';
import { deduplicateArticles } from './dedup.js';
import type { Article, FeedConfig } from './types.js';

const log = createLogger('feeds');
const parser = new Parser({
  timeout: 10000,
  headers: { 'User-Agent': 'FeedLedger/2.0' },
});

const SNIPPET_MAX_CHARS = 1500;

async function fetchFeed(feed: FeedConfig): Promise<Article[]> {
  try {
    log.debug(`Fetching feed: ${feed.name}`);
    const parsed = await parser.parseURL(feed.url);
    return (parsed.items || []).map(item => {
      const raw = item.summary || item.contentSnippet || item.content || '';
      const snippet = raw.slice(0, SNIPPET_MAX_CHARS);
      return {
        id: item.guid || item.link || item.title || '',
        title: item.title || 'Untitled',
        link: item.link || '',
        snippet,
        source: feed.name,
        feedKind: feed.kind,
        feedPriority: feed.priority,
        publishedAt: item.isoDate || item.pubDate || new Date().toISOString(),
      };
    });
  } catch (err) {
    log.error(`Failed to fetch feed: ${feed.name}`, err);
    return [];
  }
}

export async function fetchArticlesForFeedsSequential(feeds: FeedConfig[], label = 'all'): Promise<Article[]> {
  const allArticles: Article[] = [];

  for (const feed of feeds) {
    const items = await fetchFeed(feed);
    allArticles.push(...items);
  }

  const unique = deduplicateArticles(allArticles);
  unique.sort((a, b) =>
    new Date(b.publishedAt).getTime() - new Date(a.publishedAt).getTime()
  );

  log.info(`Fetched (${label}) ${allArticles.length} total articles, ${unique.length} after dedup`);
  return unique;
}

export async function fetchAllArticles(): Promise<Article[]> {
  return fetchArticlesForFeedsSequential(config.feeds, 'all');
}
