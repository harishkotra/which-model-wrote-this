/** Shared wire + internal types for the quiz server. */

export type ModelSlot = 'A' | 'B';

/**
 * One OpenAI-compatible endpoint. Local runtimes (LM Studio, Ollama, llama.cpp,
 * vLLM) and hosted APIs are described the same way; the only practical
 * difference is that a local endpoint usually needs no key.
 */
export interface ProviderConfig {
  id: string;
  label: string;
  baseUrl: string;
  apiKey: string;
  /** Extra request headers, for gateways that need them. */
  headers?: Record<string, string>;
  /** Send `chat_template_kwargs: { enable_thinking: false }`. */
  disableReasoning: boolean;
}

/** Configuration supplied by the client on every quiz-creation request. */
export interface QuizConfig {
  providerA: ProviderConfig;
  modelA: string;
  providerB: ProviderConfig;
  modelB: string;
  temperature: number;
  maxTokens: number;
}

/** A provider's model catalogue, as reported by GET {baseUrl}/models. */
export interface ProviderModel {
  id: string;
  ownedBy?: string;
}

export interface ProviderProbeResult {
  ok: boolean;
  baseUrl: string;
  label: string;
  models: ProviderModel[];
  /** The provider's own error text when the probe failed. */
  error?: string;
  /** True when the endpoint needed no key and none was sent. */
  keyless: boolean;
  latencyMs: number;
}

export interface GenerateQuizRequest {
  prompts?: string[];
  config?: Partial<QuizConfig>;
}

/** A single model call, recorded at call time. This is the ground truth. */
export interface CallRecord {
  itemId: string;
  promptIndex: number;
  prompt: string;
  slot: ModelSlot;
  /** The exact model id sent in the request body. */
  requestedModel: string;
  /** The model id the provider echoed back (may be a dated snapshot). */
  reportedModel: string;
  /** Which endpoint answered, recorded at call time. */
  providerId: string;
  providerLabel: string;
  providerBaseUrl: string;
  /** sha256 of the exact output text. */
  sha256: string;
  chars: number;
  /** Token accounting from usage. Reasoning is counted, never captured. */
  promptTokens: number;
  completionTokens: number;
  reasoningTokens: number;
  /** Number of HTTP attempts made (retry on empty content doubles the budget). */
  attempts: number;
  latencyMs: number;
  /** True when a retry was needed because the first response had empty content. */
  retried: boolean;
  finishReason: string | null;
}

/** Server-side item. `trueModel` never leaves the process before a guess. */
export interface QuizItem {
  itemId: string;
  promptIndex: number;
  prompt: string;
  text: string;
  trueModel: ModelSlot;
  trueModelName: string;
  sha256: string;
  /** Set on both members of a byte-identical pair. */
  identicalPair: boolean;
  pairId: string;
  /** Position of this item within its prompt's pair (0 = first generated). */
  pairSlot: number;
}

/** What the client is allowed to see before guessing. */
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
  /** Where each model is served, so the buttons can name the endpoint. */
  providers: { A: ProviderSummary; B: ProviderSummary };
  settings: {
    temperature: number;
    maxTokens: number;
    disableReasoning: { A: boolean; B: boolean };
  };
}

/** Provider identity safe to show before guessing. */
export interface ProviderSummary {
  id: string;
  label: string;
  baseUrl: string;
  /** True when this endpoint is on the local machine or a private network. */
  local: boolean;
}

export interface GuessRecord {
  itemId: string;
  guess: ModelSlot;
  correct: boolean;
  trueModel: ModelSlot;
  trueModelName: string;
  identicalPair: boolean;
  guessedAt: string;
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
  /** The output the other model produced for the same prompt, for comparison. */
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
  /** How many items this model actually wrote. */
  authored: number;
  /** How many of those the player attributed to this model correctly. */
  guessedCorrectly: number;
  /** How many items the player attributed to this model in total. */
  timesChosen: number;
  accuracy: number;
}

export interface QuizResult {
  quizId: string;
  score: number;
  total: number;
  percent: number;
  /** Guesses that landed on the wrong model. */
  misses: number;
  /** Items where both models produced byte-identical text. */
  identicalPairs: number;
  /** How many identical-pair items the player got "right" (a coin flip by construction). */
  identicalItemsGuessedCorrectly: number;
  breakdown: ModelBreakdown[];
  verdict: string;
  truth: TruthRow[];
  calls: CallRecord[];
  models: { A: string; B: string };
  providers: { A: ProviderSummary; B: ProviderSummary };
  settings: { temperature: number; maxTokens: number; disableReasoning: { A: boolean; B: boolean } };
  durationMs: number;
}

export interface StoredQuiz {
  quizId: string;
  createdAt: string;
  config: QuizConfig;
  items: QuizItem[];
  calls: CallRecord[];
  guesses: Map<string, GuessRecord>;
  finished: boolean;
}