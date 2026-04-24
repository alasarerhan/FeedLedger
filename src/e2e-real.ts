#!/usr/bin/env node
import { runtimeConfig } from './config.js';
import { parseArgs } from './cli.js';
import { createLogger } from './logger.js';
import { getAdminPassword, initializeRuntimeSettings, getRuntimeSettings, type RuntimeFeed } from './runtime-settings.js';
import { fetchArticlesForFeedsSequential } from './feeds.js';
import { filterByRelevance } from './relevance.js';
import { enrichEntry } from './extractor.js';
import { summarizeEntry } from './summarizer.js';
import { createDailyReportPage, isQuotaLikeError, trashNotionPage, type DailyReportItem, type DailyReportPayload } from './notion.js';
import { sendDailyReportLink } from './telegram.js';
import { getOldestReport, removeReportByPageId, upsertReport } from './report-index.js';
import { getZonedNow, isDateInRange, shiftDate } from './time-utils.js';
import { initializeUserStore, listUserIds } from './user-store.js';
import type { Article, FeedConfig, QueueEntry, ReportType } from './types.js';

const log = createLogger('e2e-real');
const E2E_USER_ID = 'admin';

function articleDateInTimezone(article: Article, timeZone: string): string | null {
  try {
    const published = new Date(article.publishedAt);
    if (Number.isNaN(published.getTime())) return null;
    return getZonedNow(timeZone, published).date;
  } catch {
    return null;
  }
}

function buildQueueEntry(article: Article): QueueEntry {
  const now = Date.now();
  return {
    id: article.id,
    state: 'discovered',
    feedName: article.source,
    feedKind: article.feedKind,
    feedPriority: article.feedPriority,
    title: article.title,
    link: article.link,
    snippet: article.snippet,
    discoveredAt: now,
    lastUpdatedAt: now,
  };
}

function validateConfig(): void {
  const settings = getRuntimeSettings(E2E_USER_ID);

  if (settings.aiProvider === 'gemini' && !settings.geminiApiKey) {
    throw new Error('GEMINI_API_KEY is required when aiProvider=gemini');
  }

  if (settings.aiProvider === 'openrouter' && !settings.openrouterApiKey) {
    throw new Error('OPENROUTER_API_KEY is required when aiProvider=openrouter');
  }

  if (!settings.notionApiKey || !settings.notionParentPageId) {
    throw new Error('NOTION_API_KEY and NOTION_PARENT_PAGE_ID are required');
  }

  if (!settings.telegramBotToken || !settings.telegramChatId) {
    throw new Error('TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID are required');
  }
}

async function createNotionReportWithAutoClean(payload: DailyReportPayload): Promise<{ pageId: string; url: string }> {
  const settings = getRuntimeSettings(E2E_USER_ID);

  for (;;) {
    try {
      const page = await createDailyReportPage(settings.notionApiKey, settings.notionParentPageId, payload);
      upsertReport({
        userId: E2E_USER_ID,
        reportDate: payload.reportDate,
        reportType: payload.reportType,
        scopeType: payload.scopeType,
        scopeValue: payload.scopeValue,
        notionPageId: page.pageId,
        notionUrl: page.url,
        createdAt: Date.now(),
      });
      return page;
    } catch (err) {
      if (!settings.notionQuotaAutoclean || !isQuotaLikeError(err)) {
        throw err;
      }

      const oldest = getOldestReport(E2E_USER_ID);
      if (!oldest) throw err;

      log.warn(`Quota/limit detected, deleting oldest report ${oldest.reportDate}`);
      await trashNotionPage(settings.notionApiKey, oldest.notionPageId);
      removeReportByPageId(E2E_USER_ID, oldest.notionPageId);
    }
  }
}

function splitFeedsByReportType(): { news: FeedConfig[]; papers: FeedConfig[] } {
  const settings = getRuntimeSettings(E2E_USER_ID);
  const runtimeFeeds = settings.feeds.filter(feed => feed.enabled);
  const toFeedConfig = (feed: RuntimeFeed): FeedConfig => ({
    name: feed.name,
    url: feed.url,
    kind: feed.group === 'papers' ? 'research' : 'media',
    priority: feed.priority,
  });
  const papers = runtimeFeeds.filter(feed => feed.group === 'papers').map(toFeedConfig);
  const news = runtimeFeeds.filter(feed => feed.group === 'news').map(toFeedConfig);
  return { news, papers };
}

