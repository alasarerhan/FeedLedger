import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomBytes } from 'node:crypto';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { createLogger } from './logger.js';
import { handleReaderRoute, type ReaderSessionUser } from './reader-http.js';
import {
  GEMINI_MODEL_OPTIONS,
  INTEREST_PRESET_OPTIONS,
  OPENROUTER_MODEL_OPTIONS,
  REPORT_PERIOD_DAY_OPTIONS,
  REPORT_GROUPING_MODE_OPTIONS,
  SCHEDULE_TIME_PRESETS,
  TIMEZONE_OPTIONS,
  getPanelSettings,
  updateRuntimeSettings,
  type RuntimeSpecialProject,
} from './runtime-settings.js';
import type { MammothStore } from './mammoth-store.js';
import {
  authenticateUser,
  createUser,
  deleteUser,
  listUsers,
  setUserPassword,
  updateUser,
  type UserRole,
} from './user-store.js';

const log = createLogger('admin-panel');
const SECRET_PLACEHOLDER = '********';

interface AdminPanelOptions {
  onSettingsUpdated: (userId: string) => void;
  getMammothStore: () => MammothStore | null;
}

function htmlEscape(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function maskSecret(value: string): string {
  return value ? SECRET_PLACEHOLDER : '';
}

function resolveSecretInput(input: string | undefined, currentValue: string): string {
  const raw = (input || '').trim();
  if (raw === SECRET_PLACEHOLDER) return currentValue;
  return raw;
}

function toInlineJson(value: unknown): string {
  return JSON.stringify(value).replace(/</g, '\\u003c');
}

function parseJsonArrayInput(raw: string | undefined): unknown[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function projectFallbackPrompt(name: string, feedUrls: string[]): { prompt: string; interests: string[] } {
  const hostHints = Array.from(
    new Set(
      feedUrls
        .map((url) => {
          try {
            return new URL(url).hostname.replace(/^www\./i, '');
          } catch {
            return '';
          }
        })
        .filter(Boolean),
    ),
  ).slice(0, 8);

  const interests = Array.from(
    new Set([
      name,
      ...hostHints.map(host => host.split('.').slice(0, 1)[0] || host),
    ]),
  ).map(value => value.trim()).filter(Boolean).slice(0, 12);

  const prompt = [
    `Project: ${name}`,
    'Focus only on content that directly advances this project goals.',
    'Prefer engineering details, experiments, benchmarks, design constraints, and implementation tradeoffs.',
    'Skip generic market or funding news unless there is clear technical relevance.',
  ].join('\n');

  return { prompt, interests };
}

async function generateProjectPromptWithGemini(
  projectName: string,
  feedUrls: string[],
  geminiApiKey: string,
  geminiModel: string,
): Promise<{ prompt: string; interests: string[] }> {
  if (!geminiApiKey.trim()) return projectFallbackPrompt(projectName, feedUrls);

  const feedList = feedUrls.map((url, index) => `${index + 1}. ${url}`).join('\n');
  const system = [
    'You generate project monitoring profiles for a technical RSS pipeline.',
    'Return valid JSON only.',
    'Output schema: {"prompt":"...","interests":["..."]}',
    'Rules:',
    '- prompt: concise 4-8 line instruction focused on technical relevance filtering and synthesis',
    '- interests: 6-20 short tags in English, domain-specific and concrete',
    '- no markdown',
    '- no extra keys',
  ].join('\n');
  const user = [
    `Project name: ${projectName}`,
    'RSS feeds:',
    feedList || '(none)',
  ].join('\n');

  try {
    const genAI = new GoogleGenerativeAI(geminiApiKey);
    const model = genAI.getGenerativeModel({
      model: geminiModel || 'gemini-2.5-flash',
      systemInstruction: system,
    });
    const result = await model.generateContent(user);
    const text = result.response.text().trim();
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return projectFallbackPrompt(projectName, feedUrls);
    const parsed = JSON.parse(jsonMatch[0]) as { prompt?: string; interests?: string[] };
    const prompt = typeof parsed.prompt === 'string' ? parsed.prompt.trim() : '';
    const interests = Array.isArray(parsed.interests)
      ? parsed.interests.map(value => String(value || '').trim()).filter(Boolean).slice(0, 30)
      : [];

    if (!prompt || interests.length === 0) return projectFallbackPrompt(projectName, feedUrls);
    return { prompt, interests };
  } catch (err) {
    log.warn(`Gemini auto-prompt generation failed for project "${projectName}": ${err}`);
    return projectFallbackPrompt(projectName, feedUrls);
  }
}

async function enrichProjectsWithAutoPrompt(
  inputProjects: unknown[],
  geminiApiKey: string,
  geminiModel: string,
): Promise<unknown[]> {
  const out: unknown[] = [];

  for (const raw of inputProjects) {
    if (!raw || typeof raw !== 'object') continue;
    const project = { ...(raw as Record<string, unknown>) };
    const name = String(project.name || '').trim();
    if (!name) continue;

    const feeds = Array.isArray(project.feeds) ? project.feeds : [];
    const feedUrls = feeds
      .map(feed => (feed && typeof feed === 'object' ? String((feed as Record<string, unknown>).url || '').trim() : ''))
      .filter(Boolean);

    const currentPrompt = String(project.prompt || '').trim();
    const currentInterests = Array.isArray(project.interests)
      ? (project.interests as unknown[]).map(value => String(value || '').trim()).filter(Boolean)
      : [];

    if (!currentPrompt || currentInterests.length === 0) {
      const generated = await generateProjectPromptWithGemini(name, feedUrls, geminiApiKey, geminiModel);
      if (!currentPrompt) project.prompt = generated.prompt;
      if (currentInterests.length === 0) project.interests = generated.interests;
    }

    out.push(project);
  }

  return out;
}

function parseCookies(req: IncomingMessage): Record<string, string> {
  const cookie = req.headers.cookie || '';
  return cookie
    .split(';')
    .map(part => part.trim())
    .filter(Boolean)
    .reduce<Record<string, string>>((acc, part) => {
      const idx = part.indexOf('=');
      if (idx === -1) return acc;
      const key = part.slice(0, idx);
      const value = decodeURIComponent(part.slice(idx + 1));
      acc[key] = value;
      return acc;
    }, {});
}

async function readForm(req: IncomingMessage): Promise<Record<string, string>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.from(chunk));
  }

  const body = Buffer.concat(chunks).toString('utf-8');
  const params = new URLSearchParams(body);
  const result: Record<string, string> = {};
  params.forEach((value, key) => {
    result[key] = value;
  });
  return result;
}

function redirect(res: ServerResponse, location: string, cookie?: string | string[]): void {
  const headers: Record<string, string | string[]> = { Location: location };
  if (cookie) headers['Set-Cookie'] = cookie;
  res.writeHead(302, headers);
  res.end();
}

