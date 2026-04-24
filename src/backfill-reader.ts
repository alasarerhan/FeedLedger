#!/usr/bin/env node
import { getAdminPassword, initializeRuntimeSettings, getRuntimeSettings } from './runtime-settings.js';
import { listReports } from './report-index.js';
import { MammothStore } from './mammoth-store.js';
import { createLogger } from './logger.js';
import { initializeUserStore, listUsers } from './user-store.js';

const log = createLogger('backfill-reader');

async function main(): Promise<void> {
  const adminPassword = getAdminPassword();
  initializeUserStore(adminPassword);
  const users = listUsers();
  initializeRuntimeSettings(users.map(user => user.id));
  const settings = getRuntimeSettings('admin');
  if (!settings.mammothEnabled) {
    log.warn('Mammoth is disabled. Nothing to backfill.');
    return;
  }

  const store = new MammothStore(true, settings.mammothUri, settings.mammothDatabase);
  await store.connect();

  try {
    let count = 0;
    for (const user of users) {
      const reports = listReports(user.id);
      const userSettings = getRuntimeSettings(user.id);
      for (const report of reports) {
        await store.upsertLinkOnly(user.id, {
          reportType: report.reportType,
          reportDate: report.reportDate,
          scopeType: report.scopeType,
          scopeValue: report.scopeValue,
          notionPageId: report.notionPageId,
          notionUrl: report.notionUrl,
          timezone: userSettings.reportTimezone,
        });
        count += 1;
      }
    }
    log.info(`Backfill completed: ${count} report link(s) synced to Mammoth`);
  } finally {
    await store.close();
  }
}

main().catch((err) => {
  log.error('Backfill failed', err);
  process.exit(1);
});