async function buildAndSendReport(
  reportType: ReportType,
  reportDate: string,
  feeds: FeedConfig[],
): Promise<{ reportType: ReportType; notionUrl: string; itemCount: number }> {
  const settings = getRuntimeSettings(E2E_USER_ID);
  const lookbackDays = Math.max(1, settings.reportPeriodDays || 1);
  const startDate = shiftDate(reportDate, -(lookbackDays - 1));

  const allArticles = await fetchArticlesForFeedsSequential(feeds, reportType);
  const filtered = allArticles.filter(article => {
    const localDate = articleDateInTimezone(article, settings.reportTimezone);
    if (!localDate) return false;
    return isDateInRange(localDate, startDate, reportDate);
  });

  log.info(`Selected ${filtered.length} ${reportType} articles in window ${startDate}..${reportDate}`);

  const entryById = new Map<string, QueueEntry>();
  const articleById = new Map<string, Article>();
  const queueEntries: QueueEntry[] = [];

  for (const article of filtered) {
    const id = article.id || article.link;
    if (!id || entryById.has(id)) continue;

    const normalized: Article = { ...article, id };
    const entry = buildQueueEntry(normalized);
    entryById.set(id, entry);
    articleById.set(id, normalized);
    queueEntries.push(entry);
  }

  const relevance = await filterByRelevance(queueEntries, settings);
  const candidates = relevance.passed;

  const items: DailyReportItem[] = [];
  for (const candidate of candidates) {
    const entry = candidate.entry;
    try {
      const enriched = await enrichEntry(entry);
      entry.enrichedContent = enriched.enrichedContent;
      const summary = await summarizeEntry(entry, settings);
      if (!summary) continue;

      const article = articleById.get(entry.id);
      if (!article) continue;

      items.push({
        title: summary.translated_title || entry.title,
        source: entry.feedName,
        link: entry.link,
        interestTags: candidate.matchedInterests,
        whatHappened: summary.what_happened,
        whyItMatters: summary.why_it_matters,
        keyDetail: summary.key_detail,
        publishedAt: article.publishedAt,
      });
    } catch (err) {
      log.warn(`Entry failed (${reportType}/${entry.id}): ${err}`);
    }
  }

  items.sort((a, b) => new Date(b.publishedAt).getTime() - new Date(a.publishedAt).getTime());

  const payload: DailyReportPayload = {
    reportDate,
    reportType,
    scopeType: 'all',
    scopeValue: 'all',
    lookbackDays,
    timezone: settings.reportTimezone,
    generatedAtIso: new Date().toISOString(),
    items,
  };

  const notion = await createNotionReportWithAutoClean(payload);
  await sendDailyReportLink(
    settings.telegramBotToken,
    settings.telegramChatId,
    reportType,
    'all',
    'all',
    reportDate,
    notion.url,
    settings.assistantGreeting,
    settings.assistantSignature,
  );

  log.info(`REAL E2E ${reportType} report success. reportDate=${reportDate}, items=${items.length}`);
  return { reportType, notionUrl: notion.url, itemCount: items.length };
}

async function main(): Promise<void> {
  const args = parseArgs();
  runtimeConfig.language = args.lang;

  initializeUserStore(getAdminPassword());
  initializeRuntimeSettings(listUserIds());
  validateConfig();

  const settings = getRuntimeSettings(E2E_USER_ID);
  const now = getZonedNow(settings.reportTimezone);
  const reportDate = shiftDate(now.date, -1); // dünkü gelişmeler

  log.info(`Running REAL E2E for ${reportDate} in timezone ${settings.reportTimezone} (news -> papers)`);

  const { news, papers } = splitFeedsByReportType();
  const newsResult = await buildAndSendReport('news', reportDate, news);
  const papersResult = await buildAndSendReport('papers', reportDate, papers);

  console.log(`NEWS_REPORT_URL=${newsResult.notionUrl}`);
  console.log(`PAPERS_REPORT_URL=${papersResult.notionUrl}`);
}

main().catch((err) => {
  log.error('REAL E2E failed', err);
  process.exit(1);
});
