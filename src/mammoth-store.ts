import { createHash } from 'node:crypto';
import { MongoClient, type Collection, type Filter } from 'mongodb';
import { createLogger } from './logger.js';
import type { DailyReportPayload } from './notion.js';
import type { ReportType } from './types.js';

const log = createLogger('mammoth-store');

export interface ReaderItem {
  itemId: string;
  title: string;
  source: string;
  link: string;
  interestTags: string[];
  whatHappened: string;
  whyItMatters: string;
  keyDetail: string;
  publishedAt: string;
  note: string;
}

export interface ReaderReportDocument {
  userId: string;
  reportId: string;
  reportDate: string;
  reportType: ReportType;
  scopeType: 'all' | 'interest';
  scopeValue: string;
  title: string;
  timezone: string;
  generatedAtIso: string;
  notionUrl: string;
  notionPageId: string;
  reportBody: string;
  categories: string[];
  reportNote: string;
  items: ReaderItem[];
  createdAtIso: string;
  updatedAtIso: string;
}

export interface ReaderReportSummary {
  reportId: string;
  reportDate: string;
  reportType: ReportType;
  title: string;
  generatedAtIso: string;
  categories: string[];
  itemCount: number;
  notionUrl: string;
}

export interface ListReaderReportsParams {
  type?: ReportType;
  q?: string;
  category?: string;
  fromDate?: string;
  toDate?: string;
  page?: number;
  limit?: number;
}

export interface ListReaderReportsResult {
  items: ReaderReportSummary[];
  total: number;
  page: number;
  limit: number;
}

function reportTitle(
  reportType: ReportType,
  reportDate: string,
  scopeType: 'all' | 'interest',
  scopeValue: string,
): string {
  if (scopeType === 'interest' && scopeValue) {
    return `${reportType === 'papers' ? 'Makaleler' : 'Haberler'} - ${scopeValue} - ${reportDate}`;
  }
  return `${reportType === 'papers' ? 'Makaleler Raporu' : 'Haberler Raporu'} - ${reportDate}`;
}

function extractArxivCategory(source: string): string | null {
  const m = source.match(/arXiv\s+([a-z]{2}\.[A-Z]{2})/);
  return m ? m[1] : null;
}

function normalizeInterestTags(reportType: ReportType, interestTags: string[] | undefined, source: string): string[] {
  const input = Array.isArray(interestTags) ? interestTags : [];
  const out = Array.from(
    new Set(
      input
        .map(tag => (tag || '').trim())
        .filter(Boolean),
    ),
  );
  if (out.length > 0) return out;
  if (reportType === 'papers') {
    return [extractArxivCategory(source) || 'research'];
  }
  return ['news'];
}

function makeReportId(
  reportType: ReportType,
  reportDate: string,
  scopeType: 'all' | 'interest',
  scopeValue: string,
): string {
  return `${reportType}:${reportDate}:${scopeType}:${scopeValue || 'all'}`;
}

function parseReportId(reportId: string): {
  reportType: ReportType;
  reportDate: string;
  scopeType: 'all' | 'interest';
  scopeValue: string;
} | null {
  const parts = String(reportId || '').split(':');
  if (parts.length < 2) return null;
  const reportType = parts[0] === 'papers' ? 'papers' : parts[0] === 'news' ? 'news' : null;
  const reportDate = parts[1] || '';
  if (!reportType || !reportDate) return null;
  const scopeType = parts[2] === 'interest' ? 'interest' : 'all';
  const scopeValue = scopeType === 'interest' ? (parts.slice(3).join(':') || 'all') : 'all';
  return { reportType, reportDate, scopeType, scopeValue };
}

