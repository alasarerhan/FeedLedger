// src/cli.ts
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SUPPORTED_LANGUAGES, type SupportedLanguage } from './i18n.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

function getVersion(): string {
  try {
    const pkgPath = resolve(__dirname, '..', 'package.json');
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
    return pkg.version || 'unknown';
  } catch {
    return 'unknown';
  }
}

function printHelp(): void {
  console.log(`FeedLedger — daily AI news and paper reporting with Notion + Telegram

Usage: feedledger [options]

Options:
  -l, --lang <code>   Summary language: ${SUPPORTED_LANGUAGES.join(', ')} (default: "en")
  -h, --help          Show this help message
  -v, --version       Show version number

Environment variables (.env):
  AI_PROVIDER           'gemini' or 'openrouter' (default: gemini)
  GEMINI_API_KEY        Google Gemini API key (required for gemini)
  GEMINI_MODEL          Gemini model (default: gemini-2.5-flash)
  OPENROUTER_API_KEY    OpenRouter API key (required for openrouter)
  OPENROUTER_MODEL      OpenRouter model (default: deepseek/deepseek-v3.2-speciale)
  NOTION_API_KEY        Notion integration API key (required)
  NOTION_PARENT_PAGE_ID Notion parent page ID for daily reports (required)
  TELEGRAM_BOT_TOKEN    Telegram bot token (required)
  TELEGRAM_CHAT_ID      Telegram target chat ID (required)
  REPORT_TIMEZONE       IANA timezone (default: Europe/Istanbul)
  DAILY_SCAN_TIME       Daily RSS scan time HH:MM (default: 23:45)
  DAILY_SEND_TIME       Daily Telegram send time HH:MM (default: 06:00)
  ADMIN_PANEL_PASSWORD  Password for admin panel login (required)
  PANEL_HOST            Admin panel host (default: 127.0.0.1)
  PANEL_PORT            Admin panel port (default: 8897)

Scheduling:
  Daily scan/send times are configurable via .env and Admin Panel
  Defaults: scan=23:45, send=06:00

Examples:
  feedledger --lang=tr    Start with Turkish summaries/prompts
  feedledger -l de        Start with German summaries/prompts
  feedledger              Start with English summaries (default)`);
}

export function parseArgs(): { lang: SupportedLanguage } {
  const args = process.argv.slice(2);
  let lang: SupportedLanguage = 'en';

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    if (arg === '-h' || arg === '--help') {
      printHelp();
      process.exit(0);
    }

    if (arg === '-v' || arg === '--version') {
      console.log(getVersion());
      process.exit(0);
    }

    // --lang=xx format
    if (arg.startsWith('--lang=')) {
      const value = arg.split('=')[1];
      if (!SUPPORTED_LANGUAGES.includes(value as SupportedLanguage)) {
        console.error(`Error: Unsupported language "${value}". Supported: ${SUPPORTED_LANGUAGES.join(', ')}`);
        process.exit(1);
      }
      lang = value as SupportedLanguage;
      continue;
    }

    // --lang xx or -l xx format
    if (arg === '--lang' || arg === '-l') {
      const value = args[i + 1];
      if (!value || value.startsWith('-')) {
        console.error(`Error: --lang requires a language code. Supported: ${SUPPORTED_LANGUAGES.join(', ')}`);
        process.exit(1);
      }
      if (!SUPPORTED_LANGUAGES.includes(value as SupportedLanguage)) {
        console.error(`Error: Unsupported language "${value}". Supported: ${SUPPORTED_LANGUAGES.join(', ')}`);
        process.exit(1);
      }
      lang = value as SupportedLanguage;
      i++; // skip next arg (the value)
      continue;
    }
  }

  return { lang };
}
