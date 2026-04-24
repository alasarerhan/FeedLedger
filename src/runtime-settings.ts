import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { config } from './config.js';
import { createLogger } from './logger.js';

const log = createLogger('runtime-settings');

export type AIProvider = 'gemini' | 'openrouter';
export type RuntimeFeedGroup = 'news' | 'papers';
export type ReportGroupingMode = 'single' | 'by_interest';

export interface RuntimeSpecialProject {
  id: string;
  name: string;
  enabled: boolean;
  interests: string[];
  prompt: string;
  feeds: RuntimeFeed[];
  includeNews: boolean;
  includePapers: boolean;
  strictInterestMatch: boolean;
}

export interface RuntimeFeed {
  id: string;
  name: string;
  url: string;
  group: RuntimeFeedGroup;
  interestHint: string;
  priority: 'high' | 'normal';
  enabled: boolean;
}

export interface RuntimeSettings {
  aiProvider: AIProvider;
  geminiApiKey: string;
  geminiModel: string;
  openrouterApiKey: string;
  openrouterModel: string;
  notionApiKey: string;
  notionParentPageId: string;
  telegramBotToken: string;
  telegramChatId: string;
  mammothEnabled: boolean;
  mammothUri: string;
  mammothDatabase: string;
  reportTimezone: string;
  dailyScanTime: string;
  dailySendTime: string;
  reportPeriodDays: number;
  assistantGreeting: string;
  assistantSignature: string;
  notionQuotaAutoclean: boolean;
  interests: string[];
  feeds: RuntimeFeed[];
  reportGroupingMode: ReportGroupingMode;
  specialProjects: RuntimeSpecialProject[];
}

export interface PanelRuntimeSettings extends RuntimeSettings {
  panelHost: string;
  panelPort: number;
}

type PersistedSettings = Partial<RuntimeSettings>;

interface RuntimeSettingsFile {
  version: number;
  users: Record<string, PersistedSettings>;
}

const RUNTIME_CONFIG_FILE = join(config.dataDir, 'runtime-config.json');
const SETTINGS_FILE_VERSION = 2;

export const GEMINI_MODEL_OPTIONS = [
  'gemini-3-pro-preview',
  'gemini-3-flash-preview',
  'gemini-2.5-pro',
  'gemini-2.5-flash',
  'gemini-2.5-flash-lite',
  'gemini-2.0-flash',
  'gemini-flash-latest',
] as const;

export const OPENROUTER_MODEL_OPTIONS = [
  // DeepSeek
  'deepseek/deepseek-v3.2-speciale',
  'deepseek/deepseek-chat-v3-0324',
  'deepseek/deepseek-r1',
  // OpenAI
  'openai/gpt-4.1',
  'openai/gpt-4.1-mini',
  'openai/gpt-4o',
  'openai/gpt-4o-mini',
  // Anthropic
  'anthropic/claude-sonnet-4',
  'anthropic/claude-3.7-sonnet',
  'anthropic/claude-3.5-haiku',
  // Google via OpenRouter
  'google/gemini-2.5-pro',
  'google/gemini-2.5-flash',
  // Meta / xAI / Mistral / Qwen
  'meta-llama/llama-3.3-70b-instruct',
  'x-ai/grok-3-mini-beta',
  'mistralai/mistral-large',
  'qwen/qwen-2.5-72b-instruct',
] as const;

export const TIMEZONE_OPTIONS = [
  'Europe/Istanbul',
  'UTC',
  'Europe/London',
  'Europe/Berlin',
  'America/New_York',
  'America/Los_Angeles',
  'Asia/Dubai',
  'Asia/Tokyo',
] as const;

export const SCHEDULE_TIME_PRESETS = [
  '06:00',
  '08:00',
  '12:00',
  '18:00',
  '23:45',
] as const;

export const REPORT_PERIOD_DAY_OPTIONS = [1, 2, 3, 7, 14, 30] as const;

