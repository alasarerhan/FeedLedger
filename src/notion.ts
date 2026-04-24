import { createLogger } from './logger.js';
import type { ReportType } from './types.js';

const log = createLogger('notion');

const NOTION_API_BASE = 'https://api.notion.com/v1';
const NOTION_VERSION = '2022-06-28';

export interface DailyReportItem {
  title: string;
  source: string;
  link: string;
  interestTags?: string[];
  whatHappened: string;
  whyItMatters: string;
  keyDetail: string;
  publishedAt: string;
}

export interface DailyReportPayload {
  reportDate: string;
  reportType: ReportType;
  scopeType: 'all' | 'interest';
  scopeValue: string;
  lookbackDays: number;
  timezone: string;
  generatedAtIso: string;
  items: DailyReportItem[];
  emptyReason?: string;
}

interface NotionErrorBody {
  object?: string;
  status?: number;
  code?: string;
  message?: string;
}

interface NotionBlockChildrenResponse {
  results: Array<Record<string, any>>;
  has_more?: boolean;
  next_cursor?: string | null;
}

export class NotionApiError extends Error {
  status: number;
  code: string;
  body: NotionErrorBody | null;

  constructor(status: number, code: string, message: string, body: NotionErrorBody | null) {
    super(message);
    this.status = status;
    this.code = code;
    this.body = body;
  }
}

function reportTitle(payload: DailyReportPayload): string {
  const label = payload.reportType === 'papers' ? 'Makaleler Raporu' : 'Haberler Raporu';
  if (payload.scopeType === 'interest' && payload.scopeValue) {
    return `${payload.reportType === 'papers' ? 'Makaleler' : 'Haberler'} - ${payload.scopeValue} - ${payload.reportDate}`;
  }
  return `${label} - ${payload.reportDate}`;
}

function toDashedUuid(raw: string): string | null {
  const clean = raw.replace(/-/g, '').toLowerCase();
  if (!/^[0-9a-f]{32}$/.test(clean)) return null;
  return `${clean.slice(0, 8)}-${clean.slice(8, 12)}-${clean.slice(12, 16)}-${clean.slice(16, 20)}-${clean.slice(20)}`;
}

