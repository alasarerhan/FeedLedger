import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';

type ReportType = 'news' | 'papers';
type ReaderTheme = 'light' | 'dark' | 'ocean' | 'system';
const READER_THEME_STORAGE_KEY = 'feedledger_theme';
const LEGACY_READER_THEME_KEYS: string[] = [];

interface ReaderReportSummary {
  reportId: string;
  reportDate: string;
  reportType: ReportType;
  title: string;
  generatedAtIso: string;
  categories: string[];
  itemCount: number;
  notionUrl: string;
}

interface SessionUser {
  userId: string;
  username: string;
  displayName: string;
  role: 'admin' | 'user';
}

interface ReaderSessionPayload {
  user: SessionUser;
  users: SessionUser[];
}

interface ReaderItem {
  itemId: string;
  title: string;
  source: string;
  link: string;
  category: string;
  whatHappened: string;
  whyItMatters: string;
  keyDetail: string;
  publishedAt: string;
  note: string;
}

interface ReaderReportDetail extends ReaderReportSummary {
  timezone: string;
  notionPageId: string;
  reportBody: string;
  reportNote: string;
  createdAtIso: string;
  updatedAtIso: string;
  items: ReaderItem[];
}

interface ListResult {
  items: ReaderReportSummary[];
  total: number;
  page: number;
  limit: number;
}

