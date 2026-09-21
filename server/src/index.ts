import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { ConfigError, generateQuiz, resolvePrompts } from './quiz.js';
import { ModelCallError, isLocalBaseUrl, listProviderModels } from './modelClient.js';
import {
  appendQuizLog,
  buildVerdict,
  computeScore,
  exportQuizLog,
  getQuiz,
  listQuizzes,
  newId,
  readJsonl,
} from './store.js';
import type {
  GenerateQuizRequest,
  GuessRecord,
  ModelBreakdown,
  ModelSlot,
  ProviderConfig,
  ProviderProbeResult,
  ProviderSummary,
  PublicQuiz,
  QuizItem,
  QuizResult,
  StoredQuiz,
  TruthRow,
} from './types.js';

const PORT = Number(process.env.PORT ?? 3001);

const app = new Hono();
app.use('*', cors({ origin: (o) => o ?? '*', allowHeaders: ['Content-Type'] }));

function log(message: string): void {
  console.log(`${new Date().toISOString()} ${message}`);
}

/**
 * Explicit allowlist projection. The pre-guess payload is built field by field
 * rather than by deleting `trueModel`, so a future field cannot leak by default.
 */
function toPublicItem(item: QuizItem): { itemId: string; prompt: string; text: string } {
  return { itemId: item.itemId, prompt: item.prompt, text: item.text };
}

function toPublicQuiz(quiz: StoredQuiz): PublicQuiz {
  return {
    quizId: quiz.quizId,
    createdAt: quiz.createdAt,
    total: quiz.items.length,
    items: quiz.items.map(toPublicItem),
    models: { A: quiz.config.modelA, B: quiz.config.modelB },
    providers: {
      A: toProviderSummary(quiz.config.providerA),
      B: toProviderSummary(quiz.config.providerB),
    },
    settings: {
      temperature: quiz.config.temperature,
      maxTokens: quiz.config.maxTokens,
      disableReasoning: {
        A: quiz.config.providerA.disableReasoning,
        B: quiz.config.providerB.disableReasoning,
      },
    },
  };
}

/** Provider identity is public — it labels the buttons. Attribution is not. */
function toProviderSummary(provider: ProviderConfig): ProviderSummary {
  return {
    id: provider.id,
    label: provider.label,
    baseUrl: provider.baseUrl,
    local: isLocalBaseUrl(provider.baseUrl),
  };
}

function counterpartOf(quiz: StoredQuiz, item: QuizItem): QuizItem | undefined {
  return quiz.items.find((i) => i.pairId === item.pairId && i.itemId !== item.itemId);
}

function buildResult(quiz: StoredQuiz): QuizResult {
  const { score, total, misses, identicalItemsGuessedCorrectly } = computeScore(quiz);

  const truth: TruthRow[] = quiz.items.map((item) => {
    const guess = quiz.guesses.get(item.itemId);
    const other = counterpartOf(quiz, item);
    return {
      itemId: item.itemId,
      promptIndex: item.promptIndex,
      prompt: item.prompt,
      text: item.text,
      trueModel: item.trueModel,
      trueModelName: item.trueModelName,
      sha256: item.sha256,
      identicalPair: item.identicalPair,
      pairId: item.pairId,
      guess: guess?.guess ?? null,
      correct: guess?.correct ?? null,
      counterpartText: other?.text ?? null,
      counterpartModel: (item.trueModel === 'A' ? 'B' : 'A') as ModelSlot,
      counterpartModelName:
        item.trueModel === 'A' ? quiz.config.modelB : quiz.config.modelA,
      counterpartSha256: other?.sha256 ?? '',
    };
  });

  const breakdown: ModelBreakdown[] = (['A', 'B'] as const).map((slot) => {
    const modelName = slot === 'A' ? quiz.config.modelA : quiz.config.modelB;
    const provider = slot === 'A' ? quiz.config.providerA : quiz.config.providerB;
    const authored = quiz.items.filter((i) => i.trueModel === slot);
    const guessedCorrectly = authored.filter((i) => quiz.guesses.get(i.itemId)?.correct).length;
    const timesChosen = [...quiz.guesses.values()].filter((g) => g.guess === slot).length;
    return {
      slot,
      modelName,
      providerLabel: provider.label,
      providerBaseUrl: provider.baseUrl,
      providerLocal: isLocalBaseUrl(provider.baseUrl),
      authored: authored.length,
      guessedCorrectly,
      timesChosen,
      accuracy: authored.length > 0 ? guessedCorrectly / authored.length : 0,
    };
  });

  const identicalPairs = new Set(
    quiz.items.filter((i) => i.identicalPair).map((i) => i.pairId),
  ).size;

  return {
    quizId: quiz.quizId,
    score,
    total,
    percent: total > 0 ? Math.round((score / total) * 100) : 0,
    misses,
    identicalPairs,
    identicalItemsGuessedCorrectly,
    breakdown,
    verdict: buildVerdict(score, total, identicalPairs),
    truth,
    calls: quiz.calls,
    models: { A: quiz.config.modelA, B: quiz.config.modelB },
    providers: {
      A: toProviderSummary(quiz.config.providerA),
      B: toProviderSummary(quiz.config.providerB),
    },
    settings: {
      temperature: quiz.config.temperature,
      maxTokens: quiz.config.maxTokens,
      disableReasoning: {
        A: quiz.config.providerA.disableReasoning,
        B: quiz.config.providerB.disableReasoning,
      },
    },
    durationMs: Date.now() - new Date(quiz.createdAt).getTime(),
  };
}