function normalizeParentPageId(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed) return null;

  const direct = toDashedUuid(trimmed);
  if (direct) return direct;

  const urlMatch = trimmed.match(/([0-9a-fA-F]{32})(?:\\?|#|$)/);
  if (urlMatch) {
    return toDashedUuid(urlMatch[1]);
  }

  return null;
}

function chunkText(text: string, max = 1800): string {
  return text.length > max ? `${text.slice(0, max - 3)}...` : text;
}

function paragraphBlock(text: string): Record<string, unknown> {
  return {
    object: 'block',
    type: 'paragraph',
    paragraph: {
      rich_text: [{
        type: 'text',
        text: {
          content: chunkText(text),
        },
      }],
    },
  };
}

function headingBlock(text: string): Record<string, unknown> {
  return {
    object: 'block',
    type: 'heading_2',
    heading_2: {
      rich_text: [{
        type: 'text',
        text: {
          content: chunkText(text, 200),
        },
      }],
    },
  };
}

function calloutBlock(text: string): Record<string, unknown> {
  return paragraphBlock(text);
}

function linkBlock(label: string, url: string): Record<string, unknown> {
  return {
    object: 'block',
    type: 'paragraph',
    paragraph: {
      rich_text: [{
        type: 'text',
        text: {
          content: label,
          link: { url },
        },
      }],
    },
  };
}

function splitIntoParagraphs(text: string, maxLen = 1200): string[] {
  const clean = text.trim();
  if (!clean) return [];

  const chunks: string[] = [];
  let cursor = 0;
  while (cursor < clean.length) {
    const end = Math.min(cursor + maxLen, clean.length);
    chunks.push(clean.slice(cursor, end));
    cursor = end;
  }
  return chunks;
}

function buildMergedNarrative(payload: DailyReportPayload): string {
  if (payload.items.length === 0) {
    return payload.emptyReason?.trim() || 'Bu zaman penceresinde rapora girecek uygun içerik bulunamadı.';
  }

  const topItems = payload.items.slice(0, 10);
  const intro = `Bu rapor, ${payload.reportDate} tarihinde ${payload.lookbackDays} günlük pencere içinde taranan ${payload.reportType === 'papers' ? 'makale' : 'haber'} akışlarından derlendi. Toplam ${payload.items.length} içerik içinden öne çıkan gelişmeler bir araya getirildi.`;
  const body = topItems
    .map((item, index) => `${index + 1}) ${item.title} (${item.source}): ${item.whatHappened} Bu gelişmenin etkisi: ${item.whyItMatters}`)
    .join('\n\n');
  const outro = 'Genel tablo, teknik kabiliyetlerin hızla birleştiğini; özellikle algı, kontrol, enerji, malzeme ve sistem entegrasyonu başlıklarında yakınsama yaşandığını gösteriyor.';
  return `${intro}\n\n${body}\n\n${outro}`;
}

function buildReportBlocks(payload: DailyReportPayload): Record<string, unknown>[] {
  const blocks: Record<string, unknown>[] = [];
  const header = payload.scopeType === 'interest' && payload.scopeValue
    ? `${payload.reportType === 'papers' ? 'Makaleler ozeti' : 'Haberler ozeti'} · İlgi alanı: ${payload.scopeValue}`
    : payload.reportType === 'papers' ? 'Makaleler ozeti' : 'Haberler ozeti';
  blocks.push(headingBlock(header));
  blocks.push(paragraphBlock(`Generated at ${payload.generatedAtIso} (${payload.timezone})`));
  blocks.push(paragraphBlock(`Lookback window: ${payload.lookbackDays} day(s)`));

  if (payload.items.length === 0) {
    blocks.push(calloutBlock(payload.emptyReason?.trim() || 'Bu zaman penceresinde rapora girecek uygun içerik bulunamadı.'));
    return blocks;
  }

  const mergedNarrative = buildMergedNarrative(payload);
  blocks.push(headingBlock('Sentez Yazı'));
  for (const paragraph of splitIntoParagraphs(mergedNarrative, 1200)) {
    blocks.push(paragraphBlock(paragraph));
  }

  blocks.push(headingBlock('Referanslar'));
  const maxRefs = Math.min(payload.items.length, 80);
  for (let i = 0; i < maxRefs; i += 1) {
    const item = payload.items[i];
    blocks.push(linkBlock(`${i + 1}. ${item.title} (${item.source})`, item.link));
  }

  if (payload.items.length > maxRefs) {
    blocks.push(paragraphBlock(`Truncated: ${payload.items.length - maxRefs} additional references were omitted due to block-size limits.`));
  }

  return blocks;
}

function richTextToString(items: any[]): string {
  return (items || [])
    .map(item => item?.plain_text || item?.text?.content || '')
    .join('');
}

function blockToText(block: Record<string, any>): string {
  const type = block?.type;
  if (!type) return '';
  const payload = block[type];
  if (!payload) return '';

  if (Array.isArray(payload.rich_text)) {
    return richTextToString(payload.rich_text).trim();
  }
  return '';
}

async function notionRequest<T>(apiKey: string, path: string, method: string, body?: unknown): Promise<T> {
  const response = await fetch(`${NOTION_API_BASE}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Notion-Version': NOTION_VERSION,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  if (!response.ok) {
    let errorBody: NotionErrorBody | null = null;
    try {
      errorBody = await response.json() as NotionErrorBody;
    } catch {
      errorBody = null;
    }

    const code = errorBody?.code || `http_${response.status}`;
    const message = errorBody?.message || `Notion request failed with status ${response.status}`;
    throw new NotionApiError(response.status, code, message, errorBody);
  }

  return response.json() as Promise<T>;
}

export function isQuotaLikeError(err: unknown): boolean {
  if (!(err instanceof NotionApiError)) return false;

  const text = `${err.code} ${err.message}`.toLowerCase();
  return (
    text.includes('limit')
    || text.includes('quota')
    || text.includes('upgrade')
    || text.includes('free plan')
    || text.includes('storage')
    || text.includes('capacity')
  );
}

export async function createDailyReportPage(
  apiKey: string,
  parentPageId: string,
  payload: DailyReportPayload,
): Promise<{ pageId: string; url: string }> {
  const normalizedParentId = normalizeParentPageId(parentPageId);
  if (!normalizedParentId) {
    throw new Error('NOTION_PARENT_PAGE_ID is invalid. Provide a Notion page UUID or page URL.');
  }

  const body = {
    parent: { page_id: normalizedParentId },
    properties: {
      title: {
        title: [{
          type: 'text',
          text: { content: reportTitle(payload) },
        }],
      },
    },
    children: buildReportBlocks(payload),
  };

  const created = await notionRequest<{ id: string; url: string }>(apiKey, '/pages', 'POST', body);
  log.info(`Created Notion report page for ${payload.reportDate}`);
  return {
    pageId: created.id,
    url: created.url,
  };
}

export async function trashNotionPage(apiKey: string, pageId: string): Promise<void> {
  await notionRequest(apiKey, `/pages/${pageId}`, 'PATCH', { in_trash: true });
  log.warn(`Moved Notion page to trash: ${pageId}`);
}

export async function fetchNotionPagePlainText(apiKey: string, pageId: string, maxBlocks = 300): Promise<string> {
  const lines: string[] = [];
  let cursor: string | null | undefined = undefined;
  let hasMore = true;

  while (hasMore && lines.length < maxBlocks) {
    const query: string = cursor
      ? `?page_size=100&start_cursor=${encodeURIComponent(cursor)}`
      : '?page_size=100';
    const response: NotionBlockChildrenResponse = await notionRequest<NotionBlockChildrenResponse>(
      apiKey,
      `/blocks/${pageId}/children${query}`,
      'GET',
    );

    for (const block of response.results || []) {
      const text = blockToText(block);
      if (text) lines.push(text);
      if (lines.length >= maxBlocks) break;
    }

    hasMore = Boolean(response.has_more && response.next_cursor);
    cursor = response.next_cursor;
  }

  return lines.join('\n\n').trim();
}
