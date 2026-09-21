/** Mirror of the server's wire types. Kept in sync by hand; the server owns truth. */

export type ModelSlot = 'A' | 'B';

/**
 * One OpenAI-compatible endpoint. Local runtimes (LM Studio, Ollama, llama.cpp,
 * vLLM) and hosted APIs are described the same way.
 */
export interface ProviderConfig {
  id: string;
  label: string;
  baseUrl: string;
  apiKey: string;
  headers?: Record<string, string>;
  /** Send `chat_template_kwargs: { enable_thinking: false }`. */
  disableReasoning: boolean;
}

/** Client-side configuration: a provider list plus two model slots. */
export interface QuizConfig {
  providers: ProviderConfig[];
  modelA: string;
  providerAId: string;
  modelB: string;
  providerBId: string;
  temperature: number;
  maxTokens: number;
}

/** What the server receives: each slot bound to a concrete endpoint. */
export interface ServerQuizConfig {
  providerA: ProviderConfig;
  modelA: string;
  providerB: ProviderConfig;
  modelB: string;
  temperature: number;
  maxTokens: number;
}

export interface ProviderSummary {
  id: string;
  label: string;
  baseUrl: string;
  local: boolean;
}

export interface ProviderModel {
  id: string;
  ownedBy?: string;
}

export interface ProviderProbeResult {
  ok: boolean;
  baseUrl: string;
  label: string;
  models: ProviderModel[];
  error?: string;
  keyless: boolean;
  latencyMs: number;
}

export interface PublicQuizItem {
  itemId: string;
  prompt: string;
  text: string;
}

export interface PublicQuiz {
  quizId: string;
  createdAt: string;
  total: number;
  items: PublicQuizItem[];
  models: { A: string; B: string };
  providers: { A: ProviderSummary; B: ProviderSummary };
  settings: {
    temperature: number;
    maxTokens: number;
    disableReasoning: { A: boolean; B: boolean };
  };
}

export interface GuessVerdict {
  itemId: string;
  guess: ModelSlot;
  correct: boolean;
  trueModel: ModelSlot;
  trueModelName: string;
  identicalPair: boolean;
  alreadyGuessed: boolean;
}

export interface TruthRow {
  itemId: string;
  promptIndex: number;
  prompt: string;
  text: string;
  trueModel: ModelSlot;
  trueModelName: string;
  sha256: string;
  identicalPair: boolean;
  pairId: string;
  guess: ModelSlot | null;
  correct: boolean | null;
  counterpartText: string | null;
  counterpartModel: ModelSlot;
  counterpartModelName: string;
  counterpartSha256: string;
}

export interface ModelBreakdown {
  slot: ModelSlot;
  modelName: string;
  providerLabel: string;
  providerBaseUrl: string;
  providerLocal: boolean;
  authored: number;
  guessedCorrectly: number;
  timesChosen: number;
  accuracy: number;
}

export interface CallRecord {
  itemId: string;
  promptIndex: number;
  prompt: string;
  slot: ModelSlot;
  requestedModel: string;
  reportedModel: string;
  providerId: string;
  providerLabel: string;
  providerBaseUrl: string;
  sha256: string;
  chars: number;
  promptTokens: number;
  completionTokens: number;
  reasoningTokens: number;
  attempts: number;
  latencyMs: number;
  retried: boolean;
  finishReason: string | null;
}

export interface QuizResult {
  quizId: string;
  score: number;
  total: number;
  percent: number;
  misses: number;
  identicalPairs: number;
  identicalItemsGuessedCorrectly: number;
  breakdown: ModelBreakdown[];
  verdict: string;
  truth: TruthRow[];
  calls: CallRecord[];
  models: { A: string; B: string };
  providers: { A: ProviderSummary; B: ProviderSummary };
  settings: {
    temperature: number;
    maxTokens: number;
    disableReasoning: { A: boolean; B: boolean };
  };
  durationMs: number;
}

export interface ApiErrorBody {
  error: string;
  kind?: 'config' | 'provider' | 'internal';
  status?: number;
}

/** A failure carrying the provider's own error text, for display verbatim. */
export class ApiError extends Error {
  readonly kind: string;
  readonly status: number;
  constructor(message: string, kind = 'internal', status = 0) {
    super(message);
    this.name = 'ApiError';
    this.kind = kind;
    this.status = status;
  }
}