import { randomInt } from 'node:crypto';
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { QuizItem, QuizResult, StoredQuiz } from './types.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = resolve(HERE, '../../data');
const JSONL_PATH = resolve(DATA_DIR, 'quiz-log.jsonl');

/** In-memory, session-scoped persistence. No database, by design. */
const quizzes = new Map<string, StoredQuiz>();

export function putQuiz(quiz: StoredQuiz): void {
  quizzes.set(quiz.quizId, quiz);
}

export function getQuiz(quizId: string): StoredQuiz | undefined {
  return quizzes.get(quizId);
}

export function listQuizzes(): StoredQuiz[] {
  return [...quizzes.values()];
}

/** Cryptographically random, URL-safe id. */
export function newId(bytes = 12): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return Buffer.from(buf).toString('base64url');
}

/**
 * Fisher-Yates with a CSPRNG. The shuffle is the only thing standing between
 * the client and the answer, so it must not be predictable from the item order.
 */
export function shuffle<T>(input: readonly T[]): T[] {
  const out = [...input];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = randomInt(i + 1);
    const a = out[i] as T;
    const b = out[j] as T;
    out[i] = b;
    out[j] = a;
  }
  return out;
}

export function computeScore(quiz: StoredQuiz): {
  score: number;
  total: number;
  misses: number;
  identicalItemsGuessedCorrectly: number;
} {
  let score = 0;
  let identicalItemsGuessedCorrectly = 0;
  for (const item of quiz.items) {
    const guess = quiz.guesses.get(item.itemId);
    if (!guess) continue;
    if (guess.correct) {
      score += 1;
      if (item.identicalPair) identicalItemsGuessedCorrectly += 1;
    }
  }
  return {
    score,
    total: quiz.items.length,
    misses: quiz.guesses.size - score,
    identicalItemsGuessedCorrectly,
  };
}

export function buildVerdict(score: number, total: number, identicalPairs: number): string {
  const pct = total > 0 ? Math.round((score / total) * 100) : 0;
  const indistinguishable = 100 - pct;
  const pairNote =
    identicalPairs > 0
      ? ` ${identicalPairs} of the ${total} items were byte-identical from both models — those rounds were coin flips by construction.`
      : '';
  if (pct <= 50) {
    return `You could not tell them apart — ${indistinguishable}% of your guesses were coin flips.${pairNote}`;
  }
  if (pct <= 70) {
    return `Barely a signal: ${indistinguishable}% of your guesses were coin flips, which is roughly what guessing would give you.${pairNote}`;
  }
  return `You found a real signal — ${pct}% correct, well above chance.${pairNote}`;
}

export async function appendQuizLog(quiz: StoredQuiz, result: QuizResult): Promise<void> {
  await mkdir(DATA_DIR, { recursive: true });
  const entry = {
    type: 'quiz.completed',
    loggedAt: new Date().toISOString(),
    quizId: quiz.quizId,
    createdAt: quiz.createdAt,
    models: { A: quiz.config.modelA, B: quiz.config.modelB },
    providers: {
      A: { label: quiz.config.providerA.label, baseUrl: quiz.config.providerA.baseUrl },
      B: { label: quiz.config.providerB.label, baseUrl: quiz.config.providerB.baseUrl },
    },
    settings: {
      temperature: quiz.config.temperature,
      maxTokens: quiz.config.maxTokens,
      disableReasoning: {
        A: quiz.config.providerA.disableReasoning,
        B: quiz.config.providerB.disableReasoning,
      },
    },
    score: result.score,
    total: result.total,
    percent: result.percent,
    identicalPairs: result.identicalPairs,
    breakdown: result.breakdown,
    verdict: result.verdict,
    calls: quiz.calls.map((c) => ({
      itemId: c.itemId,
      slot: c.slot,
      requestedModel: c.requestedModel,
      reportedModel: c.reportedModel,
      sha256: c.sha256,
      chars: c.chars,
      reasoningTokens: c.reasoningTokens,
      attempts: c.attempts,
      latencyMs: c.latencyMs,
      finishReason: c.finishReason,
    })),
    guesses: [...quiz.guesses.values()].map((g) => ({
      itemId: g.itemId,
      guess: g.guess,
      trueModel: g.trueModel,
      correct: g.correct,
      identicalPair: g.identicalPair,
    })),
  };
  await appendFile(JSONL_PATH, `${JSON.stringify(entry)}\n`, 'utf8');
}

/** Full audit dump: every item with its recorded call, for verification. */
export async function exportQuizLog(quiz: StoredQuiz, result: QuizResult): Promise<string> {
  await mkdir(DATA_DIR, { recursive: true });
  const callsByItem = new Map<string, typeof quiz.calls>();
  for (const call of quiz.calls) {
    const list = callsByItem.get(call.itemId) ?? [];
    list.push(call);
    callsByItem.set(call.itemId, list);
  }
  const payload = {
    exportedAt: new Date().toISOString(),
    quizId: quiz.quizId,
    createdAt: quiz.createdAt,
    models: { A: quiz.config.modelA, B: quiz.config.modelB },
    providers: {
      A: { label: quiz.config.providerA.label, baseUrl: quiz.config.providerA.baseUrl },
      B: { label: quiz.config.providerB.label, baseUrl: quiz.config.providerB.baseUrl },
    },
    settings: {
      temperature: quiz.config.temperature,
      maxTokens: quiz.config.maxTokens,
      disableReasoning: {
        A: quiz.config.providerA.disableReasoning,
        B: quiz.config.providerB.disableReasoning,
      },
    },
    score: result.score,
    total: result.total,
    verdict: result.verdict,
    breakdown: result.breakdown,
    items: quiz.items.map((item: QuizItem) => ({
      itemId: item.itemId,
      promptIndex: item.promptIndex,
      prompt: item.prompt,
      text: item.text,
      trueModel: item.trueModel,
      trueModelName: item.trueModelName,
      sha256: item.sha256,
      identicalPair: item.identicalPair,
      pairId: item.pairId,
      call: callsByItem.get(item.itemId)?.[0] ?? null,
      guess: quiz.guesses.get(item.itemId) ?? null,
    })),
    calls: quiz.calls,
  };
  const path = resolve(DATA_DIR, `quiz-${quiz.quizId}.json`);
  await writeFile(path, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  return path;
}

export async function readJsonl(): Promise<string> {
  try {
    return await readFile(JSONL_PATH, 'utf8');
  } catch {
    return '';
  }
}

export const paths = { DATA_DIR, JSONL_PATH };