import { createLogger } from './logger.js';
import type { ReportType } from './types.js';

const log = createLogger('telegram');

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function reportLabel(reportType: ReportType, scopeType: 'all' | 'interest', scopeValue: string): string {
  const base = reportType === 'papers' ? 'Makaleler raporu' : 'Haberler raporu';
  if (scopeType === 'interest' && scopeValue) {
    return `${base} · ${scopeValue}`;
  }
  return base;
}

export async function sendDailyReportLink(
  botToken: string,
  chatId: string,
  reportType: ReportType,
  scopeType: 'all' | 'interest',
  scopeValue: string,
  reportDate: string,
  reportUrl: string,
  greeting: string,
  signature: string,
  itemCount?: number,
  emptyReason?: string,
): Promise<void> {
  const endpoint = `https://api.telegram.org/bot${botToken}/sendMessage`;
  const safeGreeting = escapeHtml(greeting.trim() || 'Günaydın Patron');
  const safeSignature = escapeHtml(signature.trim() || 'FeedLedger Asistanın');
  const label = escapeHtml(reportLabel(reportType, scopeType, scopeValue));

  const hasNoItems = typeof itemCount === 'number' && itemCount === 0;
  const reason = escapeHtml(
    emptyReason?.trim() || 'Bu zaman penceresinde uygun yeni içerik bulunamadı.',
  );

  const text = hasNoItems
    ? `${safeGreeting},\n${label} hazır.\nTarih: ${escapeHtml(reportDate)}\nDurum: Rapor boş oluştu.\nSebep: ${reason}\n<a href="${reportUrl}">Raporu aç</a>\n\n${safeSignature}`
    : `${safeGreeting},\n${label} hazır.\nTarih: ${escapeHtml(reportDate)}\n<a href="${reportUrl}">Raporu aç</a>\n\n${safeSignature}`;

  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    log.error(`Telegram API failed (${response.status}): ${body}`);
    throw new Error(`Telegram API failed with status ${response.status}`);
  }
}
