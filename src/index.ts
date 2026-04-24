#!/usr/bin/env node
import { runtimeConfig } from './config.js';
import { createLogger } from './logger.js';
import { fetchArticlesForFeedsSequential } from './feeds.js';
import { filterByRelevance } from './relevance.js';
import { enrichEntry } from './extractor.js';
import { summarizeEntry } from './summarizer.js';
import { parseArgs } from './cli.js';
import { startAdminPanel } from './admin-panel.js';
import {
  ensureRuntimeSettingsForUsers,
  getAdminPassword,
  getRuntimeSettings,
  initializeRuntimeSettings,
  removeRuntimeSettingsForUser,
  type RuntimeFeed,
  type RuntimeSpecialProject,
  type RuntimeSettings,
} from './runtime-settings.js';
import { createDailyReportPage, isQuotaLikeError, trashNotionPage, type DailyReportItem, type DailyReportPayload } from './notion.js';
import { sendDailyReportLink } from './telegram.js';
import { MammothStore } from './mammoth-store.js';
import {
  ensureUserReportIndex,
  findReport,
  getOldestReport,
  listReports,
  removeReportByPageId,
  removeUserReportIndex,
  upsertReport,
} from './report-index.js';
import {
  ensureSchedulerStatesForUsers,
  getUnsentReportsUpTo,
  loadSchedulerStates,
  removeDailyReport,
  removeSchedulerState,
  saveSchedulerStates,
  upsertDailyReport,
  type DailyReportState,
  type SchedulerState,
  type SchedulerStatesByUser,
} from './daily-state.js';
import { getZonedNow, isDateInRange, isTimeReached, shiftDate } from './time-utils.js';
import { initializeUserStore, listUserIds, listUsers } from './user-store.js';
import type { Article, FeedConfig, QueueEntry, ReportType } from './types.js';

const log = createLogger('main');

const RETRY_DELAY_MS = 15 * 60 * 1000;
const PAPERS_RELEVANCE_THRESHOLD = 6;
const PAPERS_WEEKEND_LOOKBACK_DAYS = 2;
const PAPERS_MAX_RELEVANCE_INPUT = 240;
const PAPERS_MAX_SUMMARY_ITEMS = 30;
const PAPERS_FALLBACK_ITEMS = 8;
const MAMMOTH_RECONNECT_COOLDOWN_MS = 60 * 1000;

let schedulerStates: SchedulerStatesByUser = {};
const scanRunningUsers = new Set<string>();
const sendRunningUsers = new Set<string>();
const userOperationLocks = new Map<string, Promise<void>>();
let mammothStore: MammothStore | null = null;
let mammothReconnectAfterMs = 0;
let mammothConnectInFlight: Promise<void> | null = null;
let mammothBackfillInFlight: Promise<void> | null = null;

function validateStartupConfig(): void {
  const adminPassword = getAdminPassword();
  if (!adminPassword) {
    log.error('ADMIN_PANEL_PASSWORD is required. Set it in .env file.');
    process.exit(1);
  }

  initializeUserStore(adminPassword);
  const userIds = listUserIds();
  initializeRuntimeSettings(userIds);
  ensureRuntimeSettingsForUsers(userIds);
  ensureUserReportIndex(userIds);
  schedulerStates = loadSchedulerStates(userIds);
}

function syncUserContexts(): void {
  const userIds = listUserIds();
  ensureRuntimeSettingsForUsers(userIds);
  ensureUserReportIndex(userIds);

  const changed = ensureSchedulerStatesForUsers(schedulerStates, userIds);
  if (changed) {
    saveSchedulerStates(schedulerStates);
  }

  for (const knownUserId of Object.keys(schedulerStates)) {
    if (!userIds.includes(knownUserId)) {
      removeSchedulerState(schedulerStates, knownUserId);
      removeRuntimeSettingsForUser(knownUserId);
      removeUserReportIndex(knownUserId);
      scanRunningUsers.delete(knownUserId);
      sendRunningUsers.delete(knownUserId);
      userOperationLocks.delete(knownUserId);
    }
  }

  saveSchedulerStates(schedulerStates);
}

function articleDateInTimezone(article: Article, timeZone: string): string | null {
  try {
    const published = new Date(article.publishedAt);
    if (Number.isNaN(published.getTime())) return null;
    return getZonedNow(timeZone, published).date;
  } catch {
    return null;
  }
}