const styles = `
:root {
  color-scheme: light;
  --page-bg-start: #eef3fb;
  --page-bg-end: #f6f9ff;
  --workspace-bg: #f2f6fd;
  --bg: #eef3fb;
  --sidebar: #f4f7fb;
  --card: #ffffff;
  --card-elevated: #fbfdff;
  --card-border: #d7deea;
  --line: #d7deea;
  --text: #1a2233;
  --muted: #4e5b70;
  --accent: #1363df;
  --link: #1e63cc;
  --chip: #eaf1ff;
  --report-bg: #f7faff;
  --report-active: #eaf2ff;
  --report-doc-bg: #f6f9ff;
  --report-doc-line: #d6e2f7;
  --success-bg: #1f6d52;
  --success-border: #2f8f6d;
  --success-text: #d9f6ea;
  --shadow: rgba(34, 63, 109, 0.06);
}
:root[data-theme="dark"] {
  color-scheme: dark;
  --page-bg-start: #0a1019;
  --page-bg-end: #101a2a;
  --workspace-bg: #111c2c;
  --bg: #0a1019;
  --sidebar: #111b2a;
  --card: #141e2d;
  --card-elevated: #172236;
  --card-border: #3a4f6d;
  --line: #32455f;
  --text: #e7eef9;
  --muted: #b8c6dc;
  --accent: #7ab0ff;
  --link: #9bc4ff;
  --chip: #1d2f4a;
  --report-bg: #0f1828;
  --report-active: #17253b;
  --report-doc-bg: #0f1a2f;
  --report-doc-line: #3f5476;
  --success-bg: #24583f;
  --success-border: #2f8f6d;
  --success-text: #e6fff3;
  --shadow: rgba(4, 8, 14, 0.36);
}
:root[data-theme="ocean"] {
  color-scheme: light;
  --page-bg-start: #e5f6fb;
  --page-bg-end: #eefbff;
  --workspace-bg: #ecf8fd;
  --bg: #e5f6fb;
  --sidebar: #ecf8fb;
  --card: #ffffff;
  --card-elevated: #f4fcff;
  --card-border: #bfd9e5;
  --line: #c8ddea;
  --text: #173748;
  --muted: #4f6f80;
  --accent: #0087b8;
  --link: #0d6f95;
  --chip: #def4fc;
  --report-bg: #f3fbff;
  --report-active: #e1f5ff;
  --report-doc-bg: #f0faff;
  --report-doc-line: #cbe5f3;
  --success-bg: #1b8a64;
  --success-border: #31a47d;
  --success-text: #ecfff7;
  --shadow: rgba(19, 61, 87, 0.1);
}
* { box-sizing: border-box; }
body {
  margin: 0;
  background: linear-gradient(180deg, var(--page-bg-start) 0%, var(--page-bg-end) 100%);
  color: var(--text);
  font-family: Inter, Segoe UI, system-ui, sans-serif;
}
a { color: var(--link); text-decoration: none; }
.app {
  display: flex;
  height: 100vh;
  width: 100vw;
  background: var(--workspace-bg);
}
.sidebar {
  width: 340px;
  min-width: 340px;
  background: linear-gradient(180deg, color-mix(in srgb, var(--sidebar) 96%, var(--workspace-bg) 4%) 0%, var(--sidebar) 100%);
  border-right: 1px solid var(--line);
  display: flex;
  flex-direction: column;
  transition: width .2s ease, min-width .2s ease;
}
.sidebar.collapsed { width: 72px; min-width: 72px; }
.topbar {
  padding: 12px;
  border-bottom: 1px solid var(--line);
  display: grid;
  grid-template-columns: 40px 1fr;
  gap: 10px;
}
.toggle {
  border: 1px solid var(--line);
  border-radius: 10px;
  background: var(--card);
  color: var(--text);
  cursor: pointer;
  font-size: 18px;
}
.search {
  width: 100%;
  border: 1px solid var(--line);
  border-radius: 10px;
  background: var(--card);
  color: var(--text);
  padding: 10px 12px;
}
.sidebar.collapsed .search-wrap,
.sidebar.collapsed .tabs,
.sidebar.collapsed .filters,
.sidebar.collapsed .list-title,
.sidebar.collapsed .report-list,
.sidebar.collapsed .sidebar-footer {
  display: none;
}
.tabs { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; padding: 10px 12px 0; }
.tab {
  border: 1px solid var(--line);
  background: var(--card);
  color: var(--muted);
  border-radius: 10px;
  padding: 9px;
  cursor: pointer;
}
.tab.active {
  background: color-mix(in srgb, var(--accent) 18%, var(--card) 82%);
  color: var(--text);
  border-color: color-mix(in srgb, var(--accent) 48%, var(--line) 52%);
}
.filters { padding: 10px 12px; border-bottom: 1px solid var(--line); }
.filter {
  width: 100%;
  border: 1px solid var(--line);
  border-radius: 10px;
  background: var(--card);
  color: var(--text);
  padding: 9px 10px;
}
.list-title {
  padding: 10px 12px 6px;
  font-size: 12px;
  color: var(--muted);
}
.report-list {
  overflow: auto;
  padding: 0 12px 14px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.group-title {
  margin-top: 10px;
  margin-bottom: 4px;
  font-size: 11px;
  color: var(--muted);
  text-transform: uppercase;
  letter-spacing: .08em;
}
.report {
  border: 1px solid var(--card-border);
  border-radius: 12px;
  background: var(--report-bg);
  padding: 10px;
  cursor: pointer;
}
.report.active {
  border-color: color-mix(in srgb, var(--accent) 48%, var(--line) 52%);
  background: var(--report-active);
}
.report h4 {
  margin: 0;
  font-size: 13px;
  line-height: 1.35;
}
.meta {
  margin-top: 6px;
  font-size: 11px;
  color: var(--muted);
}
.chips { margin-top: 6px; display: flex; gap: 5px; flex-wrap: wrap; }
.chip {
  border: 1px solid color-mix(in srgb, var(--line) 64%, var(--accent) 36%);
  background: var(--chip);
  border-radius: 999px;
  font-size: 10px;
  padding: 2px 7px;
  color: var(--text);
}
.main {
  flex: 1;
  min-width: 0;
  overflow: auto;
  padding: 24px;
  background: var(--workspace-bg);
}
.empty {
  border: 1px dashed var(--line);
  border-radius: 16px;
  color: var(--muted);
  padding: 26px;
  text-align: center;
}
.report-header {
  border: 1px solid var(--card-border);
  background: var(--card-elevated);
  border-radius: 16px;
  padding: 16px;
  box-shadow: 0 6px 18px var(--shadow);
}
.report-header h1 { margin: 0; font-size: 24px; }
.badges { margin-top: 8px; display: flex; gap: 8px; flex-wrap: wrap; }
.badge {
  border: 1px solid color-mix(in srgb, var(--line) 64%, var(--accent) 36%);
  background: color-mix(in srgb, var(--chip) 78%, var(--card) 22%);
  border-radius: 999px;
  font-size: 12px;
  padding: 3px 10px;
  color: var(--text);
}
.section {
  border: 1px solid var(--card-border);
  background: var(--card-elevated);
  border-radius: 16px;
  padding: 16px;
  margin-top: 14px;
  box-shadow: 0 6px 18px var(--shadow);
}
.section h2 { margin: 0 0 12px; font-size: 18px; }
.report-doc {
  border: 1px solid var(--report-doc-line);
  border-radius: 10px;
  background: var(--report-doc-bg);
  padding: 12px;
  white-space: pre-wrap;
  line-height: 1.5;
  color: var(--text);
  font-family: ui-sans-serif, Inter, Segoe UI, system-ui, sans-serif;
}
.note-input {
  width: 100%;
  min-height: 90px;
  border: 1px solid var(--line);
  border-radius: 10px;
  background: var(--report-doc-bg);
  color: var(--text);
  padding: 10px;
  resize: vertical;
}
.save {
  margin-top: 8px;
  border: 1px solid color-mix(in srgb, var(--accent) 64%, var(--line) 36%);
  background: var(--accent);
  color: #fff;
  border-radius: 10px;
  padding: 8px 12px;
  cursor: pointer;
}
.save.ok { background: var(--success-bg); border-color: var(--success-border); color: var(--success-text); }
.sidebar-footer {
  margin-top: auto;
  border-top: 1px solid var(--line);
  padding: 12px;
  display: grid;
  gap: 8px;
}
.theme-select,
.side-link {
  border: 1px solid var(--line);
  border-radius: 10px;
  background: var(--card);
  color: var(--text);
  padding: 9px 10px;
  font-size: 13px;
  text-decoration: none;
}
.side-link {
  display: inline-block;
  text-align: center;
}
@media (max-width: 980px) {
  .sidebar { position: fixed; z-index: 10; height: 100vh; }
  .main { padding: 14px; margin-left: 72px; }
}
`;

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(init?.headers || {}),
    },
    credentials: 'same-origin',
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(text || `HTTP ${response.status}`);
  }
  return response.json() as Promise<T>;
}

