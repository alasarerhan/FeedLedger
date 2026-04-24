// src/relevance.ts
import { OpenRouter } from '@openrouter/sdk';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { config } from './config.js';
import { createLogger } from './logger.js';
import type { QueueEntry } from './types.js';
import type { RuntimeSettings } from './runtime-settings.js';

const log = createLogger('relevance');

function buildRelevancePrompt(interests: string[], projectPrompt?: string): string {
  const interestsText = interests.length > 0
    ? interests.map((topic, index) => `${index + 1}. ${topic}`).join('\n')
    : '(İlgi alanı tanımlanmadı. matched_interests alanını boş dizi döndür.)';
  const projectPromptText = (projectPrompt || '').trim();
  const projectContext = projectPromptText
    ? `\n\nProje odak talimatı:\n${projectPromptText}`
    : '';

  return `Sen bir haber/makale uygunluk filtresisin.
Sana içerik başlıkları ve kısa açıklamaları verilecek.
Her içerik için:
1) 1-10 arası bir "ilgililik skoru" ver.
2) Kullanıcının ilgi alanlarından hangilerine uyduğunu tespit et.

Kullanıcı ilgi alanları:
${interestsText}
${projectContext}

Yanıtını SADECE şu JSON formatında ver, başka metin ekleme:
[{"id": 0, "score": 8, "matched_interests": ["Machine Learning"]}, {"id": 1, "score": 3, "matched_interests": []}]

Kurallar:
- id = içerik sıra numarası (0'dan başlar)
- score = 1-10 arası sayı
- matched_interests = yalnızca kullanıcı ilgi alanlarından seçilen etiketlerin dizisi
- Eşleşme yoksa matched_interests boş dizi olmalı`;
}

const MAX_RETRIES = 2;

async function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export interface RelevanceResult {
  passed: Array<{ entry: QueueEntry; score: number; matchedInterests: string[] }>;
  dropped: Array<{ entry: QueueEntry; score: number; matchedInterests: string[]; reason: 'low_score' | 'no_interest_match' }>;
  parseError: boolean;
}

export interface RelevanceFilterOptions {
  thresholdOverride?: number;
  requireInterestMatch?: boolean;
  fallbackPassAllOnError?: boolean;
  contextLabel?: string;
  interestOverride?: string[];
  projectPrompt?: string;
}

