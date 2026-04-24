# FeedLedger

FeedLedger is a daily AI news and paper reporting service.

It scans configurable RSS feeds, filters and summarizes items with AI, stores report history, publishes long-form reports to Notion, and sends delivery links through Telegram. It also includes a built-in Admin Panel + Reader UI for managing settings and browsing previous reports.

## Core Features

- Daily scheduled pipeline per user (scan + send windows)
- AI provider switch: `gemini` or `openrouter`
- Multilingual summaries (`en`, `tr`, `de`, `fr`, `es`)
- Runtime feed management (enable/disable, group, priority)
- Interest-based grouping (`single` or `by_interest`)
- Special project profiles with dedicated feeds and prompts
- Notion report persistence + optional quota auto-clean
- Telegram link notifications for each report
- Reader API/UI backed by Mammoth (Mongo-compatible local store)
- Multi-user auth with admin role controls

## Tech Stack

- Node.js + TypeScript (ESM)
- React (Reader frontend bundle)
- Mammoth (embedded/local document store)
- Notion API + Telegram Bot API
- Gemini or OpenRouter models for summarization/relevance

## Requirements

- Node.js `>=18` (Node 20 recommended)
- npm
- API keys / credentials:
  - one AI provider key (`GEMINI_API_KEY` or `OPENROUTER_API_KEY`)
  - `NOTION_API_KEY`
  - `NOTION_PARENT_PAGE_ID`
  - `TELEGRAM_BOT_TOKEN`
  - `TELEGRAM_CHAT_ID`
  - `ADMIN_PANEL_PASSWORD`

## Quick Start (Local)

```bash
git clone <your-repository-url>
cd feedledger
npm install
cp .env.example .env
# edit .env
npm run build
npm start -- --lang=en
```

Open Admin Panel:

- `http://127.0.0.1:8897`

## Bootstrap Workflow

Use the following sequence for a clean environment bring-up after cloning:

1. Initialize runtime configuration:

```bash
cp .env.example .env
```

2. Set required credentials in `.env`:
   - AI provider key (`GEMINI_API_KEY` or `OPENROUTER_API_KEY`)
   - `NOTION_API_KEY`
   - `NOTION_PARENT_PAGE_ID`
   - `TELEGRAM_BOT_TOKEN`
   - `TELEGRAM_CHAT_ID`
   - `ADMIN_PANEL_PASSWORD`

3. Build and start service:

```bash
npm install
npm run build
npm start -- --lang=en
```

4. Verify control plane:
   - Admin Panel: `http://127.0.0.1:8897`
   - Authenticate with `admin` and `ADMIN_PANEL_PASSWORD`
   - Confirm feed/topic configuration from dashboard

Runtime state (`data/`, `logs/`, secrets in `.env`) is environment-specific and remains outside version control.

## Docker Compose

`docker-compose.yml` builds a single container that runs both FeedLedger and Mammoth.

```bash
cp .env.example .env
# if vendor/mammoth does not exist yet:
git clone --depth 1 https://github.com/MammothEngine/mammoth.git vendor/mammoth

docker compose up -d --build
```

Default exposed panel port: `8897`.

For operational verification:

```bash
docker compose ps
docker compose logs --tail=120
```

## Configuration

### Required (.env)

- `AI_PROVIDER` (`gemini` or `openrouter`)
- `ADMIN_PANEL_PASSWORD`
- `NOTION_API_KEY`
- `NOTION_PARENT_PAGE_ID`
- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_CHAT_ID`
- Provider-specific:
  - `GEMINI_API_KEY` (if `AI_PROVIDER=gemini`)
  - `OPENROUTER_API_KEY` (if `AI_PROVIDER=openrouter`)

### Common Optional Settings

- `GEMINI_MODEL` (default: `gemini-2.5-flash`)
- `OPENROUTER_MODEL` (default: `deepseek/deepseek-v3.2-speciale`)
- `REPORT_TIMEZONE` (default: `Europe/Istanbul`)
- `DAILY_SCAN_TIME` (default: `23:45`)
- `DAILY_SEND_TIME` (default: `06:00`)
- `REPORT_PERIOD_DAYS` (allowed: `1,2,3,7,14,30`)
- `REPORT_GROUPING_MODE` (`single` or `by_interest`)
- `INTEREST_TOPICS` (comma-separated)
- `PANEL_HOST` (default: `127.0.0.1`)
- `PANEL_PORT` (default: `8897`)
- `MAMMOTH_ENABLED` (default: `true`)
- `MAMMOTH_URI` (default: `mongodb://127.0.0.1:27017`)
- `MAMMOTH_DATABASE` (default: `feedledger`)

Full template: [`.env.example`](.env.example)

## NPM Scripts

- `npm run build` - build backend + Reader UI
- `npm run build:server` - compile TypeScript server
- `npm run build:reader` - bundle `web/reader-app.tsx`
- `npm run dev` - run from source with `tsx`
- `npm start` - run compiled app (`dist/index.js`)
- `npm run mammoth:up` - clone/build/start Mammoth sidecar stack
- `npm run docker:up` - `docker compose up -d --build`
- `npm run docker:down` - stop compose stack
- `npm run e2e:real` - real integration flow script
- `npm run backfill:reader` - backfill Reader storage

## Runtime Data

These paths are generated at runtime and should stay untracked:

- `data/`
- `logs/`
- `vendor/mammoth/` (local Mammoth checkout)

## Deployment Notes

- A user-level systemd unit is included: [`feedledger.service`](feedledger.service)
- For server deployment, build first (`npm run build`) then run `node dist/index.js`
- On startup, the app exits if `ADMIN_PANEL_PASSWORD` is missing

## Contributing

See [`CONTRIBUTING.md`](CONTRIBUTING.md).

## License

MIT - see [`LICENSE`](LICENSE).

## Acknowledgements

This project is inspired by the original implementation at:

- https://github.com/alicankiraz1/newscrux

Special thanks to **Alican Kiraz** for the foundational work and project direction.