function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}

function yesterdayISO(): string {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  return d.toISOString().slice(0, 10);
}

function groupLabel(reportDate: string): string {
  if (reportDate === todayISO()) return 'Today';
  if (reportDate === yesterdayISO()) return 'Yesterday';
  return 'Earlier';
}

function App(): React.JSX.Element {
  const [collapsed, setCollapsed] = useState(false);
  const [type, setType] = useState<ReportType>('news');
  const [theme, setTheme] = useState<ReaderTheme>('light');
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [category, setCategory] = useState('');
  const [listLoading, setListLoading] = useState(false);
  const [listError, setListError] = useState('');
  const [configuredInterests, setConfiguredInterests] = useState<string[]>([]);
  const [reports, setReports] = useState<ReaderReportSummary[]>([]);
  const [selectedReportId, setSelectedReportId] = useState('');
  const [detail, setDetail] = useState<ReaderReportDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [reportNoteDraft, setReportNoteDraft] = useState('');
  const [saveStatus, setSaveStatus] = useState('');
  const [sessionUser, setSessionUser] = useState<SessionUser | null>(null);
  const [availableUsers, setAvailableUsers] = useState<SessionUser[]>([]);
  const [activeUserId, setActiveUserId] = useState('');
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let saved = localStorage.getItem(READER_THEME_STORAGE_KEY);
    if (!saved) {
      saved = LEGACY_READER_THEME_KEYS.map(key => localStorage.getItem(key)).find(Boolean);
      if (saved) localStorage.setItem(READER_THEME_STORAGE_KEY, saved);
    }
    if (saved === 'light' || saved === 'dark' || saved === 'ocean' || saved === 'system') {
      setTheme(saved);
      return;
    }
    setTheme('light');
  }, []);

  useEffect(() => {
    const root = document.documentElement;
    const resolveSystemTheme = () => (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
    const applyTheme = () => {
      const effective = theme === 'system' ? resolveSystemTheme() : theme;
      root.setAttribute('data-theme', effective);
    };

    localStorage.setItem(READER_THEME_STORAGE_KEY, theme);
    applyTheme();

    if (theme !== 'system') {
      return;
    }

    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = () => applyTheme();
    if ('addEventListener' in media) {
      media.addEventListener('change', onChange);
      return () => media.removeEventListener('change', onChange);
    }
    media.addListener(onChange);
    return () => media.removeListener(onChange);
  }, [theme]);

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedSearch(search.trim()), 220);
    return () => clearTimeout(timer);
  }, [search]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        searchRef.current?.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const isAdmin = sessionUser?.role === 'admin';

  const userQuery = useMemo(() => {
    if (!isAdmin || !activeUserId) return '';
    return `userId=${encodeURIComponent(activeUserId)}`;
  }, [isAdmin, activeUserId]);

  useEffect(() => {
    async function run(): Promise<void> {
      try {
        const session = await fetchJson<ReaderSessionPayload>('/api/reader/session');
        setSessionUser(session.user);
        const users = Array.isArray(session.users) ? session.users : [session.user];
        setAvailableUsers(users);
        setActiveUserId(session.user.userId);
      } catch {
        setSessionUser(null);
        setAvailableUsers([]);
        setActiveUserId('');
      }
    }
    void run();
  }, []);

  useEffect(() => {
    if (!activeUserId && availableUsers.length > 0) {
      setActiveUserId(availableUsers[0].userId);
    }
  }, [activeUserId, availableUsers]);

  useEffect(() => {
    async function run(): Promise<void> {
      try {
        const params = new URLSearchParams();
        if (userQuery) {
          const [key, value] = userQuery.split('=');
          params.set(key, decodeURIComponent(value));
        }
        const suffix = params.toString() ? `?${params.toString()}` : '';
        const result = await fetchJson<{ interests: string[] }>(`/api/reader/interests${suffix}`);
        const values = Array.isArray(result.interests) ? result.interests : [];
        setConfiguredInterests(values.filter(Boolean));
      } catch {
        setConfiguredInterests([]);
      }
    }
    if (activeUserId) {
      void run();
    }
  }, [activeUserId, userQuery]);

  useEffect(() => {
    async function run(): Promise<void> {
      setListLoading(true);
      setListError('');
      try {
        const params = new URLSearchParams();
        params.set('type', type);
        if (debouncedSearch) params.set('q', debouncedSearch);
        if (category) params.set('category', category);
        if (userQuery) {
          const [key, value] = userQuery.split('=');
          params.set(key, decodeURIComponent(value));
        }
        params.set('limit', '80');
        const result = await fetchJson<ListResult>(`/api/reader/reports?${params.toString()}`);
        setReports(result.items);
        if (!result.items.some(item => item.reportId === selectedReportId)) {
          setSelectedReportId(result.items[0]?.reportId || '');
        }
      } catch (err) {
        setListError(String(err));
        setReports([]);
      } finally {
        setListLoading(false);
      }
    }
    void run();
  }, [type, debouncedSearch, category, selectedReportId, userQuery, activeUserId]);

  useEffect(() => {
    if (!selectedReportId) {
      setDetail(null);
      return;
    }
    async function run(): Promise<void> {
      setDetailLoading(true);
      try {
        const params = new URLSearchParams();
        if (userQuery) {
          const [key, value] = userQuery.split('=');
          params.set(key, decodeURIComponent(value));
        }
        const suffix = params.toString() ? `?${params.toString()}` : '';
        const next = await fetchJson<ReaderReportDetail>(`/api/reader/reports/${encodeURIComponent(selectedReportId)}${suffix}`);
        setDetail(next);
        setReportNoteDraft(next.reportNote || '');
      } catch (err) {
        setDetail(null);
        setSaveStatus(`Detay yüklenemedi: ${String(err)}`);
      } finally {
        setDetailLoading(false);
      }
    }
    void run();
  }, [selectedReportId, userQuery, activeUserId]);

  const groupedReports = useMemo(() => {
    const grouped = new Map<string, ReaderReportSummary[]>();
    reports.forEach(report => {
      const label = groupLabel(report.reportDate);
      if (!grouped.has(label)) grouped.set(label, []);
      grouped.get(label)?.push(report);
    });
    return Array.from(grouped.entries());
  }, [reports]);

  const categoryOptions = useMemo(() => {
    const set = new Set<string>();
    configuredInterests.forEach(interest => set.add(interest));
    reports.forEach(report => report.categories.forEach(categoryName => set.add(categoryName)));
    return Array.from(set).sort((a, b) => a.localeCompare(b));
  }, [configuredInterests, reports]);

  useEffect(() => {
    if (category && !categoryOptions.includes(category)) {
      setCategory('');
    }
  }, [category, categoryOptions]);

  async function saveReportNote(): Promise<void> {
    if (!detail) return;
    const params = new URLSearchParams();
    if (userQuery) {
      const [key, value] = userQuery.split('=');
      params.set(key, decodeURIComponent(value));
    }
    const suffix = params.toString() ? `?${params.toString()}` : '';
    await fetchJson(`/api/reader/reports/${encodeURIComponent(detail.reportId)}/note${suffix}`, {
      method: 'PATCH',
      body: JSON.stringify({ note: reportNoteDraft }),
    });
    setSaveStatus('Report note saved');
    setTimeout(() => setSaveStatus(''), 1500);
  }

  return (
    <>
      <style>{styles}</style>
      <div className="app">
        <aside className={`sidebar ${collapsed ? 'collapsed' : ''}`}>
          <div className="topbar">
            <button className="toggle" type="button" onClick={() => setCollapsed(prev => !prev)}>
              {collapsed ? '>' : '<'}
            </button>
            <div className="search-wrap">
              <input
                ref={searchRef}
                className="search"
                placeholder="Search reports... (Ctrl/Cmd+K)"
                value={search}
                onChange={event => setSearch(event.target.value)}
              />
            </div>
          </div>

          <div className="tabs">
            <button className={`tab ${type === 'news' ? 'active' : ''}`} onClick={() => setType('news')}>Haberler</button>
            <button className={`tab ${type === 'papers' ? 'active' : ''}`} onClick={() => setType('papers')}>Makaleler</button>
          </div>

          <div className="filters">
            <select className="filter" value={category} onChange={event => setCategory(event.target.value)}>
              <option value="">All categories</option>
              {categoryOptions.map(option => <option key={option} value={option}>{option}</option>)}
            </select>
          </div>

          <div className="list-title">
            {listLoading ? 'Loading...' : `${reports.length} report(s)`}
            {listError ? ` · ${listError}` : ''}
          </div>

          <div className="report-list">
            {groupedReports.map(([label, items]) => (
              <div key={label}>
                <div className="group-title">{label}</div>
                {items.map(report => (
                  <div
                    key={report.reportId}
                    className={`report ${report.reportId === selectedReportId ? 'active' : ''}`}
                    onClick={() => setSelectedReportId(report.reportId)}
                  >
                    <h4>{report.title}</h4>
                    <div className="meta">{report.reportDate} · {report.itemCount} item</div>
                    <div className="chips">
                      {report.categories.slice(0, 3).map(categoryName => (
                        <span key={categoryName} className="chip">{categoryName}</span>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            ))}
          </div>

          <div className="sidebar-footer">
            {isAdmin && (
              <select
                className="theme-select"
                value={activeUserId}
                onChange={event => setActiveUserId(event.target.value)}
                aria-label="Reader user context"
              >
                {availableUsers.map(user => (
                  <option key={user.userId} value={user.userId}>
                    {user.displayName} (@{user.username})
                  </option>
                ))}
              </select>
            )}
            <select className="theme-select" value={theme} onChange={event => setTheme(event.target.value as ReaderTheme)} aria-label="Theme">
              <option value="light">Light</option>
              <option value="dark">Dark</option>
              <option value="ocean">Ocean</option>
              <option value="system">System</option>
            </select>
            <a className="side-link" href="/">Control Panel</a>
          </div>
        </aside>

        <main className="main">
          {!selectedReportId && <div className="empty">No reports found for current filters.</div>}
          {selectedReportId && detailLoading && <div className="empty">Loading report...</div>}
          {selectedReportId && !detailLoading && detail && (
            <>
              <section className="report-header">
                <h1>{detail.title}</h1>
                <div className="badges">
                  <span className="badge">{detail.reportType === 'papers' ? 'Makaleler' : 'Haberler'}</span>
                  <span className="badge">{detail.reportDate}</span>
                  <span className="badge">{detail.items.length} item</span>
                  {detail.notionUrl ? <a className="badge" href={detail.notionUrl} target="_blank" rel="noreferrer">Open Notion</a> : null}
                </div>
              </section>

              <section className="section">
                <h2>Report Document</h2>
                <div className="report-doc">
                  {detail.reportBody?.trim()
                    ? detail.reportBody
                    : 'Report text is not available yet. You can open the Notion link above.'}
                </div>
              </section>

              <section className="section">
                <h2>Report Note</h2>
                <textarea
                  className="note-input"
                  value={reportNoteDraft}
                  placeholder="Write your note for this report..."
                  onChange={event => setReportNoteDraft(event.target.value)}
                />
                <button className={`save ${saveStatus.includes('saved') ? 'ok' : ''}`} onClick={() => void saveReportNote()}>
                  Save Note
                </button>
              </section>
            </>
          )}
        </main>
      </div>
    </>
  );
}

const rootElement = document.getElementById('root');
if (rootElement) {
  createRoot(rootElement).render(<App />);
}