export const INTEREST_PRESET_OPTIONS = [
  'Artificial Intelligence',
  'Machine Learning',
  'LLM',
  'NLP',
  'Computer Vision',
  'Robotics',
  'AI Hardware',
  'Cybersecurity',
  'Cloud',
  'Fintech',
  'Healthcare Tech',
  'Developer Tools',
] as const;

export const REPORT_GROUPING_MODE_OPTIONS = ['single', 'by_interest'] as const;

function makeFeedId(name: string, url: string, index: number): string {
  const slug = `${name}-${index + 1}`
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || `feed-${index + 1}`;
  return `${slug}-${Math.abs(hashCode(url)).toString(36).slice(0, 6)}`;
}

function hashCode(value: string): number {
  let hash = 0;
  for (let i = 0; i < value.length; i += 1) {
    hash = ((hash << 5) - hash) + value.charCodeAt(i);
    hash |= 0;
  }
  return hash;
}

function makeProjectId(name: string, index: number): string {
  const slug = `${name}-${index + 1}`
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || `project-${index + 1}`;
  return `${slug}-${Math.abs(hashCode(name)).toString(36).slice(0, 6)}`;
}

function defaultRuntimeFeedsFromConfig(): RuntimeFeed[] {
  return config.feeds.map((feed, index) => ({
    id: makeFeedId(feed.name, feed.url, index),
    name: feed.name,
    url: feed.url,
    group: feed.kind === 'research' ? 'papers' : 'news',
    interestHint: '',
    priority: feed.priority,
    enabled: true,
  }));
}

function normalizeInterestList(input: unknown[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];

  for (const value of input) {
    if (typeof value !== 'string') continue;
    const clean = value.trim().replace(/\s+/g, ' ');
    if (!clean) continue;
    const key = clean.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(clean);
    if (out.length >= 80) break;
  }

  return out;
}