async function runUserExclusive<T>(
  userId: string,
  operation: 'scan' | 'send',
  runDate: string,
  task: () => Promise<T>,
): Promise<T> {
  const previous = userOperationLocks.get(userId) ?? Promise.resolve();
  const hadPending = userOperationLocks.has(userId);

  let releaseCurrentLock: () => void = () => undefined;
  const currentLock = new Promise<void>((resolve) => {
    releaseCurrentLock = resolve;
  });

  const lockTail = previous.catch(() => undefined).then(() => currentLock);
  userOperationLocks.set(userId, lockTail);

  if (hadPending) {
    log.info(`[${userId}] Queuing ${operation} for ${runDate}; another operation is running`);
  }

  await previous.catch(() => undefined);

  try {
    return await task();
  } finally {
    releaseCurrentLock();
    if (userOperationLocks.get(userId) === lockTail) {
      userOperationLocks.delete(userId);
    }
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

function requireDailySettings(userId: string): RuntimeSettings {
  const settings = getRuntimeSettings(userId);

  if (settings.aiProvider === 'gemini' && !settings.geminiApiKey) {
    throw new Error(`GEMINI_API_KEY is required for aiProvider=gemini (user=${userId})`);
  }

  if (settings.aiProvider === 'openrouter' && !settings.openrouterApiKey) {
    throw new Error(`OPENROUTER_API_KEY is required for aiProvider=openrouter (user=${userId})`);
  }

  if (!settings.notionApiKey || !settings.notionParentPageId) {
    throw new Error(`NOTION_API_KEY and NOTION_PARENT_PAGE_ID are required for daily reporting (user=${userId})`);
  }

  return settings;
}

function getUserState(userId: string): SchedulerState {
  if (!schedulerStates[userId]) {
    schedulerStates[userId] = { reports: {} };
    saveSchedulerStates(schedulerStates);
  }
  return schedulerStates[userId];
}

function getReportState(
  state: SchedulerState,
  reportDate: string,
  reportType: ReportType,
  scopeType: 'all' | 'interest' = 'all',
  scopeValue = 'all',
): DailyReportState | undefined {
  return Object.values(state.reports).find(
    r => r.reportDate === reportDate
      && r.reportType === reportType
      && r.scopeType === scopeType
      && r.scopeValue === scopeValue,
  );
}

function splitRuntimeFeedsByReportType(runtimeFeeds: RuntimeFeed[]): { news: FeedConfig[]; papers: FeedConfig[] } {
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

function splitFeedsByReportType(settings: RuntimeSettings): { news: FeedConfig[]; papers: FeedConfig[] } {
  return splitRuntimeFeedsByReportType(settings.feeds.filter(feed => feed.enabled));
}

function parseArxivCategory(source: string): string {
  const m = source.match(/arXiv\s+([a-z]{2}\.[A-Z]{2})/);
  return m ? m[1] : 'research';
}

function countInterestMatches(text: string, interests: string[]): number {
  if (interests.length === 0) return 0;
  const normalized = text.toLowerCase();
  let score = 0;
  for (const interest of interests) {
    const token = interest.trim().toLowerCase();
    if (!token) continue;
    if (normalized.includes(token)) {
      score += 1;
    }
  }
  return score;
}

function pickPaperEntriesForRelevance(
  entries: QueueEntry[],
  articleById: Map<string, Article>,
  interests: string[],
): QueueEntry[] {
  if (entries.length <= PAPERS_MAX_RELEVANCE_INPUT) return entries;

  const scored = entries.map((entry) => {
    const article = articleById.get(entry.id);
    const publishedAtMs = article ? new Date(article.publishedAt).getTime() : 0;
    const interestMatches = countInterestMatches(
      `${entry.title} ${entry.snippet} ${entry.feedName}`,
      interests,
    );
    return {
      entry,
      interestMatches,
      publishedAtMs: Number.isFinite(publishedAtMs) ? publishedAtMs : 0,
      highPriority: entry.feedPriority === 'high' ? 1 : 0,
    };
  });

  const withInterest = scored.filter(item => item.interestMatches > 0);
  const pool = withInterest.length > 0 ? withInterest : scored;

  return pool
    .sort((a, b) => (
      b.interestMatches - a.interestMatches
      || b.highPriority - a.highPriority
      || b.publishedAtMs - a.publishedAtMs
    ))
    .slice(0, PAPERS_MAX_RELEVANCE_INPUT)
    .map(item => item.entry);
}

function normalizeInterestTags(reportType: ReportType, matchedInterests: string[], article: Article): string[] {
  const clean = Array.from(new Set(matchedInterests.map(tag => tag.trim()).filter(Boolean)));
  if (clean.length > 0) return clean;
  if (reportType === 'papers') return [parseArxivCategory(article.source)];
  return ['General'];
}

function projectScopeLabel(project: RuntimeSpecialProject): string {
  return `Project:${project.name}`;
}

function buildReportScopes(
  items: DailyReportItem[],
  reportGroupingMode: 'single' | 'by_interest',
  interests: string[],
  forcedScopeValue?: string,
): Array<{ scopeType: 'all' | 'interest'; scopeValue: string; items: DailyReportItem[] }> {
  if (forcedScopeValue) {
    return [{ scopeType: 'interest', scopeValue: forcedScopeValue, items }];
  }
  if (reportGroupingMode === 'by_interest' && interests.length > 0) {
    const scoped = interests
      .map((interest) => ({
        scopeType: 'interest' as const,
        scopeValue: interest,
        items: items.filter(item => (item.interestTags || []).includes(interest)),
      }))
      .filter(group => group.items.length > 0);
    if (scoped.length > 0) {
      return scoped;
    }
  }
  return [{ scopeType: 'all', scopeValue: 'all', items }];
}

function parseIsoDateToUtcDay(date: string): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) return null;
  return Date.UTC(year, month - 1, day);
}

function dayDiff(fromDate: string, toDate: string): number {
  const from = parseIsoDateToUtcDay(fromDate);
  const to = parseIsoDateToUtcDay(toDate);
  if (from === null || to === null) return 0;
  return Math.floor((to - from) / 86_400_000);
}

function isWeekendForDate(reportDate: string, timeZone: string): boolean {
  const utcDay = parseIsoDateToUtcDay(reportDate);
  if (utcDay === null) return false;
  const sample = new Date(utcDay + (12 * 60 * 60 * 1000));
  const weekday = new Intl.DateTimeFormat('en-US', { weekday: 'short', timeZone }).format(sample);
  return weekday === 'Sat' || weekday === 'Sun';
}

function resolveLookbackDays(reportType: ReportType, reportDate: string, settings: RuntimeSettings): number {
  const baseLookback = Math.max(1, settings.reportPeriodDays || 1);
  if (reportType !== 'papers') return baseLookback;
  if (baseLookback >= PAPERS_WEEKEND_LOOKBACK_DAYS) return baseLookback;
  if (!isWeekendForDate(reportDate, settings.reportTimezone)) return baseLookback;
  return PAPERS_WEEKEND_LOOKBACK_DAYS;
}

function resolveEmptyReason(
  reportType: ReportType,
  lookbackDays: number,
  filteredCount: number,
  candidateCount: number,
  summarizedCount: number,
): string | undefined {
  if (summarizedCount > 0) return undefined;
  if (filteredCount === 0) {
    return `Son ${lookbackDays} gün içinde rapora girecek yeni ${reportType === 'papers' ? 'makale' : 'haber'} bulunamadı.`;
  }
  if (candidateCount === 0) {
    return reportType === 'papers'
      ? 'Makale kaynaklarından veri alındı ancak uygunluk filtresi hiçbirini rapora dahil etmedi.'
      : 'Uygunluk filtresi sonucu rapora girecek içerik kalmadı.';
  }
  return 'İçerikler bulundu ancak özetleme aşamasında sonuç üretilemedi (AI kota/hata olabilir).';
}

function resolveMammothSettings(): RuntimeSettings {
  const users = listUsers();
  const admin = users.find(user => user.id === 'admin');
  if (admin) {
    return getRuntimeSettings(admin.id);
  }

  const first = users[0];
  if (first) return getRuntimeSettings(first.id);
  return getRuntimeSettings('admin');
}

async function configureMammothStore(): Promise<void> {
  const settings = resolveMammothSettings();

  if (mammothStore) {
    await mammothStore.close();
    mammothStore = null;
  }

  mammothStore = new MammothStore(
    settings.mammothEnabled,
    settings.mammothUri,
    settings.mammothDatabase,
  );

  if (!settings.mammothEnabled) {
    log.info('Mammoth reader store is disabled');
    return;
  }

  try {
    await mammothStore.connect();
  } catch (err) {
    log.error('Failed to connect Mammoth reader store', err);
  }
}

async function syncReportIndexToMammoth(reason: string): Promise<void> {
  if (!mammothStore?.isReady()) return;
  if (mammothBackfillInFlight) {
    await mammothBackfillInFlight;
    return;
  }

  mammothBackfillInFlight = (async () => {
    let synced = 0;
    let failed = 0;

    for (const user of listUsers()) {
      const settings = getRuntimeSettings(user.id);
      const reports = listReports(user.id);
      for (const report of reports) {
        try {
          await mammothStore!.upsertLinkOnly(user.id, {
            reportType: report.reportType,
            reportDate: report.reportDate,
            scopeType: report.scopeType,
            scopeValue: report.scopeValue,
            notionPageId: report.notionPageId,
            notionUrl: report.notionUrl,
            timezone: settings.reportTimezone,
          });
          synced += 1;
        } catch (err) {
          failed += 1;
          log.warn(`[${user.id}] Failed to backfill ${report.reportType}/${report.scopeType}:${report.scopeValue} ${report.reportDate} into Mammoth: ${err}`);
        }
      }
    }

    if (synced > 0 || failed > 0) {
      log.info(`Mammoth backfill (${reason}) synced=${synced} failed=${failed}`);
    }
  })().finally(() => {
    mammothBackfillInFlight = null;
  });

  await mammothBackfillInFlight;
}

async function ensureMammothReady(reason: string): Promise<boolean> {
  const settings = resolveMammothSettings();
  if (!settings.mammothEnabled) return false;
  if (mammothStore?.isReady()) return true;

  const now = Date.now();
  if (now < mammothReconnectAfterMs) {
    return Boolean(mammothStore?.isReady());
  }

  if (mammothConnectInFlight) {
    await mammothConnectInFlight;
    return Boolean(mammothStore?.isReady());
  }

  mammothReconnectAfterMs = now + MAMMOTH_RECONNECT_COOLDOWN_MS;
  mammothConnectInFlight = (async () => {
    await configureMammothStore();
    if (mammothStore?.isReady()) {
      mammothReconnectAfterMs = 0;
      await syncReportIndexToMammoth(`reconnect:${reason}`);
    }
  })().catch((err) => {
    log.warn(`Mammoth reconnect attempt failed (${reason}): ${err}`);
  }).finally(() => {
    mammothConnectInFlight = null;
  });

  await mammothConnectInFlight;
  return Boolean(mammothStore?.isReady());
}

async function persistReportLinkToMammoth(
  userId: string,
  params: {
    reportType: ReportType;
    reportDate: string;
    scopeType: 'all' | 'interest';
    scopeValue: string;
    notionPageId: string;
    notionUrl: string;
    timezone: string;
  },
): Promise<void> {
  const ready = await ensureMammothReady(`link:${params.reportType}:${params.reportDate}`);
  if (!ready || !mammothStore?.isReady()) return;

  try {
    await mammothStore.upsertLinkOnly(userId, params);
  } catch (err) {
    log.warn(`[${userId}] Failed to upsert link-only Mammoth record for ${params.reportType}/${params.scopeValue} ${params.reportDate}: ${err}`);
    const retryReady = await ensureMammothReady(`retry-link:${params.reportType}:${params.reportDate}`);
    if (!retryReady || !mammothStore?.isReady()) return;
    try {
      await mammothStore.upsertLinkOnly(userId, params);
    } catch (retryErr) {
      log.warn(`[${userId}] Retry failed for link-only Mammoth record ${params.reportType}/${params.scopeValue} ${params.reportDate}: ${retryErr}`);
    }
  }
}

async function persistReportToMammoth(
  userId: string,
  payload: DailyReportPayload,
  notionReport: { pageId: string; url: string },
): Promise<void> {
  const ready = await ensureMammothReady(`report:${payload.reportType}:${payload.reportDate}`);
  if (!ready || !mammothStore?.isReady()) return;

  try {
    await mammothStore.upsertReport(userId, payload, {
      pageId: notionReport.pageId,
      url: notionReport.url,
    });
    return;
  } catch (err) {
    log.warn(`[${userId}] Failed to persist ${payload.reportType}/${payload.scopeValue} report into Mammoth store: ${err}`);
  }

  const retryReady = await ensureMammothReady(`retry-report:${payload.reportType}:${payload.reportDate}`);
  if (retryReady && mammothStore?.isReady()) {
    try {
      await mammothStore.upsertReport(userId, payload, {
        pageId: notionReport.pageId,
        url: notionReport.url,
      });
      return;
    } catch (retryErr) {
      log.warn(`[${userId}] Retry failed while persisting ${payload.reportType}/${payload.scopeValue} report into Mammoth store: ${retryErr}`);
    }
  }

  await persistReportLinkToMammoth(userId, {
    reportType: payload.reportType,
    reportDate: payload.reportDate,
    scopeType: payload.scopeType,
    scopeValue: payload.scopeValue,
    notionPageId: notionReport.pageId,
    notionUrl: notionReport.url,
    timezone: payload.timezone,
  });
}

async function createNotionReportWithAutoClean(
  userId: string,
  state: SchedulerState,
  settings: RuntimeSettings,
  payload: DailyReportPayload,
): Promise<{ pageId: string; url: string }> {
  for (;;) {
    try {
      const page = await createDailyReportPage(settings.notionApiKey, settings.notionParentPageId, payload);
      upsertReport({
        userId,
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

      const oldest = getOldestReport(userId);
      if (!oldest) throw err;

      log.warn(`Notion quota/limit detected for ${userId}. Deleting oldest ${oldest.reportType} report ${oldest.reportDate} (${oldest.notionPageId})`);
      await trashNotionPage(settings.notionApiKey, oldest.notionPageId);
      const removed = removeReportByPageId(userId, oldest.notionPageId);
      if (removed) {
        removeDailyReport(state, removed.reportDate, removed.reportType, removed.scopeType, removed.scopeValue);
      }
      saveSchedulerStates(schedulerStates);
    }
  }
}

async function processSingleReport(
  userId: string,
  state: SchedulerState,
  settings: RuntimeSettings,
  reportType: ReportType,
  reportDate: string,
  groupArticles: Article[],
  project?: RuntimeSpecialProject,
): Promise<void> {
  const projectLabel = project ? `${project.id}:${project.name}` : 'default';
  const effectiveInterests = project?.interests || settings.interests;
  const requireInterestMatchForProject = Boolean(project?.strictInterestMatch && effectiveInterests.length > 0);
  const baseLookback = Math.max(1, settings.reportPeriodDays || 1);
  const lookbackDays = resolveLookbackDays(reportType, reportDate, settings);
  if (lookbackDays !== baseLookback) {
    log.info(`[${userId}] ${reportType} weekend lookback override (${projectLabel}): ${baseLookback} -> ${lookbackDays} (${reportDate})`);
  }
  const startDate = shiftDate(reportDate, -(lookbackDays - 1));
  const filtered = groupArticles.filter(article => {
    const localDate = articleDateInTimezone(article, settings.reportTimezone);
    if (!localDate) return false;
    return isDateInRange(localDate, startDate, reportDate);
  });

  log.info(`[${userId}] Building ${reportType} report (${projectLabel}) from ${filtered.length} articles in window ${startDate}..${reportDate}`);

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

  const relevanceInputEntries = reportType === 'papers'
    ? pickPaperEntriesForRelevance(queueEntries, articleById, effectiveInterests)
    : queueEntries;
  if (reportType === 'papers' && relevanceInputEntries.length < queueEntries.length) {
    log.info(
      `[${userId}] papers prefilter reduced relevance input (${projectLabel}):`
      + ` ${queueEntries.length} -> ${relevanceInputEntries.length}`,
    );
  }

  const relevance = await filterByRelevance(
    relevanceInputEntries,
    settings,
    project
      ? {
        thresholdOverride: reportType === 'papers' ? PAPERS_RELEVANCE_THRESHOLD : undefined,
        requireInterestMatch: requireInterestMatchForProject,
        fallbackPassAllOnError: false,
        contextLabel: `${reportType}:${userId}:project:${project.id}`,
        interestOverride: effectiveInterests,
        projectPrompt: project.prompt,
      }
      : reportType === 'papers'
        ? {
          thresholdOverride: PAPERS_RELEVANCE_THRESHOLD,
          requireInterestMatch: effectiveInterests.length > 0,
          fallbackPassAllOnError: false,
          contextLabel: `papers:${userId}`,
        }
        : {
          contextLabel: `news:${userId}`,
        },
  );
  let candidateEntries = relevance.passed;
  if (project && requireInterestMatchForProject && candidateEntries.length === 0 && relevanceInputEntries.length > 0) {
    const relaxedRelevance = await filterByRelevance(relevanceInputEntries, settings, {
      thresholdOverride: reportType === 'papers' ? PAPERS_RELEVANCE_THRESHOLD : 4,
      requireInterestMatch: false,
      fallbackPassAllOnError: false,
      contextLabel: `${reportType}:${userId}:project:${project.id}:relaxed`,
      interestOverride: effectiveInterests,
      projectPrompt: project.prompt,
    });
    candidateEntries = relaxedRelevance.passed;
    if (candidateEntries.length > 0) {
      log.warn(
        `[${userId}] ${reportType} project filter relaxed for ${project.id}:`
        + ` strict-interest=on yielded 0, relaxed yielded ${candidateEntries.length}`,
      );
    }
  }
  if (reportType === 'papers' && candidateEntries.length > PAPERS_MAX_SUMMARY_ITEMS) {
    candidateEntries = [...candidateEntries]
      .sort((a, b) => (
        b.score - a.score
        || b.matchedInterests.length - a.matchedInterests.length
        || (new Date(articleById.get(b.entry.id)?.publishedAt || '').getTime()
          - new Date(articleById.get(a.entry.id)?.publishedAt || '').getTime())
      ))
      .slice(0, PAPERS_MAX_SUMMARY_ITEMS);
    log.info(
      `[${userId}] papers candidate cap applied (${projectLabel}):`
      + ` ${relevance.passed.length} -> ${candidateEntries.length}`,
    );
  }
  if (reportType === 'papers' && candidateEntries.length === 0 && relevanceInputEntries.length > 0) {
    // Last-resort fallback for curated paper feeds: include latest entries to avoid empty report on scoring anomalies.
    candidateEntries = [...relevanceInputEntries]
      .sort((a, b) => {
        const aDate = articleById.get(a.id)?.publishedAt || '';
        const bDate = articleById.get(b.id)?.publishedAt || '';
        return new Date(bDate).getTime() - new Date(aDate).getTime();
      })
      .slice(0, PAPERS_FALLBACK_ITEMS)
      .map(entry => ({ entry, score: PAPERS_RELEVANCE_THRESHOLD, matchedInterests: [] }));
    log.warn(
      `[${userId}] papers relevance produced 0 candidates (${projectLabel});`
      + ` using fallback latest ${candidateEntries.length} entries.`,
    );
  }

  const summarizedItems: DailyReportItem[] = [];

  for (const candidate of candidateEntries) {
    const entry = candidate.entry;
    try {
      const enriched = await enrichEntry(entry);
      entry.enrichedContent = enriched.enrichedContent;
      const summary = await summarizeEntry(entry, settings);
      if (!summary) continue;

      const article = articleById.get(entry.id);
      if (!article) continue;

      summarizedItems.push({
        title: summary.translated_title || entry.title,
        source: entry.feedName,
        link: entry.link,
        interestTags: normalizeInterestTags(reportType, candidate.matchedInterests, article),
        whatHappened: summary.what_happened,
        whyItMatters: summary.why_it_matters,
        keyDetail: summary.key_detail,
        publishedAt: article.publishedAt,
      });
    } catch (err) {
      log.warn(`[${userId}] Failed to process ${reportType} entry ${entry.id} (${projectLabel}): ${err}`);
      if (!project && reportType === 'papers') {
        const article = articleById.get(entry.id);
        if (!article) continue;
        const snippet = (entry.snippet || '').trim();
        summarizedItems.push({
          title: entry.title,
          source: entry.feedName,
          link: entry.link,
          interestTags: normalizeInterestTags(reportType, candidate.matchedInterests, article),
          whatHappened: snippet || 'Özet üretilemedi, başlık ve bağlantı üzerinden takip edebilirsiniz.',
          whyItMatters: 'Bu makale seçili arXiv kaynaklarından geldi. AI kota/hata nedeniyle detaylı özet üretilemedi.',
          keyDetail: 'Fallback kayıt: detaylı özet yerine temel bilgi eklendi.',
          publishedAt: article.publishedAt,
        });
      }
    }
  }

  summarizedItems.sort((a, b) => new Date(b.publishedAt).getTime() - new Date(a.publishedAt).getTime());
  const emptyReason = resolveEmptyReason(
    reportType,
    lookbackDays,
    filtered.length,
    candidateEntries.length,
    summarizedItems.length,
  );

  const scopedReports = buildReportScopes(
    summarizedItems,
    settings.reportGroupingMode,
    effectiveInterests,
    project ? projectScopeLabel(project) : undefined,
  );

  for (const scope of scopedReports) {
    const scopeEmptyReason = scope.items.length === 0 ? emptyReason : undefined;
    const existing = findReport(userId, reportDate, reportType, scope.scopeType, scope.scopeValue);
    if (existing) {
      await persistReportLinkToMammoth(userId, {
        reportType,
        reportDate,
        scopeType: scope.scopeType,
        scopeValue: scope.scopeValue,
        notionPageId: existing.notionPageId,
        notionUrl: existing.notionUrl,
        timezone: settings.reportTimezone,
      });

      const prev = getReportState(state, reportDate, reportType, scope.scopeType, scope.scopeValue);
      upsertDailyReport(state, {
        reportDate,
        reportType,
        scopeType: scope.scopeType,
        scopeValue: scope.scopeValue,
        notionPageId: existing.notionPageId,
        notionUrl: existing.notionUrl,
        generatedAt: Date.now(),
        itemCount: prev?.itemCount,
        emptyReason: prev?.emptyReason,
        sendRetryCount: prev?.sendRetryCount ?? 0,
        sentAt: prev?.sentAt,
        lastSendError: prev?.lastSendError,
      });
      saveSchedulerStates(schedulerStates);
      log.info(`[${userId}] Existing ${reportType}/${scope.scopeType}:${scope.scopeValue} report reused (${projectLabel}) for ${reportDate}: ${existing.notionUrl}`);
      continue;
    }

    const payload: DailyReportPayload = {
      reportDate,
      reportType,
      scopeType: scope.scopeType,
      scopeValue: scope.scopeValue,
      lookbackDays,
      timezone: settings.reportTimezone,
      generatedAtIso: new Date().toISOString(),
      items: scope.items,
      emptyReason: scopeEmptyReason,
    };

    const notionReport = await createNotionReportWithAutoClean(userId, state, settings, payload);

    await persistReportToMammoth(userId, payload, notionReport);

    upsertDailyReport(state, {
      reportDate,
      reportType,
      scopeType: scope.scopeType,
      scopeValue: scope.scopeValue,
      notionPageId: notionReport.pageId,
      notionUrl: notionReport.url,
      generatedAt: Date.now(),
      itemCount: scope.items.length,
      emptyReason: scopeEmptyReason,
      sendRetryCount: 0,
      sentAt: undefined,
      lastSendError: undefined,
    });

    saveSchedulerStates(schedulerStates);
    if (scope.items.length === 0 && scopeEmptyReason) {
      log.warn(`[${userId}] ${reportType}/${scope.scopeType}:${scope.scopeValue} report is empty (${projectLabel}, ${reportDate}): ${scopeEmptyReason}`);
    }
    log.info(`[${userId}] ${reportType}/${scope.scopeType}:${scope.scopeValue} report generated (${projectLabel}) for ${reportDate}: ${notionReport.url}`);
  }
}

async function processDailyScan(userId: string, state: SchedulerState, reportDate: string): Promise<void> {
  const settings = requireDailySettings(userId);

  const { news, papers } = splitFeedsByReportType(settings);
  const errors: string[] = [];
  let anySuccess = false;

  let newsArticles: Article[] = [];
  let paperArticles: Article[] = [];
  let newsFetched = false;
  let papersFetched = false;

  if (news.length > 0) {
    try {
      newsArticles = await fetchArticlesForFeedsSequential(news, `news:${userId}`);
      newsFetched = true;
    } catch (err) {
      const message = `news fetch failed (${userId}): ${String(err)}`;
      errors.push(message);
      log.error(message, err);
    }
  }

  if (papers.length > 0) {
    try {
      paperArticles = await fetchArticlesForFeedsSequential(papers, `papers:${userId}`);
      papersFetched = true;
    } catch (err) {
      const message = `papers fetch failed (${userId}): ${String(err)}`;
      errors.push(message);
      log.error(message, err);
    }
  }

  if (newsFetched) {
    try {
      await processSingleReport(userId, state, settings, 'news', reportDate, newsArticles);
      anySuccess = true;
    } catch (err) {
      const message = `news report failed (${userId}): ${String(err)}`;
      errors.push(message);
      log.error(message, err);
    }
  }

  if (papersFetched) {
    try {
      await processSingleReport(userId, state, settings, 'papers', reportDate, paperArticles);
      anySuccess = true;
    } catch (err) {
      const message = `papers report failed (${userId}): ${String(err)}`;
      errors.push(message);
      log.error(message, err);
    }
  }

  const projectProfiles = (settings.specialProjects || []).filter(project => (
    project.enabled
    && (
      (Array.isArray(project.feeds) && project.feeds.some(feed => feed.enabled))
      || project.includeNews
      || project.includePapers
    )
  ));

  for (const project of projectProfiles) {
    const projectRuntimeFeeds = Array.isArray(project.feeds)
      ? project.feeds.filter(feed => feed.enabled)
      : [];
    const hasProjectFeeds = projectRuntimeFeeds.length > 0;

    if (!hasProjectFeeds) {
      if (project.includeNews && newsFetched) {
        try {
          await processSingleReport(userId, state, settings, 'news', reportDate, newsArticles, project);
          anySuccess = true;
        } catch (err) {
          const message = `project news report failed (${userId}/${project.id}): ${String(err)}`;
          errors.push(message);
          log.error(message, err);
        }
      }

      if (project.includePapers && papersFetched) {
        try {
          await processSingleReport(userId, state, settings, 'papers', reportDate, paperArticles, project);
          anySuccess = true;
        } catch (err) {
          const message = `project papers report failed (${userId}/${project.id}): ${String(err)}`;
          errors.push(message);
          log.error(message, err);
        }
      }
      continue;
    }

    const { news: projectNewsFeeds, papers: projectPaperFeeds } = splitRuntimeFeedsByReportType(projectRuntimeFeeds);

    if (projectNewsFeeds.length > 0) {
      try {
        const projectNewsArticles = await fetchArticlesForFeedsSequential(projectNewsFeeds, `project-news:${userId}:${project.id}`);
        await processSingleReport(userId, state, settings, 'news', reportDate, projectNewsArticles, project);
        anySuccess = true;
      } catch (err) {
        const message = `project news report failed (${userId}/${project.id}): ${String(err)}`;
        errors.push(message);
        log.error(message, err);
      }
    }

    if (projectPaperFeeds.length > 0) {
      try {
        const projectPaperArticles = await fetchArticlesForFeedsSequential(projectPaperFeeds, `project-papers:${userId}:${project.id}`);
        await processSingleReport(userId, state, settings, 'papers', reportDate, projectPaperArticles, project);
        anySuccess = true;
      } catch (err) {
        const message = `project papers report failed (${userId}/${project.id}): ${String(err)}`;
        errors.push(message);
        log.error(message, err);
      }
    }
  }

  if (!anySuccess) {
    throw new Error(errors.join(' | ') || 'daily scan failed for all pipelines');
  }
}

async function processDailySend(userId: string, state: SchedulerState, sendRunDate: string): Promise<void> {
  const settings = getRuntimeSettings(userId);
  if (!settings.telegramBotToken || !settings.telegramChatId) {
    throw new Error(`TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID are required for Telegram sending (user=${userId})`);
  }

  const maxDate = shiftDate(sendRunDate, -1);
  const pending = getUnsentReportsUpTo(state, maxDate);

  if (pending.length === 0) {
    log.info(`[${userId}] No pending reports to send for ${sendRunDate}`);
    return;
  }

  for (const report of pending) {
    try {
      await sendDailyReportLink(
        settings.telegramBotToken,
        settings.telegramChatId,
        report.reportType,
        report.scopeType,
        report.scopeValue,
        report.reportDate,
        report.notionUrl,
        settings.assistantGreeting,
        settings.assistantSignature,
        report.itemCount,
        report.emptyReason,
      );
      report.sentAt = Date.now();
      report.lastSendError = undefined;
      log.info(`[${userId}] Telegram ${report.reportType}/${report.scopeType}:${report.scopeValue} report sent for ${report.reportDate}`);
    } catch (err) {
      report.sendRetryCount += 1;
      report.lastSendError = String(err);
      log.error(`[${userId}] Telegram send failed for ${report.reportType}/${report.scopeType}:${report.scopeValue} ${report.reportDate}`, err);
    }
  }

  saveSchedulerStates(schedulerStates);
}

async function tryRunScan(userId: string, runDate: string): Promise<void> {
  if (scanRunningUsers.has(userId)) return;
  scanRunningUsers.add(userId);
  try {
    await runUserExclusive(userId, 'scan', runDate, async () => {
      let success = false;
      const state = getUserState(userId);

      try {
        await processDailyScan(userId, state, runDate);
        success = true;
      } catch (err) {
        log.error(`[${userId}] Daily scan failed for ${runDate}`, err);
        state.scanRetryDate = runDate;
        state.scanRetryAfterMs = Date.now() + RETRY_DELAY_MS;
      } finally {
        if (success) {
          state.lastScanRunDate = runDate;
          state.scanRetryDate = undefined;
          state.scanRetryAfterMs = undefined;
        }
        saveSchedulerStates(schedulerStates);
      }
    });
  } finally {
    scanRunningUsers.delete(userId);
  }
}

async function tryRunSend(userId: string, runDate: string): Promise<void> {
  if (sendRunningUsers.has(userId)) return;
  sendRunningUsers.add(userId);
  try {
    await runUserExclusive(userId, 'send', runDate, async () => {
      let success = false;
      const state = getUserState(userId);

      try {
        await processDailySend(userId, state, runDate);
        success = true;
      } catch (err) {
        log.error(`[${userId}] Daily send failed for ${runDate}`, err);
        state.sendRetryAfterMs = Date.now() + RETRY_DELAY_MS;
      } finally {
        const pendingAfter = getUnsentReportsUpTo(state, shiftDate(runDate, -1)).length;
        if (success && pendingAfter === 0) {
          state.sendRetryAfterMs = undefined;
        } else if (pendingAfter > 0) {
          state.sendRetryAfterMs = Date.now() + RETRY_DELAY_MS;
        } else {
          state.sendRetryAfterMs = undefined;
        }

        state.lastSendRunDate = runDate;
        saveSchedulerStates(schedulerStates);
      }
    });
  } finally {
    sendRunningUsers.delete(userId);
  }
}

function runSchedulerTickForUser(userId: string, catchUp = false): void {
  const state = getUserState(userId);
  const settings = getRuntimeSettings(userId);
  const now = getZonedNow(settings.reportTimezone);
  const nowMs = Date.now();
  const reportPeriodDays = Math.max(1, settings.reportPeriodDays || 1);

  const retryScanDue = state.scanRetryDate === now.date
    && (state.scanRetryAfterMs ?? Number.MAX_SAFE_INTEGER) <= nowMs;
  const scanRetryBlocked = state.scanRetryDate === now.date
    && (state.scanRetryAfterMs ?? 0) > nowMs;
  const scanDueByPeriod = !state.lastScanRunDate
    || dayDiff(state.lastScanRunDate, now.date) >= reportPeriodDays;

  const shouldRunScan = (
    now.time === settings.dailyScanTime
    || (catchUp && isTimeReached(now.time, settings.dailyScanTime))
    || retryScanDue
  ) && scanDueByPeriod
    && state.lastScanRunDate !== now.date
    && !scanRetryBlocked;

  const maxSendDate = shiftDate(now.date, -1);
  const pendingSendCount = getUnsentReportsUpTo(state, maxSendDate).length;
  const retrySendDue = pendingSendCount > 0
    && (state.sendRetryAfterMs ?? Number.MAX_SAFE_INTEGER) <= nowMs;

  const shouldRunSend = (
    now.time === settings.dailySendTime
    || (catchUp && isTimeReached(now.time, settings.dailySendTime))
    || retrySendDue
  ) && (
    state.lastSendRunDate !== now.date
    || retrySendDue
  );

  if (shouldRunScan) {
    void tryRunScan(userId, now.date);
  }

  if (shouldRunSend) {
    void tryRunSend(userId, now.date);
  }
}

function runSchedulerTick(catchUp = false): void {
  syncUserContexts();
  void ensureMammothReady('scheduler-tick');
  const users = listUsers();
  for (const user of users) {
    runSchedulerTickForUser(user.id, catchUp);
  }
}

function setupShutdown(): void {
  const shutdown = (signal: string) => {
    log.info(`Received ${signal}, shutting down...`);
    void (async () => {
      if (mammothStore) {
        try {
          await mammothStore.close();
        } catch (err) {
          log.warn(`Failed to close Mammoth store on shutdown: ${err}`);
        }
      }
      process.exit(0);
    })();
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

async function main(): Promise<void> {
  const args = parseArgs();
  runtimeConfig.language = args.lang;

  validateStartupConfig();
  setupShutdown();

  log.info('FeedLedger multi-user daily scheduler starting...');
  for (const user of listUsers()) {
    const settings = getRuntimeSettings(user.id);
    log.info(`[${user.id}] schedule: scan=${settings.dailyScanTime}, send=${settings.dailySendTime}, timezone=${settings.reportTimezone}, periodDays=${settings.reportPeriodDays}`);
  }

  await configureMammothStore();
  await syncReportIndexToMammoth('startup');

  startAdminPanel({
    getMammothStore: () => mammothStore,
    onSettingsUpdated: (userId) => {
      const next = getRuntimeSettings(userId);
      log.info(`[${userId}] Runtime settings updated from admin panel (scan=${next.dailyScanTime}, send=${next.dailySendTime}, tz=${next.reportTimezone}, periodDays=${next.reportPeriodDays})`);
      if (userId === 'admin') {
        void (async () => {
          await configureMammothStore();
          await syncReportIndexToMammoth('admin-settings-update');
        })();
      }
      runSchedulerTick(true);
    },
  });

  runSchedulerTick(true);
  setInterval(() => runSchedulerTick(false), 30_000);
}

main().catch((err) => {
  log.error('Fatal error', err);
  process.exit(1);
});
