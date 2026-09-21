import { callModel, isLocalBaseUrl, sha256 } from './modelClient.js';
import { DEFAULT_CONFIG, DEFAULT_PROMPTS } from './prompts.js';
import { newId, putQuiz, shuffle } from './store.js';
import type {
  CallRecord,
  ModelSlot,
  ProviderConfig,
  QuizConfig,
  QuizItem,
  StoredQuiz,
} from './types.js';

export class ConfigError extends Error {}

function resolveProvider(
  partial: Partial<ProviderConfig> | undefined,
  fallback: ProviderConfig,
  slot: 'A' | 'B',
): ProviderConfig {
  const baseUrl = partial?.baseUrl?.trim() || fallback.baseUrl;
  if (!/^https?:\/\//i.test(baseUrl)) {
    throw new ConfigError(
      `Provider ${slot}: base URL must start with http:// or https:// (got "${baseUrl}").`,
    );
  }
  const label = partial?.label?.trim() || fallback.label;
  const apiKey = partial?.apiKey?.trim() ?? '';
  if (!apiKey && !isLocalBaseUrl(baseUrl)) {
    throw new ConfigError(
      `Provider ${slot} ("${label}") is a remote endpoint at ${baseUrl} but no API key was set. ` +
        `Add a key, or point it at a local runtime.`,
    );
  }
  return {
    id: partial?.id?.trim() || fallback.id,
    label,
    baseUrl,
    apiKey,
    disableReasoning: partial?.disableReasoning ?? fallback.disableReasoning,
    ...(partial?.headers && Object.keys(partial.headers).length > 0
      ? { headers: partial.headers }
      : {}),
  };
}

export function resolveConfig(partial: Partial<QuizConfig> | undefined): QuizConfig {
  const providerA = resolveProvider(partial?.providerA, DEFAULT_CONFIG.providerA, 'A');
  const providerB = resolveProvider(partial?.providerB, DEFAULT_CONFIG.providerB, 'B');

  const merged: QuizConfig = {
    providerA,
    modelA: partial?.modelA?.trim() || DEFAULT_CONFIG.modelA,
    providerB,
    modelB: partial?.modelB?.trim() || DEFAULT_CONFIG.modelB,
    temperature:
      typeof partial?.temperature === 'number' && Number.isFinite(partial.temperature)
        ? partial.temperature
        : DEFAULT_CONFIG.temperature,
    maxTokens:
      typeof partial?.maxTokens === 'number' && Number.isFinite(partial.maxTokens)
        ? Math.max(1, Math.floor(partial.maxTokens))
        : DEFAULT_CONFIG.maxTokens,
  };

  // The same model name on two *different* endpoints is a legitimate and
  // interesting comparison (local vs hosted weights). The same model name on
  // the same endpoint is not a game at all.
  const sameEndpoint =
    providerA.baseUrl.replace(/\/+$/, '') === providerB.baseUrl.replace(/\/+$/, '');
  if (merged.modelA === merged.modelB && sameEndpoint) {
    throw new ConfigError(
      `Model A and Model B are both "${merged.modelA}" on ${providerA.baseUrl}. ` +
        `Pick two different models, or point them at two different providers — that is the whole game.`,
    );
  }
  return merged;
}

export function resolvePrompts(prompts: string[] | undefined): string[] {
  if (!prompts || prompts.length === 0) return [...DEFAULT_PROMPTS];
  const cleaned = prompts.map((p) => p.trim()).filter((p) => p.length > 0);
  return cleaned.length > 0 ? cleaned : [...DEFAULT_PROMPTS];
}

/**
 * Generate a full quiz: for each prompt, call both models with the identical
 * prompt, then build the item list and shuffle it.
 *
 * Ground truth is bound at call time: the slot that produced the text is the
 * slot recorded on the item. Nothing downstream re-derives it.
 */
export async function generateQuiz(
  rawPrompts: string[] | undefined,
  rawConfig: Partial<QuizConfig> | undefined,
  log: (message: string) => void,
): Promise<StoredQuiz> {
  const config = resolveConfig(rawConfig);
  const prompts = resolvePrompts(rawPrompts);
  const quizId = newId(9);
  const createdAt = new Date().toISOString();

  const items: QuizItem[] = [];
  const calls: CallRecord[] = [];
  const modelNames: Record<ModelSlot, string> = { A: config.modelA, B: config.modelB };

  for (let promptIndex = 0; promptIndex < prompts.length; promptIndex += 1) {
    const prompt = prompts[promptIndex] as string;
    const pairId = `pair-${promptIndex + 1}`;

    // Both models get the byte-identical prompt. Slots are generated in a
    // fixed order (A then B) so the server log is deterministic; the client
    // never learns which slot produced which item until it guesses.
    const results = await Promise.all(
      (['A', 'B'] as const).map(async (slot) => {
        const model = slot === 'A' ? config.modelA : config.modelB;
        const provider = slot === 'A' ? config.providerA : config.providerB;
        const itemId = newId(9);
        log(
          `[quiz ${quizId}] call prompt#${promptIndex + 1} slot ${slot} -> ` +
            `${model} @ ${provider.label} (${provider.baseUrl})`,
        );
        const { text, record } = await callModel({
          config,
          provider,
          model,
          slot,
          prompt,
          promptIndex,
          itemId,
          log: (m) => log(`[quiz ${quizId}] ${m}`),
        });
        log(
          `[quiz ${quizId}] ok   prompt#${promptIndex + 1} slot ${slot} ` +
            `${record.chars} chars sha256=${record.sha256.slice(0, 12)}… ` +
            `reasoning_tokens=${record.reasoningTokens} attempts=${record.attempts} ` +
            `${record.latencyMs}ms`,
        );
        return { slot, model, itemId, text, record };
      }),
    );

    const [first, second] = results as [
      (typeof results)[number],
      (typeof results)[number],
    ];

    // Identical detection is a sha256 comparison of the exact output bytes.
    const identical = first.record.sha256 === second.record.sha256;

    results.forEach((r, index) => {
      calls.push(r.record);
      items.push({
        itemId: r.itemId,
        promptIndex,
        prompt,
        text: r.text,
        trueModel: r.slot,
        trueModelName: modelNames[r.slot],
        sha256: r.record.sha256,
        identicalPair: identical,
        pairId,
        pairSlot: index,
      });
    });

    if (identical) {
      log(
        `[quiz ${quizId}] IDENTICAL pair on prompt#${promptIndex + 1} ` +
          `(sha256 ${first.record.sha256.slice(0, 12)}…) — kept, flagged for reveal`,
      );
    }
  }

  const quiz: StoredQuiz = {
    quizId,
    createdAt,
    config,
    items: shuffle(items),
    calls,
    guesses: new Map(),
    finished: false,
  };
  putQuiz(quiz);
  log(
    `[quiz ${quizId}] ready: ${quiz.items.length} items from ${calls.length} real calls, ` +
      `shuffled. ${items.filter((i) => i.identicalPair).length} item(s) in identical pairs.`,
  );
  return quiz;
}

export { sha256 };