app.get('/api/health', (c) => c.json({ ok: true, quizzes: listQuizzes().length }));

/**
 * Probe an OpenAI-compatible endpoint and list the models it serves.
 *
 * Server-side on purpose: local runtimes often send no CORS headers, so the
 * browser cannot query them directly. The provider's real error text is
 * returned verbatim on failure.
 */
app.post('/api/providers/models', async (c) => {
  let body: { provider?: Partial<ProviderConfig> } = {};
  try {
    body = (await c.req.json()) as { provider?: Partial<ProviderConfig> };
  } catch {
    return c.json({ error: 'Body must be JSON: { provider }.' }, 400);
  }

  const partial = body.provider;
  const baseUrl = partial?.baseUrl?.trim() ?? '';
  const label = partial?.label?.trim() || baseUrl || 'provider';

  if (!/^https?:\/\//i.test(baseUrl)) {
    return c.json(
      {
        error: `Base URL must start with http:// or https:// (got "${baseUrl}").`,
        kind: 'config',
      },
      400,
    );
  }

  const provider: ProviderConfig = {
    id: partial?.id?.trim() || 'probe',
    label,
    baseUrl,
    apiKey: partial?.apiKey?.trim() ?? '',
    disableReasoning: partial?.disableReasoning ?? false,
    ...(partial?.headers && Object.keys(partial.headers).length > 0
      ? { headers: partial.headers }
      : {}),
  };

  const startedAt = Date.now();
  try {
    const { models, latencyMs } = await listProviderModels({ provider });
    log(
      `[api] probe ${label} (${baseUrl}) — ${models.length} model(s) in ${latencyMs}ms` +
        `${provider.apiKey ? '' : ' [no key sent]'}`,
    );
    const result: ProviderProbeResult = {
      ok: true,
      baseUrl,
      label,
      models,
      keyless: provider.apiKey.length === 0,
      latencyMs,
    };
    return c.json(result);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    const status = err instanceof ModelCallError ? err.status : 0;
    log(`[api] probe ${label} (${baseUrl}) — failed after ${Date.now() - startedAt}ms: ${detail}`);
    const result: ProviderProbeResult = {
      ok: false,
      baseUrl,
      label,
      models: [],
      error: detail,
      keyless: provider.apiKey.length === 0,
      latencyMs: Date.now() - startedAt,
    };
    return c.json({ ...result, kind: 'provider', status }, 502);
  }
});

/** Create a quiz. This is the only endpoint that talks to the models. */
app.post('/api/quiz', async (c) => {
  let body: GenerateQuizRequest = {};
  try {
    body = (await c.req.json()) as GenerateQuizRequest;
  } catch {
    body = {};
  }

  const started = Date.now();
  try {
    const prompts = resolvePrompts(body.prompts);
    log(`[api] POST /api/quiz — generating ${prompts.length} prompts × 2 models`);
    const quiz = await generateQuiz(prompts, body.config, log);
    log(`[api] POST /api/quiz — done in ${Date.now() - started}ms (quiz ${quiz.quizId})`);
    return c.json(toPublicQuiz(quiz), 201);
  } catch (err) {
    if (err instanceof ConfigError) {
      log(`[api] POST /api/quiz — config error: ${err.message}`);
      return c.json({ error: err.message, kind: 'config' }, 400);
    }
    if (err instanceof ModelCallError) {
      // The provider's real error text, verbatim.
      log(`[api] POST /api/quiz — provider error ${err.status}: ${err.detail}`);
      return c.json({ error: err.detail, kind: 'provider', status: err.status }, 502);
    }
    const detail = err instanceof Error ? err.message : String(err);
    log(`[api] POST /api/quiz — failed: ${detail}`);
    return c.json({ error: detail, kind: 'internal' }, 500);
  }
});

/** Pre-guess view. Contains no `trueModel` anywhere. */
app.get('/api/quiz/:id', (c) => {
  const quiz = getQuiz(c.req.param('id'));
  if (!quiz) return c.json({ error: 'Unknown quiz id.' }, 404);
  return c.json(toPublicQuiz(quiz));
});