function deriveFeedNameFromUrl(url: string): string {
  const cleanUrl = url.trim();
  if (!cleanUrl) return 'Untitled Feed';

  try {
    const parsed = new URL(cleanUrl);
    const host = parsed.hostname.replace(/^www\./i, '');
    const hostParts = host.split('.').filter(Boolean);
    const hostCore = hostParts.length >= 2 ? hostParts[hostParts.length - 2] : (hostParts[0] || host);
    const pathParts = parsed.pathname.split('/').map(part => part.trim()).filter(Boolean);
    const pathCore = pathParts.find((part) => {
      const lower = part.toLowerCase();
      return lower !== 'rss' && lower !== 'feed' && lower !== 'feeds' && lower !== 'index.xml' && lower !== 'xml';
    }) || '';
    const raw = `${hostCore} ${pathCore}`.trim() || host;
    return raw
      .replace(/[-_]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .replace(/\b\w/g, char => char.toUpperCase());
  } catch {
    return cleanUrl
      .replace(/^https?:\/\//i, '')
      .split('/')[0]
      .replace(/^www\./i, '')
      .trim() || 'Untitled Feed';
  }
}

function normalizeFeedList(input: unknown[]): RuntimeFeed[] {
  const seen = new Set<string>();
  const out: RuntimeFeed[] = [];

  for (let i = 0; i < input.length; i += 1) {
    const raw = input[i];
    if (!raw || typeof raw !== 'object') continue;
    const item = raw as Partial<RuntimeFeed>;

    const rawName = typeof item.name === 'string' ? item.name.trim() : '';
    const url = typeof item.url === 'string' ? item.url.trim() : '';
    const group = item.group === 'papers' ? 'papers' : item.group === 'news' ? 'news' : null;
    const interestHint = typeof item.interestHint === 'string'
      ? item.interestHint.trim().replace(/\s+/g, ' ')
      : '';
    const priority = item.priority === 'high' ? 'high' : item.priority === 'normal' ? 'normal' : 'normal';
    const enabled = typeof item.enabled === 'boolean' ? item.enabled : true;
    if (!url || !group) continue;

    try {
      const parsed = new URL(url);
      if (!['http:', 'https:'].includes(parsed.protocol)) continue;
    } catch {
      continue;
    }

    const name = rawName || deriveFeedNameFromUrl(url) || `Feed ${i + 1}`;
    const dedupKey = `${url.toLowerCase()}|${group}`;
    if (seen.has(dedupKey)) continue;
    seen.add(dedupKey);

    const id = typeof item.id === 'string' && item.id.trim()
      ? item.id.trim()
      : makeFeedId(name, url, i);

    out.push({
      id,
      name,
      url,
      group,
      interestHint,
      priority,
      enabled,
    });

    if (out.length >= 300) break;
  }

  return out;
}

function normalizeSpecialProjects(input: unknown[]): RuntimeSpecialProject[] {
  const seen = new Set<string>();
  const out: RuntimeSpecialProject[] = [];

  for (let i = 0; i < input.length; i += 1) {
    const raw = input[i];
    if (!raw || typeof raw !== 'object') continue;
    const item = raw as Partial<RuntimeSpecialProject>;

    const name = typeof item.name === 'string'
      ? item.name.trim().replace(/\s+/g, ' ')
      : '';
    if (!name) continue;

    const interests = normalizeInterestList(
      Array.isArray(item.interests) ? item.interests : [],
    );
    const feeds = normalizeFeedList(
      Array.isArray((item as any).feeds) ? (item as any).feeds : [],
    );
    const prompt = typeof (item as any).prompt === 'string'
      ? (item as any).prompt.trim()
      : '';
    const hasNewsFeed = feeds.some(feed => feed.group === 'news');
    const hasPaperFeed = feeds.some(feed => feed.group === 'papers');

    const id = typeof item.id === 'string' && item.id.trim()
      ? item.id.trim()
      : makeProjectId(name, i);
    if (seen.has(id)) continue;
    seen.add(id);

    out.push({
      id,
      name,
      enabled: typeof item.enabled === 'boolean' ? item.enabled : true,
      interests,
      prompt,
      feeds,
      includeNews: typeof item.includeNews === 'boolean' ? item.includeNews : (hasNewsFeed || !hasPaperFeed),
      includePapers: typeof item.includePapers === 'boolean' ? item.includePapers : (hasPaperFeed || !hasNewsFeed),
      strictInterestMatch: typeof item.strictInterestMatch === 'boolean' ? item.strictInterestMatch : true,
    });

    if (out.length >= 20) break;
  }

  return out;
}

const DEFAULT_SETTINGS: RuntimeSettings = {
  aiProvider: config.aiProvider,
  geminiApiKey: config.geminiApiKey,
  geminiModel: process.env.GEMINI_MODEL || 'gemini-2.5-flash',
  openrouterApiKey: config.openrouterApiKey,
  openrouterModel: config.openrouterModel,
  notionApiKey: process.env.NOTION_API_KEY || '',
  notionParentPageId: process.env.NOTION_PARENT_PAGE_ID || '',
  telegramBotToken: process.env.TELEGRAM_BOT_TOKEN || '',
  telegramChatId: process.env.TELEGRAM_CHAT_ID || '',
  mammothEnabled: (process.env.MAMMOTH_ENABLED || 'true').toLowerCase() !== 'false',
  mammothUri: process.env.MAMMOTH_URI || 'mongodb://127.0.0.1:27017',
  mammothDatabase: process.env.MAMMOTH_DATABASE || 'feedledger',
  reportTimezone: process.env.REPORT_TIMEZONE || 'Europe/Istanbul',
  dailyScanTime: process.env.DAILY_SCAN_TIME || '23:45',
  dailySendTime: process.env.DAILY_SEND_TIME || '06:00',
  reportPeriodDays: REPORT_PERIOD_DAY_OPTIONS.includes(
    Number(process.env.REPORT_PERIOD_DAYS) as (typeof REPORT_PERIOD_DAY_OPTIONS)[number],
  )
    ? Number(process.env.REPORT_PERIOD_DAYS)
    : 1,
  assistantGreeting: process.env.ASSISTANT_GREETING || 'Günaydın Patron',
  assistantSignature: process.env.ASSISTANT_SIGNATURE || 'FeedLedger Asistanın',
  notionQuotaAutoclean: (process.env.NOTION_QUOTA_AUTOCLEAN || 'true').toLowerCase() !== 'false',
  interests: normalizeInterestList(
    (process.env.INTEREST_TOPICS || 'Artificial Intelligence,Machine Learning')
      .split(',')
      .map(v => v.trim()),
  ),
  feeds: defaultRuntimeFeedsFromConfig(),
  reportGroupingMode: (process.env.REPORT_GROUPING_MODE || 'single') === 'by_interest' ? 'by_interest' : 'single',
  specialProjects: normalizeSpecialProjects(
    (() => {
      try {
        const raw = process.env.SPECIAL_PROJECTS_JSON || '[]';
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed : [];
      } catch {
        return [];
      }
    })(),
  ),
};

const PANEL_DEFAULTS = {
  panelHost: process.env.PANEL_HOST || '127.0.0.1',
  panelPort: parseInt(process.env.PANEL_PORT || '8897', 10),
};

let runtimeSettingsByUser: Record<string, RuntimeSettings> = {};
let persistedByUser: Record<string, PersistedSettings> = {};

type SettingsListener = (userId: string, settings: RuntimeSettings) => void;
const listeners = new Set<SettingsListener>();

function isGeminiModelOption(model: string): boolean {
  return GEMINI_MODEL_OPTIONS.includes(model as (typeof GEMINI_MODEL_OPTIONS)[number]);
}

function isValidTime(value: string): boolean {
  return /^([01]\d|2[0-3]):([0-5]\d)$/.test(value);
}

function validateTimezone(tz: string): boolean {
  try {
    Intl.DateTimeFormat('en-US', { timeZone: tz }).format(new Date());
    return true;
  } catch {
    return false;
  }
}

function sanitizePatch(patch: PersistedSettings): PersistedSettings {
  const next: PersistedSettings = {};

  if (patch.aiProvider === 'gemini' || patch.aiProvider === 'openrouter') {
    next.aiProvider = patch.aiProvider;
  }

  if (typeof patch.geminiApiKey === 'string') next.geminiApiKey = patch.geminiApiKey;
  if (typeof patch.openrouterApiKey === 'string') next.openrouterApiKey = patch.openrouterApiKey;
  if (typeof patch.openrouterModel === 'string') next.openrouterModel = patch.openrouterModel;
  if (typeof patch.notionApiKey === 'string') next.notionApiKey = patch.notionApiKey;
  if (typeof patch.notionParentPageId === 'string') next.notionParentPageId = patch.notionParentPageId;
  if (typeof patch.telegramBotToken === 'string') next.telegramBotToken = patch.telegramBotToken;
  if (typeof patch.telegramChatId === 'string') next.telegramChatId = patch.telegramChatId;
  if (typeof patch.mammothUri === 'string') next.mammothUri = patch.mammothUri.trim();
  if (typeof patch.mammothDatabase === 'string') next.mammothDatabase = patch.mammothDatabase.trim();
  if (typeof patch.mammothEnabled === 'boolean') next.mammothEnabled = patch.mammothEnabled;
  if (typeof patch.assistantGreeting === 'string') next.assistantGreeting = patch.assistantGreeting.trim();
  if (typeof patch.assistantSignature === 'string') next.assistantSignature = patch.assistantSignature.trim();
  if (typeof patch.notionQuotaAutoclean === 'boolean') next.notionQuotaAutoclean = patch.notionQuotaAutoclean;

  if (patch.reportGroupingMode === 'single' || patch.reportGroupingMode === 'by_interest') {
    next.reportGroupingMode = patch.reportGroupingMode;
  }

  if (Array.isArray(patch.interests)) {
    next.interests = normalizeInterestList(patch.interests);
  }

  if (Array.isArray(patch.feeds)) {
    next.feeds = normalizeFeedList(patch.feeds);
  }

  if (Array.isArray(patch.specialProjects)) {
    next.specialProjects = normalizeSpecialProjects(patch.specialProjects);
  }

  if (typeof patch.geminiModel === 'string' && isGeminiModelOption(patch.geminiModel)) {
    next.geminiModel = patch.geminiModel;
  }

  if (typeof patch.reportTimezone === 'string' && validateTimezone(patch.reportTimezone)) {
    next.reportTimezone = patch.reportTimezone;
  }

  if (typeof patch.dailyScanTime === 'string' && isValidTime(patch.dailyScanTime)) {
    next.dailyScanTime = patch.dailyScanTime;
  }

  if (typeof patch.dailySendTime === 'string' && isValidTime(patch.dailySendTime)) {
    next.dailySendTime = patch.dailySendTime;
  }

  if (
    typeof patch.reportPeriodDays === 'number'
    && REPORT_PERIOD_DAY_OPTIONS.includes(patch.reportPeriodDays as (typeof REPORT_PERIOD_DAY_OPTIONS)[number])
  ) {
    next.reportPeriodDays = patch.reportPeriodDays;
  }

  return next;
}

function normalizePersistedUsers(input: Record<string, unknown>): Record<string, PersistedSettings> {
  const output: Record<string, PersistedSettings> = {};
  for (const [userId, settings] of Object.entries(input)) {
    if (!userId || typeof settings !== 'object' || settings === null) continue;
    output[userId] = sanitizePatch(settings as PersistedSettings);
  }
  return output;
}

function loadPersistedSettingsByUser(): Record<string, PersistedSettings> {
  try {
    if (!existsSync(RUNTIME_CONFIG_FILE)) return {};
    const raw = JSON.parse(readFileSync(RUNTIME_CONFIG_FILE, 'utf-8')) as unknown;

    if (raw && typeof raw === 'object') {
      const typed = raw as Partial<RuntimeSettingsFile> & Record<string, unknown>;
      if (typed.version === SETTINGS_FILE_VERSION && typed.users && typeof typed.users === 'object') {
        return normalizePersistedUsers(typed.users as Record<string, unknown>);
      }

      // Legacy single-user config migration -> assign to admin
      return { admin: sanitizePatch(typed as PersistedSettings) };
    }

    return {};
  } catch (err) {
    log.warn(`Failed to load runtime config, using defaults: ${err}`);
    return {};
  }
}

function savePersistedSettingsByUser(users: Record<string, PersistedSettings>): void {
  try {
    mkdirSync(config.dataDir, { recursive: true });
    const tmp = `${RUNTIME_CONFIG_FILE}.tmp`;
    const payload: RuntimeSettingsFile = {
      version: SETTINGS_FILE_VERSION,
      users,
    };
    writeFileSync(tmp, JSON.stringify(payload, null, 2), 'utf-8');
    renameSync(tmp, RUNTIME_CONFIG_FILE);
  } catch (err) {
    log.error('Failed to save runtime config', err);
    throw err;
  }
}

function mergedSettings(base: RuntimeSettings, patch: PersistedSettings): RuntimeSettings {
  const cleanPatch = sanitizePatch(patch);
  const mergedFeeds = Array.isArray(cleanPatch.feeds)
    ? cleanPatch.feeds
    : base.feeds;

  const merged: RuntimeSettings = {
    ...base,
    ...cleanPatch,
    geminiModel: cleanPatch.geminiModel && isGeminiModelOption(cleanPatch.geminiModel)
      ? cleanPatch.geminiModel
      : base.geminiModel,
    reportTimezone: cleanPatch.reportTimezone && validateTimezone(cleanPatch.reportTimezone)
      ? cleanPatch.reportTimezone
      : base.reportTimezone,
    dailyScanTime: cleanPatch.dailyScanTime && isValidTime(cleanPatch.dailyScanTime)
      ? cleanPatch.dailyScanTime
      : base.dailyScanTime,
    dailySendTime: cleanPatch.dailySendTime && isValidTime(cleanPatch.dailySendTime)
      ? cleanPatch.dailySendTime
      : base.dailySendTime,
    reportPeriodDays: cleanPatch.reportPeriodDays && REPORT_PERIOD_DAY_OPTIONS.includes(cleanPatch.reportPeriodDays as (typeof REPORT_PERIOD_DAY_OPTIONS)[number])
      ? cleanPatch.reportPeriodDays
      : base.reportPeriodDays,
    mammothUri: cleanPatch.mammothUri && cleanPatch.mammothUri.length > 0
      ? cleanPatch.mammothUri
      : base.mammothUri,
    mammothDatabase: cleanPatch.mammothDatabase && cleanPatch.mammothDatabase.length > 0
      ? cleanPatch.mammothDatabase
      : base.mammothDatabase,
    assistantGreeting: cleanPatch.assistantGreeting && cleanPatch.assistantGreeting.length > 0
      ? cleanPatch.assistantGreeting
      : base.assistantGreeting,
    assistantSignature: cleanPatch.assistantSignature && cleanPatch.assistantSignature.length > 0
      ? cleanPatch.assistantSignature
      : base.assistantSignature,
    interests: Array.isArray(cleanPatch.interests)
      ? cleanPatch.interests
      : base.interests,
    feeds: mergedFeeds.length > 0 ? mergedFeeds : base.feeds,
    reportGroupingMode: cleanPatch.reportGroupingMode || base.reportGroupingMode,
    specialProjects: Array.isArray(cleanPatch.specialProjects)
      ? cleanPatch.specialProjects
      : base.specialProjects,
  };

  return merged;
}

function notify(userId: string): void {
  const settings = runtimeSettingsByUser[userId];
  if (!settings) return;
  for (const listener of listeners) {
    listener(userId, settings);
  }
}

export function initializeRuntimeSettings(userIds: string[] = ['admin']): Record<string, RuntimeSettings> {
  persistedByUser = loadPersistedSettingsByUser();

  for (const userId of userIds) {
    if (!persistedByUser[userId]) {
      persistedByUser[userId] = {};
    }
  }

  const nextSettings: Record<string, RuntimeSettings> = {};
  for (const [userId, patch] of Object.entries(persistedByUser)) {
    nextSettings[userId] = mergedSettings(DEFAULT_SETTINGS, patch);
  }

  runtimeSettingsByUser = nextSettings;
  savePersistedSettingsByUser(persistedByUser);
  return runtimeSettingsByUser;
}

export function ensureRuntimeSettingsForUsers(userIds: string[]): void {
  let changed = false;
  for (const userId of userIds) {
    if (!persistedByUser[userId]) {
      persistedByUser[userId] = {};
      runtimeSettingsByUser[userId] = mergedSettings(DEFAULT_SETTINGS, {});
      changed = true;
    }
  }
  if (changed) {
    savePersistedSettingsByUser(persistedByUser);
  }
}

export function removeRuntimeSettingsForUser(userId: string): void {
  if (!persistedByUser[userId]) return;
  delete persistedByUser[userId];
  delete runtimeSettingsByUser[userId];
  savePersistedSettingsByUser(persistedByUser);
}

export function getRuntimeSettings(userId = 'admin'): RuntimeSettings {
  if (!runtimeSettingsByUser[userId]) {
    runtimeSettingsByUser[userId] = mergedSettings(DEFAULT_SETTINGS, persistedByUser[userId] || {});
  }
  return runtimeSettingsByUser[userId];
}

export function getPanelSettings(userId = 'admin'): PanelRuntimeSettings {
  return {
    ...getRuntimeSettings(userId),
    ...PANEL_DEFAULTS,
  };
}

export function getAllRuntimeSettings(): Record<string, RuntimeSettings> {
  return { ...runtimeSettingsByUser };
}

export function updateRuntimeSettings(userId: string, patch: PersistedSettings): RuntimeSettings {
  const existingPatch = persistedByUser[userId] || {};
  const mergedPatch = {
    ...existingPatch,
    ...sanitizePatch(patch),
  };

  persistedByUser[userId] = mergedPatch;
  savePersistedSettingsByUser(persistedByUser);

  runtimeSettingsByUser[userId] = mergedSettings(DEFAULT_SETTINGS, mergedPatch);
  notify(userId);
  return runtimeSettingsByUser[userId];
}

export function onRuntimeSettingsChange(listener: SettingsListener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getAdminPassword(): string {
  return process.env.ADMIN_PANEL_PASSWORD || '';
}
