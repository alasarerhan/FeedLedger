import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { config } from './config.js';
import type { ReportType } from './types.js';

export interface StoredReport {
  userId: string;
  reportDate: string;
  reportType: ReportType;
  scopeType: 'all' | 'interest';
  scopeValue: string;
  notionPageId: string;
  notionUrl: string;
  createdAt: number;
}

interface ReportIndexFile {
  version: number;
  users: Record<string, StoredReport[]>;
}

const REPORT_INDEX_FILE = join(config.dataDir, 'report-index.json');
const REPORT_INDEX_VERSION = 2;

function toReportType(value: unknown): ReportType {
  return value === 'papers' ? 'papers' : 'news';
}

function toScopeType(value: unknown): 'all' | 'interest' {
  return value === 'interest' ? 'interest' : 'all';
}

function normalizeReport(userId: string, r: any): StoredReport | null {
  const normalized: StoredReport = {
    userId,
    reportDate: typeof r.reportDate === 'string' ? r.reportDate : '',
    reportType: toReportType(r.reportType),
    scopeType: toScopeType(r.scopeType),
    scopeValue: typeof r.scopeValue === 'string' && r.scopeValue
      ? r.scopeValue
      : 'all',
    notionPageId: typeof r.notionPageId === 'string' ? r.notionPageId : '',
    notionUrl: typeof r.notionUrl === 'string' ? r.notionUrl : '',
    createdAt: typeof r.createdAt === 'number' ? r.createdAt : Date.now(),
  };

  if (!normalized.reportDate || !normalized.notionPageId || !normalized.notionUrl) {
    return null;
  }

  return normalized;
}

function loadFile(): ReportIndexFile {
  try {
    if (!existsSync(REPORT_INDEX_FILE)) {
      return { version: REPORT_INDEX_VERSION, users: {} };
    }

    const parsed = JSON.parse(readFileSync(REPORT_INDEX_FILE, 'utf-8')) as unknown;
    if (!parsed || typeof parsed !== 'object') {
      return { version: REPORT_INDEX_VERSION, users: {} };
    }

    const source = parsed as Partial<ReportIndexFile> & Record<string, unknown>;
    if (source.version === REPORT_INDEX_VERSION && source.users && typeof source.users === 'object') {
      const users: Record<string, StoredReport[]> = {};
      for (const [userId, reportsRaw] of Object.entries(source.users)) {
        if (!Array.isArray(reportsRaw)) continue;
        const reports = reportsRaw
          .map(item => normalizeReport(userId, item))
          .filter((item): item is StoredReport => Boolean(item));
        users[userId] = reports;
      }
      return { version: REPORT_INDEX_VERSION, users };
    }

    // Legacy format migration (single array) -> admin
    const legacyReports = Array.isArray((source as any).reports)
      ? (source as any).reports
      : [];

    return {
      version: REPORT_INDEX_VERSION,
      users: {
        admin: legacyReports
          .map((item: any) => normalizeReport('admin', item))
          .filter((item: StoredReport | null): item is StoredReport => Boolean(item)),
      },
    };
  } catch {
    return { version: REPORT_INDEX_VERSION, users: {} };
  }
}

function saveFile(file: ReportIndexFile): void {
  mkdirSync(config.dataDir, { recursive: true });
  const tmp = `${REPORT_INDEX_FILE}.tmp`;
  writeFileSync(tmp, JSON.stringify(file, null, 2), 'utf-8');
  renameSync(tmp, REPORT_INDEX_FILE);
}

function sortReports(reports: StoredReport[]): StoredReport[] {
  return [...reports].sort((a, b) => {
    if (a.reportDate !== b.reportDate) return a.reportDate.localeCompare(b.reportDate);
    if (a.reportType !== b.reportType) return a.reportType === 'news' ? -1 : 1;
    if (a.scopeType !== b.scopeType) return a.scopeType === 'all' ? -1 : 1;
    if (a.scopeValue !== b.scopeValue) return a.scopeValue.localeCompare(b.scopeValue);
    return a.createdAt - b.createdAt;
  });
}

export function listReports(userId: string): StoredReport[] {
  const file = loadFile();
  return sortReports(file.users[userId] || []);
}

export function findReport(
  userId: string,
  reportDate: string,
  reportType: ReportType,
  scopeType: 'all' | 'interest' = 'all',
  scopeValue = 'all',
): StoredReport | undefined {
  return (loadFile().users[userId] || []).find(
    r => r.reportDate === reportDate
      && r.reportType === reportType
      && r.scopeType === scopeType
      && r.scopeValue === scopeValue,
  );
}

export function upsertReport(report: StoredReport): void {
  const file = loadFile();
  const current = file.users[report.userId] || [];
  const filtered = current.filter(r => !(
    r.reportDate === report.reportDate
    && r.reportType === report.reportType
    && r.scopeType === report.scopeType
    && r.scopeValue === report.scopeValue
  ));
  filtered.push(report);
  file.users[report.userId] = sortReports(filtered);
  saveFile(file);
}

export function removeReportByPageId(userId: string, notionPageId: string): StoredReport | null {
  const file = loadFile();
  const current = file.users[userId] || [];
  const found = current.find(r => r.notionPageId === notionPageId) || null;
  file.users[userId] = current.filter(r => r.notionPageId !== notionPageId);
  saveFile(file);
  return found;
}

export function getOldestReport(userId: string): StoredReport | null {
  const reports = listReports(userId);
  return reports.length > 0 ? reports[0] : null;
}

export function ensureUserReportIndex(userIds: string[]): void {
  const file = loadFile();
  let changed = false;
  for (const userId of userIds) {
    if (!file.users[userId]) {
      file.users[userId] = [];
      changed = true;
    }
  }
  if (changed) saveFile(file);
}

export function removeUserReportIndex(userId: string): void {
  const file = loadFile();
  if (!file.users[userId]) return;
  delete file.users[userId];
  saveFile(file);
}