export async function filterByRelevance(
  entries: QueueEntry[],
  settings: RuntimeSettings,
  options: RelevanceFilterOptions = {},
): Promise<RelevanceResult> {
  if (entries.length === 0) {
    return { passed: [], dropped: [], parseError: false };
  }

  const configuredInterests = (Array.isArray(options.interestOverride) ? options.interestOverride : settings.interests)
    .map(topic => topic.trim())
    .filter(Boolean);
  const interestLookup = new Map<string, string>(
    configuredInterests.map(topic => [topic.toLowerCase(), topic]),
  );
  const hasInterestFilter = configuredInterests.length > 0;
  const threshold = Number.isFinite(options.thresholdOverride)
    ? Math.max(1, Math.min(10, Number(options.thresholdOverride)))
    : config.relevanceThreshold;
  const requireInterestMatch = options.requireInterestMatch ?? hasInterestFilter;
  const contextLabel = options.contextLabel || 'default';

  const buildPassAllFallback = (): RelevanceResult => {
    const passed = entries.map((entry) => {
      const matchedInterests = hasInterestFilter
        ? configuredInterests.filter(topic =>
          `${entry.feedName} ${entry.title} ${entry.snippet}`.toLowerCase().includes(topic.toLowerCase()),
        )
        : [];
      return {
        entry,
        score: threshold,
        matchedInterests,
      };
    });
    return {
      passed,
      dropped: [],
      parseError: true,
    };
  };

  const list = entries
    .map((e, i) => `${i}. [${e.feedName}] ${e.title}\n   ${e.snippet.trim()}`)
    .join('\n');
  const prompt = buildRelevancePrompt(configuredInterests, options.projectPrompt);

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      let text = '';
      if (settings.aiProvider === 'gemini') {
        const genAI = new GoogleGenerativeAI(settings.geminiApiKey);
        const model = genAI.getGenerativeModel({ 
          model: settings.geminiModel,
          systemInstruction: prompt,
        });
        const result = await model.generateContent(list);
        text = result.response.text();
      } else {
        const openrouter = new OpenRouter({
          apiKey: settings.openrouterApiKey,
        });
        const result = await openrouter.chat.send({
          chatGenerationParams: {
            model: settings.openrouterModel,
            messages: [
              { role: 'system', content: prompt },
              { role: 'user', content: list },
            ],
          },
        });

        const rawContent = result.choices?.[0]?.message?.content;
        if (typeof rawContent === 'string') {
          text = rawContent;
        } else if (Array.isArray(rawContent)) {
          text = rawContent
            .filter((item): item is { type: 'text'; text: string } => item.type === 'text')
            .map(item => item.text)
            .join('');
        }
      }

      const jsonMatch = text.match(/\[[\s\S]*\]/);
      if (!jsonMatch) {
        log.warn(`No JSON array found in relevance response (context=${contextLabel})`);
        if (attempt < MAX_RETRIES) {
          await delay(Math.pow(2, attempt + 1) * 1000);
          continue;
        }
        if (options.fallbackPassAllOnError) {
          log.warn(`Relevance parse failed; passing all entries as fallback (context=${contextLabel})`);
          return buildPassAllFallback();
        }
        return { passed: [], dropped: [], parseError: true };
      }

      const parsed = JSON.parse(jsonMatch[0]) as Array<{ id: number; score: number; matched_interests?: string[] }>;
      const scored = new Map<number, { score: number; matchedInterests: string[] }>();
      for (const entry of parsed) {
        if (typeof entry.id === 'number' && typeof entry.score === 'number') {
          const rawMatches = Array.isArray(entry.matched_interests) ? entry.matched_interests : [];
          const normalizedMatches = Array.from(
            new Set(
              rawMatches
                .filter((value): value is string => typeof value === 'string')
                .map(value => value.trim())
                .filter(Boolean)
                .map(value => interestLookup.get(value.toLowerCase()) || value),
            ),
          );
          const matchedInterests = hasInterestFilter
            ? normalizedMatches.filter(value => interestLookup.has(value.toLowerCase()))
            : normalizedMatches;
          scored.set(entry.id, { score: entry.score, matchedInterests });
        }
      }

      const passed: Array<{ entry: QueueEntry; score: number; matchedInterests: string[] }> = [];
      const dropped: Array<{ entry: QueueEntry; score: number; matchedInterests: string[]; reason: 'low_score' | 'no_interest_match' }> = [];

      for (let i = 0; i < entries.length; i++) {
        const entry = entries[i];
        const item = scored.get(i);
        const score = item?.score ?? (entry.feedPriority === 'high' ? 10 : threshold);
        const fallbackMatches = hasInterestFilter
          ? configuredInterests.filter(topic =>
            `${entry.feedName} ${entry.title} ${entry.snippet}`.toLowerCase().includes(topic.toLowerCase()),
          )
          : [];
        const matchedInterests = (item?.matchedInterests && item.matchedInterests.length > 0)
          ? item.matchedInterests
          : fallbackMatches;

        if (requireInterestMatch && matchedInterests.length === 0) {
          dropped.push({ entry, score, matchedInterests, reason: 'no_interest_match' });
          continue;
        }

        if (entry.feedPriority === 'high' || score >= threshold) {
          passed.push({ entry, score, matchedInterests });
        } else {
          dropped.push({ entry, score, matchedInterests, reason: 'low_score' });
        }
      }

      if (dropped.length > 0) {
        log.info(
          `Relevance dropped ${dropped.length} (context=${contextLabel}): ${dropped.map(d => `"${d.entry.title}" (${d.reason}, ${d.score}/${threshold})`).join(', ')}`
        );
      }
      log.info(
        `Relevance (${contextLabel}): ${passed.length}/${entries.length} passed `
        + `(threshold ${threshold}, requireInterestMatch=${requireInterestMatch}, interests=${configuredInterests.length})`
      );

      return { passed, dropped, parseError: false };
    } catch (err) {
      if (attempt < MAX_RETRIES) {
        const backoffMs = Math.pow(2, attempt + 1) * 1000;
        log.warn(`Relevance attempt ${attempt + 1} failed (context=${contextLabel}), retrying in ${backoffMs}ms: ${err}`);
        await delay(backoffMs);
      } else {
        if (options.fallbackPassAllOnError) {
          log.warn(`Relevance failed after retries; passing all entries as fallback (context=${contextLabel})`);
          return buildPassAllFallback();
        }
        log.error(`Relevance check failed after retries (context=${contextLabel}) — entries stay discovered for retry`, err);
        return { passed: [], dropped: [], parseError: true };
      }
    }
  }

  return { passed: [], dropped: [], parseError: true };
}