function renderLogin(error?: string): string {
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>FeedLedger Login</title>
  <style>
    :root { --bg: #0e1117; --card: #151a24; --text: #e8ecf4; --muted: #9aa4b2; --accent: #5fd1b3; }
    body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: radial-gradient(circle at top right, #1d2540, var(--bg)); color: var(--text); font-family: "Segoe UI", "Inter", sans-serif; }
    .card { width: min(420px, 92vw); background: var(--card); border: 1px solid #283149; border-radius: 14px; padding: 24px; }
    h1 { margin: 0 0 6px; font-size: 22px; }
    p { margin: 0 0 14px; color: var(--muted); font-size: 14px; }
    label { display: block; margin: 12px 0 6px; font-size: 14px; }
    input, button { width: 100%; box-sizing: border-box; border-radius: 10px; border: 1px solid #33425f; background: #101523; color: var(--text); padding: 11px 12px; }
    button { margin-top: 14px; cursor: pointer; background: linear-gradient(90deg, #37b38f, #49d5b2); color: #04261d; border: 0; font-weight: 600; }
    .err { color: #ff8f8f; margin-top: 10px; }
  </style>
</head>
<body>
  <form class="card" method="post" action="/login">
    <h1>FeedLedger</h1>
    <p>Secure control panel and reader access</p>
    <label for="username">Username</label>
    <input id="username" name="username" autocomplete="username" required />
    <label for="password">Password</label>
    <input id="password" name="password" type="password" autocomplete="current-password" required />
    <button type="submit">Login</button>
    ${error ? `<div class="err">${htmlEscape(error)}</div>` : ''}
  </form>
</body>
</html>`;
}

function sanitizeUserQueryUserId(currentUser: ReaderSessionUser, rawTargetUserId: string | undefined): string {
  if (currentUser.role !== 'admin') return currentUser.userId;
  const requested = (rawTargetUserId || '').trim();
  if (!requested) return currentUser.userId;
  const users = listUsers();
  return users.some(user => user.id === requested)
    ? requested
    : currentUser.userId;
}

function renderDashboard(currentUser: ReaderSessionUser, targetUserId: string, message?: string, error?: string): string {
  const users = listUsers();
  const targetUser = users.find(user => user.id === targetUserId) || users.find(user => user.id === currentUser.userId);
  const resolvedTargetUserId = targetUser?.id || currentUser.userId;
  const settings = getPanelSettings(resolvedTargetUserId);

  const maskedGeminiApiKey = maskSecret(settings.geminiApiKey);
  const maskedOpenrouterApiKey = maskSecret(settings.openrouterApiKey);
  const maskedNotionApiKey = maskSecret(settings.notionApiKey);
  const maskedTelegramBotToken = maskSecret(settings.telegramBotToken);
  const maskedTelegramChatId = maskSecret(settings.telegramChatId);

  const geminiModelOptions = GEMINI_MODEL_OPTIONS
    .map(model => `<option value="${model}" ${settings.geminiModel === model ? 'selected' : ''}>${model}</option>`)
    .join('');

  const openrouterModelEntries: Array<{ value: string; label: string }> = OPENROUTER_MODEL_OPTIONS
    .map(model => ({
      value: model,
      label: model.replace('/', ' · '),
    }));
  const hasCurrentOpenrouterModel = openrouterModelEntries.some(entry => entry.value === settings.openrouterModel);
  if (!hasCurrentOpenrouterModel && settings.openrouterModel.trim()) {
    openrouterModelEntries.unshift({
      value: settings.openrouterModel,
      label: `${settings.openrouterModel} (current)`,
    });
  }
  const openrouterModelOptions = openrouterModelEntries
    .map(entry => `<option value="${entry.value}" ${settings.openrouterModel === entry.value ? 'selected' : ''}>${htmlEscape(entry.label)}</option>`)
    .join('');
  const activeAiLabel = settings.aiProvider === 'gemini'
    ? `Google Gemini · ${settings.geminiModel}`
    : `OpenRouter · ${settings.openrouterModel}`;

  const timezoneOptions = TIMEZONE_OPTIONS
    .map(tz => `<option value="${tz}" ${settings.reportTimezone === tz ? 'selected' : ''}>${tz}</option>`)
    .join('');

  const scanPresets = SCHEDULE_TIME_PRESETS
    .map(time => `<button type="button" class="chip" data-target="dailyScanTime" data-time="${time}">${time}</button>`)
    .join('');

  const sendPresets = SCHEDULE_TIME_PRESETS
    .map(time => `<button type="button" class="chip" data-target="dailySendTime" data-time="${time}">${time}</button>`)
    .join('');

  const reportGroupingOptions = REPORT_GROUPING_MODE_OPTIONS
    .map(mode => {
      const label = mode === 'by_interest' ? 'Per-interest reports' : 'Single (2 reports: News + Papers)';
      return `<option value="${mode}" ${settings.reportGroupingMode === mode ? 'selected' : ''}>${label}</option>`;
    })
    .join('');

  const reportPeriodOptions = REPORT_PERIOD_DAY_OPTIONS
    .map(days => {
      const label = days === 1 ? '1 day (daily)' : `${days} days`;
      return `<option value="${days}" ${settings.reportPeriodDays === days ? 'selected' : ''}>${label}</option>`;
    })
    .join('');

  const interestPresetChips = INTEREST_PRESET_OPTIONS
    .map(topic => `<button type="button" class="chip interest-preset" data-interest="${htmlEscape(topic)}">${htmlEscape(topic)}</button>`)
    .join('');

  const inlineInterests = toInlineJson(settings.interests || []);
  const inlineFeeds = toInlineJson(settings.feeds || []);
  const inlineSpecialProjects = toInlineJson(settings.specialProjects || []);

  const userPickerOptions = users
    .map(user => `<option value="${user.id}" ${user.id === resolvedTargetUserId ? 'selected' : ''}>${htmlEscape(user.displayName)} (${htmlEscape(user.username)})</option>`)
    .join('');

  const userRows = users
    .map(user => {
      const isCurrent = user.id === currentUser.userId;
      return `<div class="user-row">
        <div class="user-main">
          <div class="user-title">${htmlEscape(user.displayName)} <span class="muted">@${htmlEscape(user.username)}</span></div>
          <div class="muted">Role: ${user.role}</div>
        </div>
        <form method="post" action="/users/password" class="inline-form">
          <input type="hidden" name="userId" value="${user.id}" />
          <input type="password" name="password" placeholder="New password (min 8)" required />
          <button type="submit" class="small-btn">Set Password</button>
        </form>
        <form method="post" action="/users/update" class="inline-form">
          <input type="hidden" name="userId" value="${user.id}" />
          <input name="displayName" value="${htmlEscape(user.displayName)}" required />
          <select name="role">
            <option value="user" ${user.role === 'user' ? 'selected' : ''}>user</option>
            <option value="admin" ${user.role === 'admin' ? 'selected' : ''}>admin</option>
          </select>
          <button type="submit" class="small-btn">Update</button>
        </form>
        ${user.id !== 'admin'
          ? `<form method="post" action="/users/delete" class="inline-form" onsubmit="return confirm('Delete user ${htmlEscape(user.username)}?')">
              <input type="hidden" name="userId" value="${user.id}" />
              <button type="submit" class="small-btn danger">Delete</button>
            </form>`
          : '<div class="muted">default admin</div>'}
        ${isCurrent ? '<div class="muted">Current session</div>' : ''}
      </div>`;
    })
    .join('');

  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>FeedLedger Control Panel</title>
  <style>
    :root {
      color-scheme: light;
      --bg-start: #eef3fb;
      --bg-end: #f4f7fb;
      --card: #ffffff;
      --text: #1a2233;
      --muted: #4e5b70;
      --label: #273349;
      --line: #d7deea;
      --accent: #1363df;
      --accent-soft: #e8f0ff;
      --chip-text: #174ea6;
      --chip-border: #c8d7f7;
      --input-bg: #ffffff;
      --input-text: #1a2233;
      --input-border: #c3cedf;
      --ok-bg: #effaf3;
      --ok-line: #cae9d5;
      --ok: #177a43;
      --err-bg: #fff1f1;
      --err-line: #f2caca;
      --err: #b03a3a;
      --shadow: rgba(34, 63, 109, 0.06);
    }
    :root[data-theme="dark"] {
      color-scheme: dark;
      --bg-start: #0e1624;
      --bg-end: #0a1019;
      --card: #141e2d;
      --text: #e7eef9;
      --muted: #b8c6dc;
      --label: #dbe6f6;
      --line: #32455f;
      --accent: #7ab0ff;
      --accent-soft: #1d2f4a;
      --chip-text: #d5e6ff;
      --chip-border: #46648b;
      --input-bg: #0f1928;
      --input-text: #f2f6ff;
      --input-border: #455d7e;
      --ok-bg: #103526;
      --ok-line: #1f6b49;
      --ok: #93efbe;
      --err-bg: #3a1f28;
      --err-line: #6d2f43;
      --err: #ffb6c4;
      --shadow: rgba(4, 8, 14, 0.36);
    }
    :root[data-theme="ocean"] {
      color-scheme: light;
      --bg-start: #e5f6fb;
      --bg-end: #ecf8fb;
      --card: #ffffff;
      --text: #173748;
      --muted: #4f6f80;
      --label: #1f5569;
      --line: #c8ddea;
      --accent: #0087b8;
      --accent-soft: #def4fc;
      --chip-text: #075f81;
      --chip-border: #b5dff0;
      --input-bg: #ffffff;
      --input-text: #173748;
      --input-border: #b8d2df;
      --ok-bg: #ebf9f2;
      --ok-line: #c5e7d4;
      --ok: #0f8d58;
      --err-bg: #fff1f1;
      --err-line: #f2caca;
      --err: #b03a3a;
      --shadow: rgba(19, 61, 87, 0.1);
    }
    * { box-sizing: border-box; }
    body { margin: 0; background: linear-gradient(180deg, var(--bg-start) 0%, var(--bg-end) 100%); color: var(--text); font-family: "Segoe UI", "Inter", sans-serif; min-height: 100vh; }
    .wrap { max-width: 1100px; margin: 26px auto 40px; padding: 0 16px; }
    .top { display: flex; justify-content: space-between; align-items: center; gap: 12px; margin-bottom: 14px; }
    .title h1 { margin: 0; font-size: 28px; }
    .title p { margin: 4px 0 0; color: var(--muted); font-size: 13px; }
    .top-right { display: flex; align-items: center; gap: 10px; }
    .theme-select, .logout, .user-select { border: 1px solid var(--line); background: var(--card); color: var(--text); border-radius: 10px; padding: 9px 10px; font-size: 13px; }
    .logout { text-decoration: none; }
    .ok { border: 1px solid var(--ok-line); background: var(--ok-bg); color: var(--ok); border-radius: 10px; padding: 10px 12px; margin-bottom: 14px; font-size: 14px; }
    .err { border: 1px solid var(--err-line); background: var(--err-bg); color: var(--err); border-radius: 10px; padding: 10px 12px; margin-bottom: 14px; font-size: 14px; }
    form { display: grid; gap: 14px; }
    .card { background: var(--card); border: 1px solid var(--line); border-radius: 14px; padding: 16px; box-shadow: 0 6px 18px var(--shadow); }
    .card h2 { margin: 0 0 10px; font-size: 18px; }
    .grid-2 { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
    label { display: block; font-size: 13px; color: var(--label); margin-bottom: 6px; }
    input, select { width: 100%; border: 1px solid var(--input-border); border-radius: 10px; padding: 10px 11px; font-size: 14px; background: var(--input-bg); color: var(--input-text); }
    input[type="time"] { font-variant-numeric: tabular-nums; }
    .chips { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 8px; }
    .chip { border: 1px solid var(--chip-border); background: var(--accent-soft); color: var(--chip-text); padding: 6px 10px; border-radius: 999px; cursor: pointer; font-size: 12px; }
    .check { display: flex; gap: 8px; align-items: center; font-size: 13px; color: var(--text); }
    .check-list { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 8px 12px; margin-top: 12px; }
    .check input[type="checkbox"] { width: auto; margin: 0; accent-color: var(--accent); }
    .muted { color: var(--muted); font-size: 12px; }
    .interest-input-wrap { display: grid; grid-template-columns: 1fr auto; gap: 8px; margin-top: 10px; }
    .small-btn { border: 1px solid var(--line); background: var(--card); color: var(--text); border-radius: 10px; padding: 8px 10px; font-size: 13px; cursor: pointer; }
    .small-btn.danger { border-color: #d58f8f; color: #b33939; background: #fff5f5; }
    .tag-list { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 10px; }
    .tag { display: inline-flex; align-items: center; gap: 6px; border: 1px solid var(--chip-border); background: var(--accent-soft); color: var(--chip-text); border-radius: 999px; padding: 5px 9px; font-size: 12px; }
    .tag button { border: 0; background: transparent; color: inherit; cursor: pointer; font-size: 12px; padding: 0; }
    .feed-list { display: grid; gap: 10px; margin-top: 8px; }
    .feed-tools {
      display: grid;
      grid-template-columns: 1fr 220px 170px;
      gap: 8px;
      margin-top: 10px;
      align-items: center;
    }
    .add-feed-grid {
      display: grid;
      grid-template-columns: 2fr 0.9fr 1fr auto;
      gap: 8px;
      margin-top: 10px;
      align-items: center;
    }
    .feed-row { border: 1px solid var(--line); border-radius: 12px; padding: 10px; background: color-mix(in srgb, var(--card) 88%, var(--accent-soft) 12%); display: grid; gap: 8px; }
    .feed-grid { display: grid; grid-template-columns: 1.1fr 2fr 0.8fr 1fr 0.8fr auto auto; gap: 8px; align-items: center; }
    .feed-name { border: 1px solid var(--line); border-radius: 10px; padding: 10px 11px; background: color-mix(in srgb, var(--card) 82%, var(--accent-soft) 18%); font-size: 13px; color: var(--label); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .feed-del { border: 1px solid #d58f8f; background: #fff5f5; color: #b33939; border-radius: 10px; padding: 8px 10px; cursor: pointer; font-size: 12px; }
    .feed-stats { margin-top: 8px; }
    .project-list { display: grid; gap: 10px; margin-top: 10px; }
    .project-card { border: 1px solid var(--line); border-radius: 12px; background: color-mix(in srgb, var(--card) 88%, var(--accent-soft) 12%); padding: 10px; }
    .project-head { display: grid; grid-template-columns: 1.4fr auto auto auto; gap: 8px; align-items: center; }
    .project-tools { display: grid; grid-template-columns: 2fr auto auto auto auto auto; gap: 8px; margin-top: 8px; align-items: center; }
    .project-prompt { margin-top: 8px; white-space: pre-wrap; border: 1px dashed var(--line); border-radius: 10px; padding: 8px; font-size: 12px; color: var(--muted); background: color-mix(in srgb, var(--card) 92%, var(--accent-soft) 8%); }
    .project-feeds-wrap { margin-top: 8px; padding-top: 8px; border-top: 1px dashed var(--line); display: none; }
    .project-feeds-wrap.open { display: block; }
    .project-feed-list { display: grid; gap: 8px; margin-top: 8px; }
    .project-feed-grid { display: grid; grid-template-columns: 1.1fr 2fr 0.9fr 0.8fr auto auto; gap: 8px; align-items: center; }
    .project-name-badge { border: 1px solid var(--line); border-radius: 10px; padding: 9px 10px; background: color-mix(in srgb, var(--card) 82%, var(--accent-soft) 18%); font-size: 13px; color: var(--label); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .actions { display: flex; justify-content: flex-end; gap: 10px; margin-top: 6px; }
    .save { border: 0; background: var(--accent); color: #fff; padding: 11px 16px; border-radius: 10px; font-weight: 600; cursor: pointer; }
    .user-row { border: 1px solid var(--line); border-radius: 12px; padding: 10px; display: grid; gap: 8px; margin-bottom: 8px; }
    .user-title { font-weight: 600; }
    .inline-form { display: grid; grid-template-columns: 1fr auto auto; gap: 8px; }
    .inline-form input, .inline-form select { padding: 8px 9px; }
    @media (max-width: 900px) {
      .grid-2 { grid-template-columns: 1fr; }
      .top { flex-direction: column; align-items: flex-start; }
      .top-right { width: 100%; justify-content: space-between; flex-wrap: wrap; }
      .feed-grid { grid-template-columns: 1fr; }
      .feed-tools { grid-template-columns: 1fr; }
      .add-feed-grid { grid-template-columns: 1fr; }
      .project-head { grid-template-columns: 1fr; }
      .project-tools { grid-template-columns: 1fr; }
      .project-feed-grid { grid-template-columns: 1fr; }
      .inline-form { grid-template-columns: 1fr; }
    }
  </style>
</head>
<body>
  <div class="wrap">
    <div class="top">
      <div class="title">
        <h1>FeedLedger Control Panel</h1>
        <p>Logged in as ${htmlEscape(currentUser.displayName)} (@${htmlEscape(currentUser.username)}) · role: ${currentUser.role}</p>
      </div>
      <div class="top-right">
        <select id="themeSelect" class="theme-select" aria-label="Theme">
          <option value="light">Light</option>
          <option value="dark">Dark</option>
          <option value="ocean">Ocean</option>
          <option value="system">System</option>
        </select>
        <a class="logout" href="/reader">Reader</a>
        <a class="logout" href="/logout">Logout</a>
      </div>
    </div>

    ${message ? `<div class="ok">${htmlEscape(message)}</div>` : ''}
    ${error ? `<div class="err">${htmlEscape(error)}</div>` : ''}

    ${currentUser.role === 'admin' ? `<form method="get" action="/" class="card" style="margin-bottom:14px;">
      <h2>Target User</h2>
      <div class="muted" style="margin-bottom:8px;">Edit runtime settings for selected user</div>
      <select class="user-select" name="userId" onchange="this.form.submit()">${userPickerOptions}</select>
    </form>` : ''}

    <form id="settingsForm" method="post" action="/settings">
      <input type="hidden" name="targetUserId" value="${resolvedTargetUserId}" />
      <input type="hidden" id="interestsJson" name="interestsJson" value="[]" />
      <input type="hidden" id="feedsJson" name="feedsJson" value="[]" />
      <input type="hidden" id="specialProjectsJson" name="specialProjectsJson" value="[]" />

      <section class="card">
        <h2>AI</h2>
        <div class="grid-2">
          <div>
            <label>Gemini Model</label>
            <select name="geminiModel">${geminiModelOptions}</select>
          </div>
          <div>
            <label>OpenRouter Model</label>
            <select name="openrouterModel">${openrouterModelOptions}</select>
          </div>
        </div>
        <div class="grid-2" style="margin-top:10px;">
          <div>
            <label>Gemini API Key</label>
            <input type="password" autocomplete="off" name="geminiApiKey" value="${htmlEscape(maskedGeminiApiKey)}" />
          </div>
          <div>
            <label>OpenRouter API Key</label>
            <input type="password" autocomplete="off" name="openrouterApiKey" value="${htmlEscape(maskedOpenrouterApiKey)}" />
          </div>
        </div>
        <div class="muted" style="margin-top:8px;">
          OpenRouter list includes multiple vendors (OpenAI, Anthropic, DeepSeek, Meta, xAI, Mistral, Qwen).
        </div>
        <div class="muted" style="margin-top:6px;">
          Active now: ${htmlEscape(activeAiLabel)}
        </div>
        <div class="actions" style="margin-top:10px; justify-content:flex-start;">
          <button type="submit" class="small-btn" name="saveMode" value="ai-gemini">Set Gemini Active</button>
          <button type="submit" class="small-btn" name="saveMode" value="ai-openrouter">Set OpenRouter Active</button>
          <span class="muted">Selected button decides active vendor. Only AI fields are updated.</span>
        </div>
      </section>

      <section class="card">
        <h2>Reporting</h2>
        <div class="grid-2">
          <div>
            <label>Report Grouping Mode</label>
            <select name="reportGroupingMode">${reportGroupingOptions}</select>
          </div>
          <div>
            <label>Report Period</label>
            <select name="reportPeriodDays">${reportPeriodOptions}</select>
          </div>
        </div>
      </section>

      <section class="card">
        <h2>Interests</h2>
        <div class="muted">Preset interests</div>
        <div class="chips">${interestPresetChips}</div>
        <div class="interest-input-wrap">
          <input id="interestInput" placeholder="Add custom interest and press Add" />
          <button type="button" class="small-btn" id="addInterestBtn">Add</button>
        </div>
        <div id="interestSaveStatus" class="muted" style="margin-top:6px;"></div>
        <div id="interestList" class="tag-list"></div>
      </section>

      <section class="card">
        <h2>RSS Feeds</h2>
        <div class="muted">Configure sources for News and Papers pipelines. Disabled feeds are skipped.</div>
        <div class="add-feed-grid">
          <input id="newFeedUrl" placeholder="https://example.com/feed.xml" />
          <select id="newFeedGroup" aria-label="New feed group">
            <option value="news">News</option>
            <option value="papers">Papers</option>
          </select>
          <select id="newFeedInterest" aria-label="New feed interest">
            <option value="">No specific interest</option>
          </select>
          <button type="button" class="small-btn" id="addFeedBtn">Add Feed</button>
        </div>
        <div id="newFeedModeInfo" class="muted" style="margin-top:6px;"></div>
        <div class="feed-tools">
          <input id="feedSearchInput" placeholder="Search by feed name or URL" />
          <select id="feedInterestFilter" aria-label="Filter by interest">
            <option value="__all__">Show all interests</option>
          </select>
          <select id="feedGroupFilter" aria-label="Filter by source group">
            <option value="all">All source groups</option>
            <option value="news">News only</option>
            <option value="papers">Papers only</option>
          </select>
        </div>
        <div id="feedError" class="muted" style="color:#b03a3a;"></div>
        <div id="feedStats" class="muted feed-stats"></div>
        <div class="feed-list" id="feedList"></div>
      </section>

      <section class="card">
        <h2>Special Projects</h2>
        <div class="muted">Create project-specific pipelines. Add project, add its RSS feeds, and prompt/interests are auto-generated by Gemini.</div>
        <div class="project-tools">
          <input id="newProjectName" placeholder="Project name (e.g. Iron Man)" />
          <label class="check"><input type="checkbox" id="newProjectStrict" checked /> Strict match</label>
          <button type="button" class="small-btn" id="addProjectBtn">Add Project</button>
          <div class="muted" id="projectStats"></div>
          <div></div>
          <div></div>
        </div>
        <div id="projectError" class="muted" style="color:#b03a3a;"></div>
        <div id="projectList" class="project-list"></div>
      </section>

      <section class="card">
        <h2>Integrations</h2>
        <div class="grid-2">
          <div>
            <label>Notion API Key</label>
            <input type="password" autocomplete="off" name="notionApiKey" value="${htmlEscape(maskedNotionApiKey)}" />
          </div>
          <div>
            <label>Notion Parent Page ID / URL</label>
            <input name="notionParentPageId" value="${htmlEscape(settings.notionParentPageId)}" />
          </div>
        </div>
        <div class="grid-2" style="margin-top:10px;">
          <div>
            <label>Telegram Bot Token</label>
            <input type="password" autocomplete="off" name="telegramBotToken" value="${htmlEscape(maskedTelegramBotToken)}" />
          </div>
          <div>
            <label>Telegram Chat ID</label>
            <input type="password" autocomplete="off" name="telegramChatId" value="${htmlEscape(maskedTelegramChatId)}" />
          </div>
        </div>
        <div class="grid-2" style="margin-top:10px;">
          <div>
            <label>Mammoth URI</label>
            <input name="mammothUri" value="${htmlEscape(settings.mammothUri)}" />
          </div>
          <div>
            <label>Mammoth Database</label>
            <input name="mammothDatabase" value="${htmlEscape(settings.mammothDatabase)}" />
          </div>
        </div>
        <div class="check-list">
          <label class="check">
            <input type="checkbox" name="mammothEnabled" value="1" ${settings.mammothEnabled ? 'checked' : ''} />
            Mammoth Reader Storage
          </label>
          <label class="check">
            <input type="checkbox" name="notionQuotaAutoclean" value="1" ${settings.notionQuotaAutoclean ? 'checked' : ''} />
            Notion Auto-clean
          </label>
        </div>
      </section>

      <section class="card">
        <h2>Scheduling</h2>
        <div class="grid-2">
          <div>
            <label>RSS Scan Time</label>
            <input id="dailyScanTime" name="dailyScanTime" type="time" step="900" value="${htmlEscape(settings.dailyScanTime)}" required />
            <div class="chips">${scanPresets}</div>
          </div>
          <div>
            <label>Telegram Send Time</label>
            <input id="dailySendTime" name="dailySendTime" type="time" step="900" value="${htmlEscape(settings.dailySendTime)}" required />
            <div class="chips">${sendPresets}</div>
          </div>
        </div>
        <div class="grid-2" style="margin-top:10px;">
          <div>
            <label>Timezone</label>
            <select name="reportTimezone">${timezoneOptions}</select>
          </div>
        </div>
      </section>

      <section class="card">
        <h2>Messaging</h2>
        <div class="grid-2">
          <div>
            <label>Greeting</label>
            <input name="assistantGreeting" value="${htmlEscape(settings.assistantGreeting)}" />
          </div>
          <div>
            <label>Signature</label>
            <input name="assistantSignature" value="${htmlEscape(settings.assistantSignature)}" />
          </div>
        </div>
      </section>

      <div class="actions">
        <button class="save" type="submit">Save and Apply</button>
      </div>
    </form>

    ${currentUser.role === 'admin' ? `<section class="card" style="margin-top:14px;">
      <h2>User Management</h2>
      <form method="post" action="/users/create">
        <div class="grid-2">
          <div>
            <label>Username</label>
            <input name="username" required placeholder="example: analyst" />
          </div>
          <div>
            <label>Display Name</label>
            <input name="displayName" required placeholder="Analyst" />
          </div>
        </div>
        <div class="grid-2">
          <div>
            <label>Role</label>
            <select name="role">
              <option value="user">user</option>
              <option value="admin">admin</option>
            </select>
          </div>
          <div>
            <label>Initial Password</label>
            <input type="password" name="password" required placeholder="min 8 chars" />
          </div>
        </div>
        <div class="actions"><button class="save" type="submit">Create User</button></div>
      </form>
      <div style="margin-top:10px;">${userRows || '<div class="muted">No users</div>'}</div>
    </section>` : ''}
  </div>

  <script>
    document.querySelectorAll('.chip').forEach((btn) => {
      btn.addEventListener('click', () => {
        const target = document.getElementById(btn.dataset.target);
        if (target) target.value = btn.dataset.time;
      });
    });

    const themeSelect = document.getElementById('themeSelect');
    const storageKey = 'feedledger_theme';
    const legacyKeys = [];
    const settingsForm = document.getElementById('settingsForm');
    const targetUserIdInput = settingsForm?.querySelector('input[name="targetUserId"]');
    const interestsInput = document.getElementById('interestsJson');
    const feedsInput = document.getElementById('feedsJson');
    const specialProjectsInput = document.getElementById('specialProjectsJson');
    const interestList = document.getElementById('interestList');
    const interestInput = document.getElementById('interestInput');
    const addInterestBtn = document.getElementById('addInterestBtn');
    const interestSaveStatus = document.getElementById('interestSaveStatus');
    const feedList = document.getElementById('feedList');
    const addFeedBtn = document.getElementById('addFeedBtn');
    const newFeedUrl = document.getElementById('newFeedUrl');
    const newFeedGroup = document.getElementById('newFeedGroup');
    const newFeedInterest = document.getElementById('newFeedInterest');
    const newFeedModeInfo = document.getElementById('newFeedModeInfo');
    const feedSearchInput = document.getElementById('feedSearchInput');
    const feedInterestFilter = document.getElementById('feedInterestFilter');
    const feedGroupFilter = document.getElementById('feedGroupFilter');
    const feedStats = document.getElementById('feedStats');
    const feedError = document.getElementById('feedError');
    const projectList = document.getElementById('projectList');
    const projectStats = document.getElementById('projectStats');
    const projectError = document.getElementById('projectError');
    const newProjectName = document.getElementById('newProjectName');
    const newProjectStrict = document.getElementById('newProjectStrict');
    const addProjectBtn = document.getElementById('addProjectBtn');
    const initialInterests = ${inlineInterests};
    const initialFeeds = ${inlineFeeds};
    const initialSpecialProjects = ${inlineSpecialProjects};

    function resolveSystemTheme() {
      return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    }

    function applyTheme(value) {
      const selected = value === 'system' ? resolveSystemTheme() : value;
      document.documentElement.setAttribute('data-theme', selected);
    }

    let savedTheme = localStorage.getItem(storageKey);
    if (!savedTheme) {
      savedTheme = legacyKeys.map((key) => localStorage.getItem(key)).find(Boolean) || 'light';
      localStorage.setItem(storageKey, savedTheme);
    }
    themeSelect.value = savedTheme;
    applyTheme(savedTheme);

    themeSelect.addEventListener('change', () => {
      const nextTheme = themeSelect.value;
      localStorage.setItem(storageKey, nextTheme);
      applyTheme(nextTheme);
    });

    function normalizeInterest(value) {
      return String(value || '').trim().replace(/\\s+/g, ' ');
    }

    let interests = Array.isArray(initialInterests)
      ? initialInterests.map(normalizeInterest).filter(Boolean)
      : [];
    interests = Array.from(new Set(interests.map((value) => value.toLowerCase())))
      .map((lower) => interests.find((item) => item.toLowerCase() === lower))
      .filter(Boolean);
    let interestPersistTimer = null;
    let interestPersistVersion = 0;

    function syncInterests() {
      interestsInput.value = JSON.stringify(interests);
    }

    function removeInterest(index) {
      interests.splice(index, 1);
      renderInterests({ persist: true });
    }

    function addInterest(raw) {
      const value = normalizeInterest(raw);
      if (!value) return;
      if (interests.some((item) => item.toLowerCase() === value.toLowerCase())) return;
      interests.push(value);
      renderInterests({ persist: true });
    }

    function setInterestSaveStatus(text, isError) {
      if (!interestSaveStatus) return;
      interestSaveStatus.textContent = text || '';
      interestSaveStatus.style.color = isError ? '#b03a3a' : '';
    }

    async function persistInterestsNow() {
      const targetUserId = (targetUserIdInput?.value || '').trim();
      if (!targetUserId) return;

      const payload = new URLSearchParams();
      payload.set('targetUserId', targetUserId);
      payload.set('interestsJson', JSON.stringify(interests));
      const version = ++interestPersistVersion;
      setInterestSaveStatus('Saving interests...', false);

      try {
        const response = await fetch('/settings/interests', {
          method: 'POST',
          credentials: 'same-origin',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
          },
          body: payload.toString(),
        });
        if (!response.ok) {
          throw new Error('HTTP ' + response.status);
        }
        if (version === interestPersistVersion) {
          setInterestSaveStatus('Interests saved.', false);
        }
      } catch {
        if (version === interestPersistVersion) {
          setInterestSaveStatus('Could not save interests. Use Save and Apply.', true);
        }
      }
    }

    function scheduleInterestPersist() {
      if (interestPersistTimer) {
        clearTimeout(interestPersistTimer);
      }
      interestPersistTimer = setTimeout(() => {
        interestPersistTimer = null;
        persistInterestsNow();
      }, 250);
    }

    function renderInterests(options) {
      interestList.innerHTML = '';
      interests.forEach((value, index) => {
        const tag = document.createElement('span');
        tag.className = 'tag';
        tag.innerHTML = '<span></span><button type="button">x</button>';
        tag.querySelector('span').textContent = value;
        tag.querySelector('button').addEventListener('click', () => removeInterest(index));
        interestList.appendChild(tag);
      });
      syncInterests();
      rebuildFeedInterestFilter();
      rebuildNewFeedInterestOptions();
      renderFeeds();
      if (options?.persist) {
        scheduleInterestPersist();
      }
    }

    addInterestBtn?.addEventListener('click', () => {
      addInterest(interestInput.value);
      interestInput.value = '';
      interestInput.focus();
    });

    interestInput?.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        addInterest(interestInput.value);
        interestInput.value = '';
      }
    });

    document.querySelectorAll('.interest-preset').forEach((chip) => {
      chip.addEventListener('click', () => addInterest(chip.dataset.interest || ''));
    });

    function makeFeedId() {
      return 'feed-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 7);
    }

    let feeds = Array.isArray(initialFeeds) ? initialFeeds : [];
    feeds.forEach((feed) => ensureFeedName(feed));
    let feedSearchText = '';
    let selectedInterestFilter = '__all__';
    let selectedGroupFilter = 'all';

    function syncFeeds() {
      feeds.forEach((feed) => {
        if (!feed || typeof feed !== 'object') return;
        feed.name = deriveFeedNameFromUrl(feed.url || '');
      });
      feedsInput.value = JSON.stringify(feeds);
    }

    function clearFeedError() {
      if (feedError) feedError.textContent = '';
    }

    function setFeedError(message) {
      if (feedError) feedError.textContent = message || '';
    }

    function deriveFeedNameFromUrl(rawUrl) {
      const url = String(rawUrl || '').trim();
      if (!url) return 'Untitled Feed';
      try {
        const parsed = new URL(url);
        const host = parsed.hostname.toLowerCase().startsWith('www.')
          ? parsed.hostname.slice(4)
          : parsed.hostname;
        const hostParts = host.split('.').filter(Boolean);
        const hostCore = hostParts.length >= 2 ? hostParts[hostParts.length - 2] : (hostParts[0] || host);
        const cleanedHost = hostCore.replaceAll('-', ' ').replaceAll('_', ' ').trim();
        const pathParts = parsed.pathname.split('/').map((part) => part.trim()).filter(Boolean);
        const pathCore = pathParts.find((part) => {
          const lower = part.toLowerCase();
          return lower !== 'rss' && lower !== 'feed' && lower !== 'feeds' && lower !== 'index.xml' && lower !== 'xml';
        }) || '';
        const rawName = (cleanedHost + ' ' + pathCore).trim() || host;
        const normalized = rawName
          .replaceAll('-', ' ')
          .replaceAll('_', ' ')
          .trim()
          .split(' ')
          .filter(Boolean)
          .join(' ');
        return normalized
          .split(' ')
          .map((word) => word ? (word[0].toUpperCase() + word.slice(1).toLowerCase()) : word)
          .join(' ');
      } catch {
        let fallback = url;
        if (fallback.startsWith('https://')) fallback = fallback.slice(8);
        if (fallback.startsWith('http://')) fallback = fallback.slice(7);
        fallback = fallback.split('/')[0] || fallback;
        if (fallback.toLowerCase().startsWith('www.')) fallback = fallback.slice(4);
        return fallback.trim() || 'Untitled Feed';
      }
    }

    function ensureFeedName(feed) {
      if (!feed || typeof feed !== 'object') return 'Untitled Feed';
      const name = deriveFeedNameFromUrl(feed.url || '');
      feed.name = name;
      return name;
    }

    function findInvalidFeedIndex() {
      for (let i = 0; i < feeds.length; i += 1) {
        const feed = feeds[i] || {};
        const url = String(feed.url || '').trim();
        if (!url) return i;
        try {
          const parsed = new URL(url);
          if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return i;
        } catch {
          return i;
        }
      }
      return -1;
    }

    function rebuildFeedInterestFilter() {
      if (!feedInterestFilter) return;
      const previous = selectedInterestFilter;
      feedInterestFilter.innerHTML = '';

      const allOption = document.createElement('option');
      allOption.value = '__all__';
      allOption.textContent = 'Show all interests';
      feedInterestFilter.appendChild(allOption);

      interests.forEach((interest) => {
        const option = document.createElement('option');
        option.value = interest;
        option.textContent = interest;
        feedInterestFilter.appendChild(option);
      });

      const stillExists = previous === '__all__' || interests.includes(previous);
      selectedInterestFilter = stillExists ? previous : '__all__';
      feedInterestFilter.value = selectedInterestFilter;
      applyAddFeedInterestMode();
    }

    function rebuildNewFeedInterestOptions() {
      if (!newFeedInterest) return;
      const previous = newFeedInterest.value || '';
      newFeedInterest.innerHTML = '';

      const emptyOption = document.createElement('option');
      emptyOption.value = '';
      emptyOption.textContent = 'No specific interest';
      newFeedInterest.appendChild(emptyOption);

      interests.forEach((interest) => {
        const option = document.createElement('option');
        option.value = interest;
        option.textContent = interest;
        newFeedInterest.appendChild(option);
      });

      const stillExists = previous === '' || interests.includes(previous);
      newFeedInterest.value = stillExists ? previous : '';
      applyAddFeedInterestMode();
    }

    function applyAddFeedInterestMode() {
      if (!newFeedInterest) return;

      if (selectedInterestFilter !== '__all__') {
        newFeedInterest.disabled = true;
        newFeedInterest.value = selectedInterestFilter;
        if (newFeedModeInfo) {
          newFeedModeInfo.textContent = 'Interest is auto-assigned from active filter: ' + selectedInterestFilter;
        }
      } else {
        newFeedInterest.disabled = false;
        if (newFeedModeInfo) {
          newFeedModeInfo.textContent = 'Show all mode: choose interest and News/Papers when adding a feed.';
        }
      }
    }

    function feedMatchesInterest(feed) {
      if (selectedInterestFilter === '__all__') return true;
      const hint = String(feed.interestHint || '').trim();
      if (hint && hint.toLowerCase() === selectedInterestFilter.toLowerCase()) return true;
      const haystack = ((feed.name || '') + ' ' + (feed.url || '')).toLowerCase();
      return haystack.includes(selectedInterestFilter.toLowerCase());
    }

    function renderFeeds() {
      feedList.innerHTML = '';
      const query = feedSearchText.trim().toLowerCase();
      const visible = feeds
        .map((feed, index) => ({ feed, index }))
        .filter(({ feed }) => {
          const group = feed.group === 'papers' ? 'papers' : 'news';
          const groupOk = selectedGroupFilter === 'all' || group === selectedGroupFilter;
          const textOk = !query || ((feed.name || '') + ' ' + (feed.url || '')).toLowerCase().includes(query);
          const interestOk = feedMatchesInterest(feed);
          return groupOk && textOk && interestOk;
        });

      visible.forEach(({ feed, index }) => {
        const row = document.createElement('div');
        row.className = 'feed-row';
        row.innerHTML = '<div class="feed-grid">'
          + '<div class="feed-name"></div>'
          + '<input data-field="url" placeholder="https://..." />'
          + '<select data-field="group"><option value="news">News</option><option value="papers">Papers</option></select>'
          + '<select data-field="interestHint"></select>'
          + '<select data-field="priority"><option value="normal">Normal</option><option value="high">High</option></select>'
          + '<label class="check"><input type="checkbox" data-field="enabled" /> Enabled</label>'
          + '<button type="button" class="feed-del">Delete</button>'
          + '</div>';

        row.querySelector('.feed-name').textContent = ensureFeedName(feed);
        row.querySelector('[data-field="url"]').value = feed.url || '';
        row.querySelector('[data-field="group"]').value = feed.group === 'papers' ? 'papers' : 'news';
        const interestSelect = row.querySelector('[data-field="interestHint"]');
        interestSelect.innerHTML = '';
        const optionNone = document.createElement('option');
        optionNone.value = '';
        optionNone.textContent = 'No specific interest';
        interestSelect.appendChild(optionNone);
        interests.forEach((interest) => {
          const option = document.createElement('option');
          option.value = interest;
          option.textContent = interest;
          interestSelect.appendChild(option);
        });
        interestSelect.value = interests.includes(feed.interestHint || '')
          ? (feed.interestHint || '')
          : '';
        row.querySelector('[data-field="priority"]').value = feed.priority === 'high' ? 'high' : 'normal';
        row.querySelector('[data-field="enabled"]').checked = feed.enabled !== false;

        row.querySelector('.feed-del').addEventListener('click', () => {
          feeds.splice(index, 1);
          renderFeeds();
        });

        row.querySelectorAll('[data-field]').forEach((field) => {
          field.addEventListener('input', () => {
            const key = field.dataset.field;
            if (!key) return;
            if (key === 'enabled') {
              feed.enabled = !!field.checked;
            } else {
              feed[key] = field.value;
            }
            if (key === 'url') {
              row.querySelector('.feed-name').textContent = ensureFeedName(feed);
            }
            clearFeedError();
            syncFeeds();
          });
          field.addEventListener('change', () => {
            const key = field.dataset.field;
            if (!key) return;
            if (key === 'enabled') {
              feed.enabled = !!field.checked;
            } else {
              feed[key] = field.value;
            }
            if (key === 'url') {
              row.querySelector('.feed-name').textContent = ensureFeedName(feed);
            }
            clearFeedError();
            syncFeeds();
          });
        });

        feedList.appendChild(row);
      });
      if (feedStats) {
        feedStats.textContent = visible.length + '/' + feeds.length + ' feed shown';
      }
      syncFeeds();
    }

    addFeedBtn?.addEventListener('click', () => {
      const invalidIndex = findInvalidFeedIndex();
      if (invalidIndex !== -1) {
        setFeedError('Please complete existing feed rows (valid URL) before adding a new one.');
        return;
      }
      const url = (newFeedUrl?.value || '').trim();
      const group = (newFeedGroup?.value || 'news') === 'papers' ? 'papers' : 'news';
      const interestHint = selectedInterestFilter !== '__all__'
        ? selectedInterestFilter
        : (newFeedInterest?.value || '').trim();

      if (!url) {
        setFeedError('Feed URL is required.');
        return;
      }
      if (selectedInterestFilter === '__all__' && !interestHint) {
        setFeedError('When filter is Show all, selecting an interest is required for new feeds.');
        return;
      }
      try {
        const parsed = new URL(url);
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
          setFeedError('Feed URL must start with http:// or https://');
          return;
        }
      } catch {
        setFeedError('Feed URL is not valid.');
        return;
      }

      clearFeedError();
      feeds.push({
        id: makeFeedId(),
        name: deriveFeedNameFromUrl(url),
        url,
        group,
        interestHint,
        priority: 'normal',
        enabled: true,
      });
      if (newFeedUrl) newFeedUrl.value = '';
      if (newFeedInterest && selectedInterestFilter === '__all__') newFeedInterest.value = '';
      renderFeeds();
    });

    feedSearchInput?.addEventListener('input', () => {
      feedSearchText = feedSearchInput.value || '';
      renderFeeds();
    });

    feedInterestFilter?.addEventListener('change', () => {
      selectedInterestFilter = feedInterestFilter.value || '__all__';
      applyAddFeedInterestMode();
      renderFeeds();
    });

    feedGroupFilter?.addEventListener('change', () => {
      selectedGroupFilter = feedGroupFilter.value || 'all';
      renderFeeds();
    });

    function clearProjectError() {
      if (projectError) projectError.textContent = '';
    }

    function setProjectError(message) {
      if (projectError) projectError.textContent = message || '';
    }

    function makeProjectId() {
      return 'project-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 7);
    }

    function makeProjectFeedId() {
      return 'pfeed-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 7);
    }

    function feedKey(feed) {
      const url = String(feed?.url || '').trim().toLowerCase();
      const group = feed?.group === 'papers' ? 'papers' : 'news';
      return url + '|' + group;
    }

    function projectSlug(value) {
      return String(value || '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '');
    }

    function normalizeProject(raw, index) {
      const item = raw && typeof raw === 'object' ? raw : {};
      const name = normalizeInterest(item.name || '');
      if (!name) return null;

      const feeds = Array.isArray(item.feeds) ? item.feeds : [];
      const normalizedFeeds = feeds
        .map((feed) => {
          const source = feed && typeof feed === 'object' ? feed : {};
          const url = String(source.url || '').trim();
          if (!url) return null;
          let valid = false;
          try {
            const parsed = new URL(url);
            valid = parsed.protocol === 'http:' || parsed.protocol === 'https:';
          } catch {
            valid = false;
          }
          if (!valid) return null;
          const group = source.group === 'papers' ? 'papers' : 'news';
          const priority = source.priority === 'high' ? 'high' : 'normal';
          return {
            id: String(source.id || '').trim() || makeProjectFeedId(),
            name: deriveFeedNameFromUrl(url),
            url,
            group,
            interestHint: String(source.interestHint || '').trim(),
            priority,
            enabled: source.enabled !== false,
          };
        })
        .filter(Boolean);

      const interests = Array.isArray(item.interests)
        ? Array.from(new Set(item.interests.map((value) => normalizeInterest(value)).filter(Boolean)))
        : [];
      const prompt = String(item.prompt || '').trim();

      return {
        id: String(item.id || '').trim() || makeProjectId(),
        name,
        enabled: item.enabled !== false,
        strictInterestMatch: item.strictInterestMatch !== false,
        prompt,
        interests,
        feeds: normalizedFeeds,
        expanded: Boolean(item.expanded),
      };
    }

    let specialProjects = (Array.isArray(initialSpecialProjects) ? initialSpecialProjects : [])
      .map((project, index) => normalizeProject(project, index))
      .filter(Boolean);

    // Backward compatibility: if project feeds were historically kept in global feeds,
    // auto-attach them to matching project by feed id prefix and hide them from global list.
    for (const project of specialProjects) {
      const slug = projectSlug(project.name);
      const compact = slug.replace(/-/g, '');
      const belongsToProject = (feed) => {
        const id = String(feed?.id || '').toLowerCase();
        if (!id) return false;
        return (
          (slug && id.startsWith(slug + '-'))
          || (compact && id.startsWith(compact + '-'))
        );
      };

      const projectKeys = new Set((Array.isArray(project.feeds) ? project.feeds : []).map((feed) => feedKey(feed)));
      const migrated = feeds.filter((feed) => belongsToProject(feed));
      for (const feed of migrated) {
        const key = feedKey(feed);
        if (!projectKeys.has(key)) {
          project.feeds.push(feed);
          projectKeys.add(key);
        }
      }
    }

    const projectFeedKeys = new Set(
      specialProjects.flatMap((project) => (Array.isArray(project.feeds) ? project.feeds.map((feed) => feedKey(feed)) : [])),
    );
    feeds = feeds.filter((feed) => !projectFeedKeys.has(feedKey(feed)));

    function syncSpecialProjects() {
      const payload = specialProjects.map((project) => {
        const feeds = project.feeds
          .map((feed) => ({
            id: feed.id || makeProjectFeedId(),
            name: deriveFeedNameFromUrl(feed.url || ''),
            url: String(feed.url || '').trim(),
            group: feed.group === 'papers' ? 'papers' : 'news',
            interestHint: String(feed.interestHint || '').trim(),
            priority: feed.priority === 'high' ? 'high' : 'normal',
            enabled: feed.enabled !== false,
          }))
          .filter((feed) => Boolean(feed.url));
        const includeNews = feeds.some(feed => feed.group === 'news');
        const includePapers = feeds.some(feed => feed.group === 'papers');
        return {
          id: project.id,
          name: project.name,
          enabled: project.enabled !== false,
          strictInterestMatch: project.strictInterestMatch !== false,
          prompt: String(project.prompt || '').trim(),
          interests: Array.isArray(project.interests) ? project.interests : [],
          includeNews,
          includePapers,
          feeds,
        };
      });
      specialProjectsInput.value = JSON.stringify(payload);
    }

    function hasInvalidProjectFeeds() {
      for (let i = 0; i < specialProjects.length; i += 1) {
        const project = specialProjects[i];
        for (let j = 0; j < project.feeds.length; j += 1) {
          const feed = project.feeds[j];
          const url = String(feed.url || '').trim();
          if (!url) return true;
          try {
            const parsed = new URL(url);
            if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return true;
          } catch {
            return true;
          }
        }
      }
      return false;
    }

    function renderProjectCards() {
      if (!projectList) return;
      projectList.innerHTML = '';

      specialProjects.forEach((project, projectIndex) => {
        const card = document.createElement('div');
        card.className = 'project-card';
        card.innerHTML = '<div class="project-head">'
          + '<input data-project-field="name" />'
          + '<label class="check"><input type="checkbox" data-project-field="enabled" /> Enabled</label>'
          + '<label class="check"><input type="checkbox" data-project-field="strictInterestMatch" /> Strict match</label>'
          + '<div style="display:flex;gap:8px;justify-content:flex-end;">'
          + '<button type="button" class="small-btn" data-project-action="toggleFeeds">Show Feeds</button>'
          + '<button type="button" class="small-btn danger" data-project-action="delete">Delete</button>'
          + '</div>'
          + '</div>'
          + '<div class="project-prompt" data-project-prompt></div>'
          + '<div class="project-feeds-wrap" data-project-feeds-wrap>'
          + '<div class="add-feed-grid" style="margin-top:8px;">'
          + '<input data-project-new-feed-url placeholder="https://example.com/feed.xml" />'
          + '<select data-project-new-feed-group><option value="news">News</option><option value="papers">Papers</option></select>'
          + '<div class="muted">Project RSS feed</div>'
          + '<button type="button" class="small-btn" data-project-action="addFeed">Add Feed</button>'
          + '</div>'
          + '<div class="project-feed-list" data-project-feed-list></div>'
          + '</div>';

        const nameInput = card.querySelector('[data-project-field="name"]');
        const enabledInput = card.querySelector('[data-project-field="enabled"]');
        const strictInput = card.querySelector('[data-project-field="strictInterestMatch"]');
        const toggleBtn = card.querySelector('[data-project-action="toggleFeeds"]');
        const deleteBtn = card.querySelector('[data-project-action="delete"]');
        const addFeedBtnInner = card.querySelector('[data-project-action="addFeed"]');
        const feedUrlInput = card.querySelector('[data-project-new-feed-url]');
        const feedGroupInput = card.querySelector('[data-project-new-feed-group]');
        const feedsWrap = card.querySelector('[data-project-feeds-wrap]');
        const feedListInner = card.querySelector('[data-project-feed-list]');
        const promptBox = card.querySelector('[data-project-prompt]');

        nameInput.value = project.name || '';
        enabledInput.checked = project.enabled !== false;
        strictInput.checked = project.strictInterestMatch !== false;
        promptBox.textContent = project.prompt
          ? 'Auto prompt: ' + project.prompt
          : 'Auto prompt will be generated by Gemini when you save and this project has RSS feeds.';
        feedsWrap.className = 'project-feeds-wrap' + (project.expanded ? ' open' : '');
        toggleBtn.textContent = project.expanded ? '▼ RSS Feeds' : '▶ RSS Feeds';

        function renderProjectFeeds() {
          feedListInner.innerHTML = '';
          project.feeds.forEach((feed, feedIndex) => {
            const row = document.createElement('div');
            row.className = 'feed-row';
            row.innerHTML = '<div class="project-feed-grid">'
              + '<div class="project-name-badge"></div>'
              + '<input data-feed-field="url" placeholder="https://..." />'
              + '<select data-feed-field="group"><option value="news">News</option><option value="papers">Papers</option></select>'
              + '<select data-feed-field="priority"><option value="normal">Normal</option><option value="high">High</option></select>'
              + '<label class="check"><input type="checkbox" data-feed-field="enabled" /> Enabled</label>'
              + '<button type="button" class="feed-del" data-feed-action="delete">Delete</button>'
              + '</div>';

            row.querySelector('.project-name-badge').textContent = deriveFeedNameFromUrl(feed.url || '');
            row.querySelector('[data-feed-field="url"]').value = feed.url || '';
            row.querySelector('[data-feed-field="group"]').value = feed.group === 'papers' ? 'papers' : 'news';
            row.querySelector('[data-feed-field="priority"]').value = feed.priority === 'high' ? 'high' : 'normal';
            row.querySelector('[data-feed-field="enabled"]').checked = feed.enabled !== false;

            row.querySelector('[data-feed-action="delete"]').addEventListener('click', () => {
              project.feeds.splice(feedIndex, 1);
              renderProjectFeeds();
              syncSpecialProjects();
            });

            row.querySelectorAll('[data-feed-field]').forEach((field) => {
              field.addEventListener('input', () => {
                const key = field.dataset.feedField;
                if (!key) return;
                if (key === 'enabled') {
                  feed.enabled = !!field.checked;
                } else {
                  feed[key] = field.value;
                }
                clearProjectError();
                row.querySelector('.project-name-badge').textContent = deriveFeedNameFromUrl(feed.url || '');
                syncSpecialProjects();
              });
              field.addEventListener('change', () => {
                const key = field.dataset.feedField;
                if (!key) return;
                if (key === 'enabled') {
                  feed.enabled = !!field.checked;
                } else {
                  feed[key] = field.value;
                }
                clearProjectError();
                row.querySelector('.project-name-badge').textContent = deriveFeedNameFromUrl(feed.url || '');
                syncSpecialProjects();
              });
            });

            feedListInner.appendChild(row);
          });
        }

        renderProjectFeeds();

        nameInput.addEventListener('input', () => {
          project.name = normalizeInterest(nameInput.value);
          syncSpecialProjects();
        });
        enabledInput.addEventListener('change', () => {
          project.enabled = !!enabledInput.checked;
          syncSpecialProjects();
        });
        strictInput.addEventListener('change', () => {
          project.strictInterestMatch = !!strictInput.checked;
          syncSpecialProjects();
        });
        toggleBtn.addEventListener('click', () => {
          project.expanded = !project.expanded;
          renderProjectCards();
        });
        deleteBtn.addEventListener('click', () => {
          specialProjects.splice(projectIndex, 1);
          clearProjectError();
          renderProjectCards();
        });
        addFeedBtnInner.addEventListener('click', () => {
          const url = (feedUrlInput.value || '').trim();
          const group = (feedGroupInput.value || 'news') === 'papers' ? 'papers' : 'news';
          if (!url) {
            setProjectError('Project feed URL is required.');
            return;
          }
          try {
            const parsed = new URL(url);
            if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
              setProjectError('Project feed URL must start with http:// or https://');
              return;
            }
          } catch {
            setProjectError('Project feed URL is not valid.');
            return;
          }
          clearProjectError();
          project.feeds.push({
            id: makeProjectFeedId(),
            name: deriveFeedNameFromUrl(url),
            url,
            group,
            interestHint: '',
            priority: 'normal',
            enabled: true,
          });
          feedUrlInput.value = '';
          project.expanded = true;
          renderProjectCards();
        });

        projectList.appendChild(card);
      });

      if (projectStats) {
        projectStats.textContent = specialProjects.length + ' project' + (specialProjects.length === 1 ? '' : 's');
      }
      syncSpecialProjects();
    }

    addProjectBtn?.addEventListener('click', () => {
      const name = normalizeInterest(newProjectName?.value || '');
      if (!name) {
        setProjectError('Project name is required.');
        return;
      }
      clearProjectError();
      specialProjects.push({
        id: makeProjectId(),
        name,
        enabled: true,
        strictInterestMatch: newProjectStrict?.checked !== false,
        prompt: '',
        interests: [],
        feeds: [],
        expanded: true,
      });
      if (newProjectName) newProjectName.value = '';
      if (newProjectStrict) newProjectStrict.checked = true;
      renderProjectCards();
    });

    settingsForm?.addEventListener('submit', () => {
      const invalidIndex = findInvalidFeedIndex();
      if (invalidIndex !== -1) {
        setFeedError('Cannot save: every feed must have a valid http/https URL.');
        return false;
      }
      if (hasInvalidProjectFeeds()) {
        setProjectError('Cannot save: every project feed must have a valid http/https URL.');
        return false;
      }
      clearFeedError();
      clearProjectError();
      syncInterests();
      syncFeeds();
      syncSpecialProjects();
    });

    renderInterests();
    rebuildNewFeedInterestOptions();
    renderFeeds();
    renderProjectCards();
  </script>
</body>
</html>`;
}

function createSessionUser(user: { id: string; username: string; displayName: string; role: UserRole }): ReaderSessionUser {
  return {
    userId: user.id,
    username: user.username,
    displayName: user.displayName,
    role: user.role,
  };
}

export function startAdminPanel(options: AdminPanelOptions): void {
  const sessions = new Map<string, ReaderSessionUser>();

  const settings = getPanelSettings('admin');
  const server = createServer(async (req, res) => {
    const method = req.method || 'GET';
    const url = req.url || '/';
    const urlObj = new URL(url, `http://${settings.panelHost}:${settings.panelPort}`);
    const path = urlObj.pathname;

    const cookies = parseCookies(req);
    const token = cookies.feedledger_session || '';
    const sessionUser = sessions.get(token) || null;

    if (path === '/login' && method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(renderLogin());
      return;
    }

    if (path === '/login' && method === 'POST') {
      const form = await readForm(req);
      const authenticated = authenticateUser(form.username || '', form.password || '');
      if (!authenticated) {
        res.writeHead(401, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(renderLogin('Invalid username or password'));
        return;
      }

      const nextToken = randomBytes(24).toString('hex');
      sessions.set(nextToken, createSessionUser(authenticated));
      const destination = authenticated.role === 'admin' ? '/' : '/reader';
      redirect(res, destination, `feedledger_session=${nextToken}; HttpOnly; SameSite=Strict; Path=/`);
      return;
    }

    if (path === '/logout') {
      if (token) sessions.delete(token);
      redirect(res, '/login', 'feedledger_session=; Max-Age=0; Path=/');
      return;
    }

    if (!sessionUser) {
      redirect(res, '/login');
      return;
    }

    if (path === '/reader' || path === '/reader/app.js' || path.startsWith('/api/reader')) {
      const handled = await handleReaderRoute(req, res, path, options.getMammothStore(), sessionUser, {
        listUsers: () => listUsers().map(user => createSessionUser(user)),
      });
      if (handled) return;
    }

    if (path === '/' && method === 'GET') {
      const message = urlObj.searchParams.get('message') || undefined;
      const error = urlObj.searchParams.get('error') || undefined;
      const targetUserId = sanitizeUserQueryUserId(sessionUser, urlObj.searchParams.get('userId') || undefined);
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(renderDashboard(sessionUser, targetUserId, message, error));
      return;
    }

    if (path === '/settings' && method === 'POST') {
      const form = await readForm(req);
      const users = listUsers();
      const requestedTarget = (form.targetUserId || '').trim();
      const targetUserId = sessionUser.role === 'admin' && users.some(user => user.id === requestedTarget)
        ? requestedTarget
        : sessionUser.userId;

      const current = getPanelSettings(targetUserId);
      const saveMode = form.saveMode === 'ai-gemini'
        ? 'ai-gemini'
        : form.saveMode === 'ai-openrouter'
          ? 'ai-openrouter'
          : 'all';
      const nextAiProvider = saveMode === 'ai-gemini'
        ? 'gemini'
        : saveMode === 'ai-openrouter'
          ? 'openrouter'
          : (form.aiProvider === 'openrouter' ? 'openrouter' : current.aiProvider);
      const nextGeminiApiKey = resolveSecretInput(form.geminiApiKey, current.geminiApiKey);
      const nextOpenrouterApiKey = resolveSecretInput(form.openrouterApiKey, current.openrouterApiKey);
      const nextGeminiModel = form.geminiModel || current.geminiModel || 'gemini-2.5-flash';
      const nextOpenrouterModel = (form.openrouterModel || current.openrouterModel || 'deepseek/deepseek-v3.2-speciale').trim();
      if (saveMode === 'ai-gemini' || saveMode === 'ai-openrouter') {
        updateRuntimeSettings(targetUserId, {
          aiProvider: nextAiProvider,
          geminiApiKey: nextGeminiApiKey,
          geminiModel: nextGeminiModel,
          openrouterApiKey: nextOpenrouterApiKey,
          openrouterModel: nextOpenrouterModel,
        });
      } else {
        const interests = parseJsonArrayInput(form.interestsJson).filter((value): value is string => typeof value === 'string');
        const feeds = parseJsonArrayInput(form.feedsJson);
        const specialProjectsRaw = parseJsonArrayInput(form.specialProjectsJson);
        const specialProjects = await enrichProjectsWithAutoPrompt(
          specialProjectsRaw,
          nextGeminiApiKey,
          nextGeminiModel,
        );

        updateRuntimeSettings(targetUserId, {
          aiProvider: nextAiProvider,
          geminiApiKey: nextGeminiApiKey,
          geminiModel: nextGeminiModel,
          openrouterApiKey: nextOpenrouterApiKey,
          openrouterModel: nextOpenrouterModel,
          notionApiKey: resolveSecretInput(form.notionApiKey, current.notionApiKey),
          notionParentPageId: form.notionParentPageId || '',
          telegramBotToken: resolveSecretInput(form.telegramBotToken, current.telegramBotToken),
          telegramChatId: resolveSecretInput(form.telegramChatId, current.telegramChatId),
          mammothEnabled: form.mammothEnabled === '1',
          mammothUri: form.mammothUri || '',
          mammothDatabase: form.mammothDatabase || '',
          reportTimezone: form.reportTimezone || '',
          dailyScanTime: form.dailyScanTime || '',
          dailySendTime: form.dailySendTime || '',
          reportPeriodDays: Number.parseInt(form.reportPeriodDays || '1', 10),
          assistantGreeting: form.assistantGreeting || '',
          assistantSignature: form.assistantSignature || '',
          notionQuotaAutoclean: form.notionQuotaAutoclean === '1',
          interests,
          feeds: feeds as any,
          specialProjects: specialProjects as any,
          reportGroupingMode: form.reportGroupingMode === 'by_interest' ? 'by_interest' : 'single',
        });
      }

      options.onSettingsUpdated(targetUserId);
      const query = new URLSearchParams({
        message: saveMode === 'ai-gemini'
          ? `Active AI set to Gemini for ${targetUserId}`
          : saveMode === 'ai-openrouter'
            ? `Active AI set to OpenRouter for ${targetUserId}`
            : `Settings updated for ${targetUserId}`,
      });
      if (sessionUser.role === 'admin') {
        query.set('userId', targetUserId);
      }
      redirect(res, `/?${query.toString()}`);
      return;
    }

    if (path === '/settings/interests' && method === 'POST') {
      try {
        const form = await readForm(req);
        const users = listUsers();
        const requestedTarget = (form.targetUserId || '').trim();
        const targetUserId = sessionUser.role === 'admin' && users.some(user => user.id === requestedTarget)
          ? requestedTarget
          : sessionUser.userId;

        const interests = parseJsonArrayInput(form.interestsJson).filter((value): value is string => typeof value === 'string');
        updateRuntimeSettings(targetUserId, { interests });
        options.onSettingsUpdated(targetUserId);
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: true }));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: false, error: String(err) }));
      }
      return;
    }

    if (sessionUser.role === 'admin' && path === '/users/create' && method === 'POST') {
      const form = await readForm(req);
      try {
        createUser({
          username: form.username || '',
          displayName: form.displayName || '',
          role: form.role === 'admin' ? 'admin' : 'user',
          password: form.password || '',
        });
        redirect(res, '/?message=User%20created');
      } catch (err) {
        redirect(res, `/?error=${encodeURIComponent(String(err))}`);
      }
      return;
    }

    if (sessionUser.role === 'admin' && path === '/users/update' && method === 'POST') {
      const form = await readForm(req);
      try {
        updateUser(form.userId || '', {
          displayName: form.displayName || '',
          role: form.role === 'admin' ? 'admin' : 'user',
        });
        redirect(res, '/?message=User%20updated');
      } catch (err) {
        redirect(res, `/?error=${encodeURIComponent(String(err))}`);
      }
      return;
    }

    if (path === '/users/password' && method === 'POST') {
      const form = await readForm(req);
      const targetUserId = (form.userId || '').trim();
      const allowed = sessionUser.role === 'admin' || targetUserId === sessionUser.userId;
      if (!allowed) {
        redirect(res, '/?error=Unauthorized');
        return;
      }

      try {
        setUserPassword(targetUserId, form.password || '');
        redirect(res, '/?message=Password%20updated');
      } catch (err) {
        redirect(res, `/?error=${encodeURIComponent(String(err))}`);
      }
      return;
    }

    if (sessionUser.role === 'admin' && path === '/users/delete' && method === 'POST') {
      const form = await readForm(req);
      try {
        deleteUser(form.userId || '');
        redirect(res, '/?message=User%20deleted');
      } catch (err) {
        redirect(res, `/?error=${encodeURIComponent(String(err))}`);
      }
      return;
    }

    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not found');
  });

  server.listen(settings.panelPort, settings.panelHost, () => {
    log.info(`Admin panel listening at http://${settings.panelHost}:${settings.panelPort}`);
  });
}
