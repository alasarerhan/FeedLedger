import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { config } from './config.js';
import type { ReportType } from './types.js';

export interface DailyReportState {
  reportDate: string;
  reportType: ReportType;
  scopeType: 'all' | 'interest';
  scopeValue: string;
  notionPageId: string;
  notionUrl: string;
  generatedAt: number;
  itemCount?: number;
  emptyReason?: string;
  sentAt?: number;
  sendRetryCount: number;
  lastSendError?: string;
}

export interface SchedulerState {
  lastScanRunDate?: string;
  lastSendRunDate?: string;
  scanRetryDate?: string;
  scanRetryAfterMs?: number;
  sendRetryAfterMs?: number;
  reports: Record<string, DailyReportState>;
}

interface SchedulerStateFile {
  version: number;
  users: Record<string, SchedulerState>;
}

export type SchedulerStatesByUser = Record<string, SchedulerState>;

const STATE_FILE = join(config.dataDir, 'daily-state.json');
const STATE_VERSION = 2;

function getDefaultState(): SchedulerState {
  return {
    reports: {},
  };
}

function toReportType(value: unknown): ReportType {
  return value === 'papers' ? 'papers' : 'news';
}

function toScopeType(value: unknown): 'all' | 'interest' {
  return value === 'interest' ? 'interest' : 'all';
}

function reportKey(reportDate: string, reportType: ReportType, scopeType: 'all' | 'interest', scopeValue: string): string {
  return `${reportDate}:${reportType}:${scopeType}:${scopeValue || 'all'}`;
}

function normalizeState(state: SchedulerState): SchedulerState {
  const normalizedReports: Record<string, DailyReportState> = {};

  for (const [key, raw] of Object.entries(state.reports || {})) {
    const report = raw as Partial<DailyReportState>;
    const reportDate = typeof report.reportDate === 'string' && report.reportDate
      ? report.reportDate
      : key.split(':')[0];

    const keyParts = key.split(':');
    const reportType = toReportType(report.reportType || keyParts[1]);
    const scopeType = toScopeType(report.scopeType || keyParts[2]);
    const scopeValue = typeof report.scopeValue === 'string'
      ? report.scopeValue
      : scopeType === 'interest'
        ? (keyParts.slice(3).join(':') || '')
        : 'all';

    if (!reportDate) continue;

    const next: DailyReportState = {
      reportDate,
      reportType,
      scopeType,
      scopeValue: scopeType === 'all' ? 'all' : scopeValue,
      notionPageId: report.notionPageId || '',
      notionUrl: report.notionUrl || '',
      generatedAt: report.generatedAt || Date.now(),
      itemCount: typeof report.itemCount === 'number' && report.itemCount >= 0
        ? report.itemCount
        : undefined,
      emptyReason: typeof report.emptyReason === 'string' && report.emptyReason.trim()
        ? report.emptyReason.trim()
        : undefined,
      sentAt: report.sentAt,
      sendRetryCount: report.sendRetryCount || 0,
      lastSendError: report.lastSendError,
    };

    normalizedReports[reportKey(reportDate, reportType, next.scopeType, next.scopeValue)] = next;
  }

  return {
    ...state,
    reports: normalizedReports,
  };
}

function loadRawState(): SchedulerStateFile {
  try {
    if (!existsSync(STATE_FILE)) {
      return {
        version: STATE_VERSION,
        users: { admin: getDefaultState() },
      };
    }

    const parsed = JSON.parse(readFileSync(STATE_FILE, 'utf-8')) as unknown;
    if (!parsed || typeof parsed !== 'object') {
      return {
        version: STATE_VERSION,
        users: { admin: getDefaultState() },
      };
    }

    const file = parsed as Partial<SchedulerStateFile> & Record<string, unknown>;
    if (file.version === STATE_VERSION && file.users && typeof file.users === 'object') {
      const users: Record<string, SchedulerState> = {};
      for (const [userId, state] of Object.entries(file.users)) {
        if (!state || typeof state !== 'object') continue;
        users[userId] = normalizeState(state as SchedulerState);
      }
      return {
        version: STATE_VERSION,
        users,
      };
    }

    // Legacy single-user state -> assign to admin
    return {
      version: STATE_VERSION,
      users: {
        admin: normalizeState(file as unknown as SchedulerState),
      },
    };
  } catch {
    return {
      version: STATE_VERSION,
      users: { admin: getDefaultState() },
    };
  }
}

function saveRawState(file: SchedulerStateFile): void {
  mkdirSync(config.dataDir, { recursive: true });
  const tmp = `${STATE_FILE}.tmp`;
  writeFileSync(tmp, JSON.stringify(file, null, 2), 'utf-8');
  renameSync(tmp, STATE_FILE);
}

export function loadSchedulerStates(userIds: string[] = ['admin']): SchedulerStatesByUser {
  const file = loadRawState();
  const users: SchedulerStatesByUser = { ...file.users };

  for (const userId of userIds) {
    if (!users[userId]) {
      users[userId] = getDefaultState();
    }
  }

  saveRawState({ version: STATE_VERSION, users });
  return users;
}

export function saveSchedulerStates(states: SchedulerStatesByUser): void {
  saveRawState({ version: STATE_VERSION, users: states });
}

export function ensureSchedulerStatesForUsers(states: SchedulerStatesByUser, userIds: string[]): boolean {
  let changed = false;
  for (const userId of userIds) {
    if (!states[userId]) {
      states[userId] = getDefaultState();
      changed = true;
    }
  }
  return changed;
}

export function removeSchedulerState(states: SchedulerStatesByUser, userId: string): boolean {
  if (!states[userId]) return false;
  delete states[userId];
  return true;
}

export function upsertDailyReport(state: SchedulerState, report: DailyReportState): void {
  state.reports[reportKey(report.reportDate, report.reportType, report.scopeType, report.scopeValue)] = report;
}

export function removeDailyReport(
  state: SchedulerState,
  reportDate: string,
  reportType: ReportType,
  scopeType: 'all' | 'interest' = 'all',
  scopeValue = 'all',
): void {
  delete state.reports[reportKey(reportDate, reportType, scopeType, scopeValue)];
}

function reportTypeOrder(reportType: ReportType): number {
  return reportType === 'news' ? 0 : 1;
}

function scopeTypeOrder(scopeType: 'all' | 'interest'): number {
  return scopeType === 'all' ? 0 : 1;
}

export function getUnsentReportsUpTo(state: SchedulerState, maxReportDate: string): DailyReportState[] {
  return Object.values(state.reports)
    .filter(report => !report.sentAt && report.reportDate <= maxReportDate)
    .sort((a, b) => {
      if (a.reportDate !== b.reportDate) return a.reportDate.localeCompare(b.reportDate);
      if (a.reportType !== b.reportType) return reportTypeOrder(a.reportType) - reportTypeOrder(b.reportType);
      if (a.scopeType !== b.scopeType) return scopeTypeOrder(a.scopeType) - scopeTypeOrder(b.scopeType);
      return a.scopeValue.localeCompare(b.scopeValue);
    });
}
