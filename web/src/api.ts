import { providerFor } from './config';
import { ApiError } from './types';
import type {
  GuessVerdict,
  ModelSlot,
  ProviderConfig,
  ProviderProbeResult,
  PublicQuiz,
  QuizConfig,
  QuizResult,
  ServerQuizConfig,
} from './types';

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, init);
  } catch {
    throw new ApiError(
      `Could not reach the quiz server at ${path}. Is it running? Check the terminal.`,
      'network',
    );
  }

  const raw = await res.text();
  let parsed: unknown = null;
  try {
    parsed = raw ? JSON.parse(raw) : null;
  } catch {
    parsed = null;
  }

  if (!res.ok) {
    const body = parsed as { error?: string; kind?: string } | null;
    // Surface the provider's real error text, verbatim.
    throw new ApiError(
      body?.error ?? `HTTP ${res.status} ${res.statusText}: ${raw.slice(0, 400)}`,
      body?.kind ?? 'internal',
      res.status,
    );
  }
  return parsed as T;
}

/** Bind each model slot to its concrete provider for the wire. */
export function toServerConfig(config: QuizConfig): ServerQuizConfig {
  return {
    providerA: providerFor(config, 'A'),
    modelA: config.modelA,
    providerB: providerFor(config, 'B'),
    modelB: config.modelB,
    temperature: config.temperature,
    maxTokens: config.maxTokens,
  };
}

export function createQuiz(config: QuizConfig, prompts?: string[]): Promise<PublicQuiz> {
  return request<PublicQuiz>('/api/quiz', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ config: toServerConfig(config), prompts }),
  });
}

/** Ask a provider what it serves. Runs server-side to dodge local CORS limits. */
export function probeProvider(provider: ProviderConfig): Promise<ProviderProbeResult> {
  return request<ProviderProbeResult>('/api/providers/models', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ provider }),
  });
}

export function getQuiz(quizId: string): Promise<PublicQuiz> {
  return request<PublicQuiz>(`/api/quiz/${encodeURIComponent(quizId)}`);
}

export function sendGuess(
  quizId: string,
  itemId: string,
  guess: ModelSlot,
): Promise<GuessVerdict> {
  return request<GuessVerdict>(`/api/quiz/${encodeURIComponent(quizId)}/guess`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ itemId, guess }),
  });
}

export function finishQuiz(quizId: string): Promise<QuizResult> {
  return request<QuizResult>(`/api/quiz/${encodeURIComponent(quizId)}/finish`, {
    method: 'POST',
  });
}

export function exportQuiz(quizId: string): Promise<{ path: string }> {
  return request<{ path: string }>(`/api/quiz/${encodeURIComponent(quizId)}/export`);
}