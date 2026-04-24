import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createLogger } from './logger.js';
import { fetchNotionPagePlainText } from './notion.js';
import { getRuntimeSettings } from './runtime-settings.js';
import { type ReportType } from './types.js';
import { type MammothStore } from './mammoth-store.js';
import type { UserRole } from './user-store.js';

const log = createLogger('reader-http');
const READER_BUNDLE_PATH = join(process.cwd(), 'dist', 'reader', 'app.js');

export interface ReaderSessionUser {
  userId: string;
  username: string;
  displayName: string;
  role: UserRole;
}

interface ReaderRouteOptions {
  listUsers: () => ReaderSessionUser[];
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

function parsePositiveInt(value: string | null, fallback: number): number {
  const n = Number.parseInt(value || '', 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function renderReaderShell(): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>FeedLedger Reader</title>
  <style>
    html, body, #root { margin: 0; height: 100%; width: 100%; background: #0b1220; }
  </style>
</head>
<body>
  <div id="root"></div>
  <script type="module" src="/reader/app.js"></script>
</body>
</html>`;
}

async function readJsonBody(req: IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.from(chunk));
  }
  const raw = Buffer.concat(chunks).toString('utf-8').trim();
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error('Invalid JSON body');
  }
}

function parseReportType(input: string | null): ReportType | undefined {
  if (input === 'news' || input === 'papers') return input;
  return undefined;
}

function resolveTargetUser(
  requestUrl: URL,
  session: ReaderSessionUser,
  users: ReaderSessionUser[],
): string {
  if (session.role !== 'admin') return session.userId;

  const requestedUserId = (requestUrl.searchParams.get('userId') || '').trim();
  if (!requestedUserId) return session.userId;

  return users.some(user => user.userId === requestedUserId)
    ? requestedUserId
    : session.userId;
}

export async function handleReaderRoute(
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
  store: MammothStore | null,
  session: ReaderSessionUser,
  options: ReaderRouteOptions,
): Promise<boolean> {
  const method = req.method || 'GET';

  if (path === '/reader' && method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(renderReaderShell());
    return true;
  }

  if (path === '/reader/app.js' && method === 'GET') {
    if (!existsSync(READER_BUNDLE_PATH)) {
      res.writeHead(503, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Reader bundle is missing. Run: npm run build');
      return true;
    }
    res.writeHead(200, {
      'Content-Type': 'text/javascript; charset=utf-8',
      'Cache-Control': 'no-cache',
    });
    res.end(readFileSync(READER_BUNDLE_PATH));
    return true;
  }

  if (!path.startsWith('/api/reader')) {
    return false;
  }

  const requestUrl = new URL(req.url || '/', 'http://localhost');
  const users = options.listUsers();

  if (path === '/api/reader/session' && method === 'GET') {
    sendJson(res, 200, {
      user: session,
      users: session.role === 'admin'
        ? users
        : users.filter(user => user.userId === session.userId),
    });
    return true;
  }

  if (!store || !store.isReady()) {
    sendJson(res, 503, { error: 'Reader storage is not available (Mammoth is disconnected).' });
    return true;
  }

  const targetUserId = resolveTargetUser(requestUrl, session, users);

  if (path === '/api/reader/reports' && method === 'GET') {
    const reportType = parseReportType(requestUrl.searchParams.get('type'));
    const result = await store.listReports(targetUserId, {
      type: reportType,
      q: requestUrl.searchParams.get('q') || undefined,
      category: requestUrl.searchParams.get('category') || undefined,
      fromDate: requestUrl.searchParams.get('from') || undefined,
      toDate: requestUrl.searchParams.get('to') || undefined,
      page: parsePositiveInt(requestUrl.searchParams.get('page'), 1),
      limit: parsePositiveInt(requestUrl.searchParams.get('limit'), 40),
    });
    sendJson(res, 200, result);
    return true;
  }

  if (path === '/api/reader/search' && method === 'GET') {
    const reportType = parseReportType(requestUrl.searchParams.get('type'));
    const result = await store.listReports(targetUserId, {
      type: reportType,
      q: requestUrl.searchParams.get('q') || undefined,
      category: requestUrl.searchParams.get('category') || undefined,
      fromDate: requestUrl.searchParams.get('from') || undefined,
      toDate: requestUrl.searchParams.get('to') || undefined,
      page: parsePositiveInt(requestUrl.searchParams.get('page'), 1),
      limit: parsePositiveInt(requestUrl.searchParams.get('limit'), 40),
    });
    sendJson(res, 200, result);
    return true;
  }

  if (path === '/api/reader/interests' && method === 'GET') {
    const settings = getRuntimeSettings(targetUserId);
    sendJson(res, 200, {
      interests: settings.interests || [],
    });
    return true;
  }

  const parts = path.split('/').filter(Boolean);
  // /api/reader/reports/:reportId
  if (parts.length === 4 && parts[0] === 'api' && parts[1] === 'reader' && parts[2] === 'reports' && method === 'GET') {
    const reportId = decodeURIComponent(parts[3]);
    const report = await store.getReport(targetUserId, reportId);
    if (!report) {
      sendJson(res, 404, { error: 'Report not found' });
      return true;
    }

    let reportBody = report.reportBody || '';
    if (!reportBody && report.notionPageId) {
      const settings = getRuntimeSettings(targetUserId);
      if (settings.notionApiKey) {
        try {
          reportBody = await fetchNotionPagePlainText(settings.notionApiKey, report.notionPageId);
        } catch (err) {
          log.warn(`Failed to fetch Notion fallback report body (${report.reportId}): ${err}`);
        }
      }
    }

    sendJson(res, 200, {
      ...report,
      reportBody,
    });
    return true;
  }

  // /api/reader/reports/:reportId/note
  if (parts.length === 5 && parts[0] === 'api' && parts[1] === 'reader' && parts[2] === 'reports' && parts[4] === 'note' && method === 'PATCH') {
    const reportId = decodeURIComponent(parts[3]);
    try {
      const body = await readJsonBody(req);
      const note = typeof body.note === 'string' ? body.note : '';
      const ok = await store.updateReportNote(targetUserId, reportId, note);
      if (!ok) {
        sendJson(res, 404, { error: 'Report not found' });
        return true;
      }
      sendJson(res, 200, { ok: true });
      return true;
    } catch (err) {
      sendJson(res, 400, { error: String(err) });
      return true;
    }
  }

  // /api/reader/reports/:reportId/items/:itemId/note
  if (
    parts.length === 7
    && parts[0] === 'api'
    && parts[1] === 'reader'
    && parts[2] === 'reports'
    && parts[4] === 'items'
    && parts[6] === 'note'
    && method === 'PATCH'
  ) {
    const reportId = decodeURIComponent(parts[3]);
    const itemId = decodeURIComponent(parts[5]);
    try {
      const body = await readJsonBody(req);
      const note = typeof body.note === 'string' ? body.note : '';
      const ok = await store.updateItemNote(targetUserId, reportId, itemId, note);
      if (!ok) {
        sendJson(res, 404, { error: 'Report or item not found' });
        return true;
      }
      sendJson(res, 200, { ok: true });
      return true;
    } catch (err) {
      sendJson(res, 400, { error: String(err) });
      return true;
    }
  }

  log.warn(`Unhandled reader route ${method} ${path}`);
  sendJson(res, 404, { error: 'Not found' });
  return true;
}