function makeItemId(reportId: string, title: string, link: string, publishedAt: string): string {
  return createHash('sha1').update(`${reportId}|${title}|${link}|${publishedAt}`).digest('hex').slice(0, 16);
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function buildReportBody(payload: DailyReportPayload): string {
  const header = payload.scopeType === 'interest' && payload.scopeValue
    ? `${payload.reportType === 'papers' ? 'Makaleler Raporu' : 'Haberler Raporu'} · ${payload.scopeValue}`
    : payload.reportType === 'papers' ? 'Makaleler Raporu' : 'Haberler Raporu';
  const lines: string[] = [];
  lines.push(`${header} - ${payload.reportDate}`);
  lines.push(`Generated at ${payload.generatedAtIso} (${payload.timezone})`);
  lines.push(`Lookback window: ${payload.lookbackDays} day(s)`);

  if (payload.items.length === 0) {
    lines.push('');
    lines.push(payload.emptyReason?.trim() || 'No qualifying items were found in this reporting window.');
    return lines.join('\n');
  }

  for (let i = 0; i < payload.items.length; i += 1) {
    const item = payload.items[i];
    lines.push('');
    lines.push(`${i + 1}. ${item.title}`);
    lines.push(`Source: ${item.source}`);
    lines.push(`Interests: ${normalizeInterestTags(payload.reportType, item.interestTags, item.source).join(', ')}`);
    lines.push(`Published: ${item.publishedAt}`);
    lines.push(`What happened: ${item.whatHappened}`);
    lines.push(`Why it matters: ${item.whyItMatters}`);
    lines.push(`Key detail: ${item.keyDetail}`);
    lines.push(`Link: ${item.link}`);
  }

  return lines.join('\n');
}

export class MammothStore {
  private client: MongoClient | null = null;
  private reports: Collection<ReaderReportDocument> | null = null;

  constructor(
    private readonly enabled: boolean,
    private readonly uri: string,
    private readonly database: string,
  ) {}

  isEnabled(): boolean {
    return this.enabled;
  }

  isReady(): boolean {
    return this.reports !== null;
  }

  async connect(): Promise<void> {
    if (!this.enabled) {
      log.info('Mammoth store disabled by configuration');
      return;
    }
    if (this.reports) return;

    this.client = new MongoClient(this.uri, {
      serverSelectionTimeoutMS: 4000,
    });
    await this.client.connect();
    const db = this.client.db(this.database);
    try {
      await db.createCollection('reports');
    } catch (err) {
      // ignore if already exists or createCollection is not strictly required
      log.debug(`createCollection(reports) skipped: ${err}`);
    }
    this.reports = db.collection<ReaderReportDocument>('reports');

    try {
      await this.reports.updateMany(
        { userId: { $exists: false } } as Filter<ReaderReportDocument>,
        { $set: { userId: 'admin' } },
      );
      await this.reports.createIndex({ userId: 1, reportId: 1 }, { unique: true });
      await this.reports.createIndex({ userId: 1, reportType: 1, reportDate: -1, generatedAtIso: -1 });
      await this.reports.createIndex({ userId: 1, reportType: 1, categories: 1, reportDate: -1 });
      await this.reports.createIndex(
        {
          userId: 1,
          title: 'text',
          reportNote: 'text',
          'items.title': 'text',
          'items.source': 'text',
          'items.whatHappened': 'text',
          'items.whyItMatters': 'text',
          'items.keyDetail': 'text',
          'items.note': 'text',
        },
        {
          name: 'reader_text_search',
        },
      );
    } catch (err) {
      log.warn(`Index creation skipped or partially failed: ${err}`);
    }

    try {
      await this.migrateLegacyReports();
    } catch (err) {
      log.warn(`Legacy report migration failed: ${err}`);
    }

    log.info(`Connected to Mammoth store (${this.uri}/${this.database})`);
  }

  async close(): Promise<void> {
    if (this.client) {
      await this.client.close();
    }
    this.client = null;
    this.reports = null;
  }

  private requireReports(): Collection<ReaderReportDocument> {
    if (!this.reports) {
      throw new Error('Mammoth store is not connected');
    }
    return this.reports;
  }

  private async migrateLegacyReports(): Promise<void> {
    const reports = this.requireReports();
    const legacyDocs = await reports.find({
      $or: [
        { reportType: { $exists: false } },
        { reportDate: { $exists: false } },
        { title: { $exists: false } },
      ],
    }).project({
      _id: 0,
      userId: 1,
      reportId: 1,
      reportType: 1,
      reportDate: 1,
      scopeType: 1,
      scopeValue: 1,
      title: 1,
      timezone: 1,
      generatedAtIso: 1,
      notionUrl: 1,
      notionPageId: 1,
      reportBody: 1,
      categories: 1,
      reportNote: 1,
      items: 1,
      createdAtIso: 1,
      updatedAtIso: 1,
    }).toArray();

    if (legacyDocs.length === 0) return;
    const nowIso = new Date().toISOString();

    for (const legacy of legacyDocs) {
      const reportId = String((legacy as any).reportId || '');
      const parsed = parseReportId(reportId);
      if (!parsed) continue;

      const reportType = (legacy as any).reportType === 'papers' || (legacy as any).reportType === 'news'
        ? (legacy as any).reportType
        : parsed.reportType;
      const reportDate = typeof (legacy as any).reportDate === 'string' && (legacy as any).reportDate
        ? (legacy as any).reportDate
        : parsed.reportDate;
      const scopeType = (legacy as any).scopeType === 'interest' ? 'interest' : parsed.scopeType;
      const scopeValue = scopeType === 'interest'
        ? (typeof (legacy as any).scopeValue === 'string' && (legacy as any).scopeValue
          ? (legacy as any).scopeValue
          : parsed.scopeValue)
        : 'all';

      await reports.updateOne(
        { userId: (legacy as any).userId || 'admin', reportId },
        {
          $set: {
            reportType,
            reportDate,
            scopeType,
            scopeValue,
            title: typeof (legacy as any).title === 'string' && (legacy as any).title
              ? (legacy as any).title
              : reportTitle(reportType, reportDate, scopeType, scopeValue),
            timezone: typeof (legacy as any).timezone === 'string' && (legacy as any).timezone
              ? (legacy as any).timezone
              : 'Europe/Istanbul',
            generatedAtIso: typeof (legacy as any).generatedAtIso === 'string' && (legacy as any).generatedAtIso
              ? (legacy as any).generatedAtIso
              : nowIso,
            notionUrl: typeof (legacy as any).notionUrl === 'string' ? (legacy as any).notionUrl : '',
            notionPageId: typeof (legacy as any).notionPageId === 'string' ? (legacy as any).notionPageId : '',
            reportBody: typeof (legacy as any).reportBody === 'string' ? (legacy as any).reportBody : '',
            categories: Array.isArray((legacy as any).categories) ? (legacy as any).categories : [],
            reportNote: typeof (legacy as any).reportNote === 'string' ? (legacy as any).reportNote : '',
            items: Array.isArray((legacy as any).items) ? (legacy as any).items : [],
            createdAtIso: typeof (legacy as any).createdAtIso === 'string' && (legacy as any).createdAtIso
              ? (legacy as any).createdAtIso
              : nowIso,
            updatedAtIso: nowIso,
          },
        },
      );
    }

    log.info(`Migrated ${legacyDocs.length} legacy reader report(s)`);
  }

  private async loadReport(userId: string, reportId: string): Promise<ReaderReportDocument | null> {
    const reports = this.requireReports();
    const rows = await reports.aggregate<ReaderReportDocument>([
      { $match: { userId, reportId } },
      { $limit: 1 },
    ]).toArray();
    return rows[0] || null;
  }

  async upsertReport(userId: string, payload: DailyReportPayload, notion: { pageId: string; url: string }): Promise<void> {
    const reports = this.requireReports();
    const reportId = makeReportId(payload.reportType, payload.reportDate, payload.scopeType, payload.scopeValue);
    const nowIso = new Date().toISOString();
    const existing = await this.loadReport(userId, reportId);

    const previousItemNotesById = new Map<string, string>();
    const previousItemNotesByLink = new Map<string, string>();
    if (existing) {
      for (const item of existing.items) {
        if (item.note) {
          previousItemNotesById.set(item.itemId, item.note);
          previousItemNotesByLink.set(item.link, item.note);
        }
      }
    }

    const items: ReaderItem[] = payload.items.map(item => {
      const itemId = makeItemId(reportId, item.title, item.link, item.publishedAt);
      const previousNote = previousItemNotesById.get(itemId) || previousItemNotesByLink.get(item.link) || '';
      return {
        itemId,
        title: item.title,
        source: item.source,
        link: item.link,
        interestTags: normalizeInterestTags(payload.reportType, item.interestTags, item.source),
        whatHappened: item.whatHappened,
        whyItMatters: item.whyItMatters,
        keyDetail: item.keyDetail,
        publishedAt: item.publishedAt,
        note: previousNote,
      };
    });

    const categories = Array.from(
      new Set(items.flatMap(item => item.interestTags)),
    ).sort((a, b) => a.localeCompare(b));

    const doc: ReaderReportDocument = {
      userId,
      reportId,
      reportDate: payload.reportDate,
      reportType: payload.reportType,
      scopeType: payload.scopeType,
      scopeValue: payload.scopeType === 'all' ? 'all' : payload.scopeValue,
      title: reportTitle(payload.reportType, payload.reportDate, payload.scopeType, payload.scopeValue),
      timezone: payload.timezone,
      generatedAtIso: payload.generatedAtIso,
      notionUrl: notion.url,
      notionPageId: notion.pageId,
      reportBody: buildReportBody(payload),
      categories,
      reportNote: existing?.reportNote || '',
      items,
      createdAtIso: existing?.createdAtIso || nowIso,
      updatedAtIso: nowIso,
    };

    await reports.replaceOne({ userId, reportId }, doc, { upsert: true });
  }

  async upsertLinkOnly(userId: string, params: {
    reportType: ReportType;
    reportDate: string;
    scopeType: 'all' | 'interest';
    scopeValue: string;
    notionPageId: string;
    notionUrl: string;
    timezone: string;
  }): Promise<void> {
    const reports = this.requireReports();
    const reportId = makeReportId(params.reportType, params.reportDate, params.scopeType, params.scopeValue);
    const nowIso = new Date().toISOString();

    const existing = await this.loadReport(userId, reportId);
    if (existing) {
      await reports.updateOne(
        { userId, reportId },
        {
          $set: {
            reportDate: params.reportDate,
            reportType: params.reportType,
            scopeType: params.scopeType,
            scopeValue: params.scopeType === 'all' ? 'all' : params.scopeValue,
            title: reportTitle(params.reportType, params.reportDate, params.scopeType, params.scopeValue),
            timezone: params.timezone,
            generatedAtIso: existing.generatedAtIso || nowIso,
            notionPageId: params.notionPageId,
            notionUrl: params.notionUrl,
            reportBody: existing.reportBody || '',
            categories: Array.isArray(existing.categories) ? existing.categories : [],
            reportNote: existing.reportNote || '',
            items: Array.isArray(existing.items) ? existing.items : [],
            createdAtIso: existing.createdAtIso || nowIso,
            updatedAtIso: nowIso,
          },
        },
      );
      return;
    }

    await reports.insertOne({
      userId,
      reportId,
      reportDate: params.reportDate,
      reportType: params.reportType,
      scopeType: params.scopeType,
      scopeValue: params.scopeType === 'all' ? 'all' : params.scopeValue,
      title: reportTitle(params.reportType, params.reportDate, params.scopeType, params.scopeValue),
      timezone: params.timezone,
      generatedAtIso: nowIso,
      notionPageId: params.notionPageId,
      notionUrl: params.notionUrl,
      reportBody: '',
      categories: [],
      reportNote: '',
      items: [],
      createdAtIso: nowIso,
      updatedAtIso: nowIso,
    });
  }

  async listReports(userId: string, params: ListReaderReportsParams): Promise<ListReaderReportsResult> {
    const reports = this.requireReports();
    const page = Math.max(params.page || 1, 1);
    const limit = Math.min(Math.max(params.limit || 40, 1), 200);
    const q = (params.q || '').trim();

    const filter: Filter<ReaderReportDocument> = { userId };
    if (params.type) filter.reportType = params.type;
    if (params.category) filter.categories = params.category;
    if (params.fromDate || params.toDate) {
      filter.reportDate = {};
      if (params.fromDate) filter.reportDate.$gte = params.fromDate;
      if (params.toDate) filter.reportDate.$lte = params.toDate;
    }
    if (q) {
      const regex = new RegExp(escapeRegex(q), 'i');
      (filter as any).$or = [
        { title: regex },
        { reportNote: regex },
        { 'items.title': regex },
        { 'items.source': regex },
        { 'items.whatHappened': regex },
        { 'items.whyItMatters': regex },
        { 'items.keyDetail': regex },
        { 'items.note': regex },
      ];
    }

    const docs = await reports.aggregate<ReaderReportSummary & { items?: unknown[] }>([
      { $match: filter },
      { $sort: { reportDate: -1, generatedAtIso: -1 } },
      { $skip: (page - 1) * limit },
      { $limit: limit },
      {
        $project: {
          _id: 0,
          reportId: 1,
          reportDate: 1,
          reportType: 1,
          title: 1,
          generatedAtIso: 1,
          categories: 1,
          items: 1,
          notionUrl: 1,
        },
      },
    ]).toArray();

    const countResult = await reports.aggregate<{ total: number }>([
      { $match: filter },
      { $count: 'total' },
    ]).toArray();
    const total = countResult[0]?.total || 0;
    return {
      items: docs.map((doc) => ({
        reportId: doc.reportId,
        reportDate: doc.reportDate,
        reportType: doc.reportType,
        title: doc.title,
        generatedAtIso: doc.generatedAtIso,
        categories: doc.categories || [],
        itemCount: Array.isArray(doc.items) ? doc.items.length : 0,
        notionUrl: doc.notionUrl,
      })),
      total,
      page,
      limit,
    };
  }

  async getReport(userId: string, reportId: string): Promise<ReaderReportDocument | null> {
    return this.loadReport(userId, reportId);
  }

  async updateReportNote(userId: string, reportId: string, note: string): Promise<boolean> {
    const reports = this.requireReports();
    const res = await reports.updateOne(
      { userId, reportId },
      {
        $set: {
          reportNote: note.trim(),
          updatedAtIso: new Date().toISOString(),
        },
      },
    );
    return res.matchedCount > 0;
  }

  async updateItemNote(userId: string, reportId: string, itemId: string, note: string): Promise<boolean> {
    const reports = this.requireReports();
    const res = await reports.updateOne(
      { userId, reportId },
      {
        $set: {
          'items.$[item].note': note.trim(),
          updatedAtIso: new Date().toISOString(),
        },
      },
      {
        arrayFilters: [{ 'item.itemId': itemId }],
      },
    );
    return res.matchedCount > 0;
  }
}