/** Record one guess and reveal only that item's truth. */
app.post('/api/quiz/:id/guess', async (c) => {
  const quiz = getQuiz(c.req.param('id'));
  if (!quiz) return c.json({ error: 'Unknown quiz id.' }, 404);

  let body: { itemId?: string; guess?: string } = {};
  try {
    body = (await c.req.json()) as { itemId?: string; guess?: string };
  } catch {
    return c.json({ error: 'Body must be JSON: { itemId, guess }.' }, 400);
  }

  const { itemId, guess } = body;
  if (typeof itemId !== 'string' || !itemId) {
    return c.json({ error: 'Missing "itemId".' }, 400);
  }
  if (guess !== 'A' && guess !== 'B') {
    return c.json({ error: 'Missing or invalid "guess": expected "A" or "B".' }, 400);
  }

  const item = quiz.items.find((i) => i.itemId === itemId);
  if (!item) return c.json({ error: `Item "${itemId}" is not part of this quiz.` }, 404);

  const existing = quiz.guesses.get(itemId);
  if (existing) {
    // Idempotent: re-guessing returns the original verdict, never re-scores.
    return c.json({
      itemId,
      guess: existing.guess,
      correct: existing.correct,
      trueModel: existing.trueModel,
      trueModelName: existing.trueModelName,
      identicalPair: existing.identicalPair,
      alreadyGuessed: true,
    });
  }

  const record: GuessRecord = {
    itemId,
    guess,
    correct: guess === item.trueModel,
    trueModel: item.trueModel,
    trueModelName: item.trueModelName,
    identicalPair: item.identicalPair,
    guessedAt: new Date().toISOString(),
  };
  quiz.guesses.set(itemId, record);
  log(
    `[api] guess quiz=${quiz.quizId} item=${itemId} guessed=${guess} ` +
      `truth=${item.trueModel} (${item.trueModelName}) correct=${record.correct} ` +
      `identical=${item.identicalPair}`,
  );

  return c.json({
    itemId,
    guess,
    correct: record.correct,
    trueModel: record.trueModel,
    trueModelName: record.trueModelName,
    identicalPair: record.identicalPair,
    alreadyGuessed: false,
  });
});

/** Full truth table + score. Logs the completed quiz to JSONL exactly once. */
app.post('/api/quiz/:id/finish', async (c) => {
  const quiz = getQuiz(c.req.param('id'));
  if (!quiz) return c.json({ error: 'Unknown quiz id.' }, 404);

  const result = buildResult(quiz);
  if (!quiz.finished) {
    quiz.finished = true;
    await appendQuizLog(quiz, result);
    log(
      `[api] finish quiz=${quiz.quizId} score=${result.score}/${result.total} ` +
        `identicalPairs=${result.identicalPairs} → appended to data/quiz-log.jsonl`,
    );
  }
  return c.json(result);
});

/** Download the full audit trail for one quiz as JSON. */
app.get('/api/quiz/:id/export', async (c) => {
  const quiz = getQuiz(c.req.param('id'));
  if (!quiz) return c.json({ error: 'Unknown quiz id.' }, 404);
  const result = buildResult(quiz);
  const path = await exportQuizLog(quiz, result);
  log(`[api] export quiz=${quiz.quizId} → ${path}`);
  return c.json({
    path,
    quizId: quiz.quizId,
    score: result.score,
    total: result.total,
    breakdown: result.breakdown,
    verdict: result.verdict,
    items: result.truth.map((row) => ({
      itemId: row.itemId,
      promptIndex: row.promptIndex,
      prompt: row.prompt,
      text: row.text,
      trueModel: row.trueModel,
      trueModelName: row.trueModelName,
      sha256: row.sha256,
      identicalPair: row.identicalPair,
      pairId: row.pairId,
      guess: row.guess,
      correct: row.correct,
      call: quiz.calls.find((call) => call.itemId === row.itemId) ?? null,
    })),
  });
});

/** Raw JSONL of every completed quiz. */
app.get('/api/log', async (c) => {
  const text = await readJsonl();
  const lines = text.split('\n').filter((l) => l.trim().length > 0);
  return c.json({
    path: 'data/quiz-log.jsonl',
    count: lines.length,
    entries: lines.map((l) => JSON.parse(l) as unknown),
  });
});

app.notFound((c) => c.json({ error: `No route for ${c.req.method} ${c.req.path}` }, 404));

serve({ fetch: app.fetch, port: PORT, hostname: '127.0.0.1' }, (info) => {
  log(`quiz server listening on http://127.0.0.1:${info.port}`);
  log('endpoints: POST /api/quiz · GET /api/quiz/:id · POST /api/quiz/:id/guess · POST /api/quiz/:id/finish');
});

export { app, buildResult, toPublicQuiz, newId };