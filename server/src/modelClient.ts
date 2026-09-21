import { createHash } from 'node:crypto';
import { SYSTEM_PROMPT } from './prompts.js';
import type { CallRecord, ModelSlot, ProviderConfig, QuizConfig } from './types.js';

export function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/**
 * True for loopback and private-network endpoints. Used to decide whether a
 * missing API key is suspicious, and to label a provider "local" in the UI.
 */
export function isLocalBaseUrl(baseUrl: string): boolean {
  let host: string;
  try {
    host = new URL(baseUrl).hostname.toLowerCase();
  } catch {
    return false;
  }
  const bare = host.replace(/^\[|\]$/g, '');
  if (bare === 'localhost' || bare === '::1' || bare === '0.0.0.0') return true;
  if (bare.endsWith('.local')) return true;
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(bare);
  if (v4) {
    const a = Number(v4[1]);
    const b = Number(v4[2]);
    if (a === 127 || a === 10) return true;
    if (a === 192 && b === 168) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 169 && b === 254) return true;
  }
  return false;
}

/** A provider-side failure, carrying the provider's own error text verbatim. */
export class ModelCallError extends Error {
  readonly status: number;
  readonly detail: string;
  constructor(status: number, detail: string) {
    super(detail);
    this.name = 'ModelCallError';
    this.status = status;
    this.detail = detail;
  }
}

interface ChatChoiceMessage {
  content?: unknown;
  /** Present on some providers. Read ONLY to prove we never surface it. */
  reasoning_content?: unknown;
}

interface ChatCompletionResponse {
  model?: unknown;
  choices?: unknown;
  usage?: unknown;
}

export interface ModelCallResult {
  text: string;
  record: CallRecord;
}

function numberOrZero(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/**
 * Pull the provider's real error text out of whatever shape it returned.
 * Never fabricate a message: if the body is unparseable, show the raw body.
 */
async function describeFailure(res: Response): Promise<string> {
  const raw = await res.text().catch(() => '');
  if (!raw) return `HTTP ${res.status} ${res.statusText}`.trim();
  try {
    const parsed = JSON.parse(raw) as { error?: unknown; message?: unknown };
    const err = parsed.error;
    if (typeof err === 'string') return `HTTP ${res.status}: ${err}`;
    if (err && typeof err === 'object') {
      const e = err as { message?: unknown; code?: unknown; type?: unknown };
      const parts = [e.message, e.code, e.type]
        .filter((p): p is string => typeof p === 'string' && p.length > 0);
      if (parts.length) return `HTTP ${res.status}: ${parts.join(' — ')}`;
    }
    if (typeof parsed.message === 'string') return `HTTP ${res.status}: ${parsed.message}`;
  } catch {
    /* fall through to raw body */
  }
  return `HTTP ${res.status}: ${raw.slice(0, 600)}`;
}

/**
 * One chat completion against an OpenAI-compatible endpoint, using plain fetch.
 *
 * Retries exactly once with a doubled token budget when the response carries
 * empty content (a reasoning-heavy model can spend the whole budget thinking).
 *
 * `reasoning_content` is read only to confirm it exists; it is never returned,
 * logged, or stored. Only `usage.completion_tokens_details.reasoning_tokens`
 * survives, as a count.
 */
export async function callModel(params: {
  config: QuizConfig;
  provider: ProviderConfig;
  model: string;
  slot: ModelSlot;
  prompt: string;
  promptIndex: number;
  itemId: string;
  log?: (message: string) => void;
}): Promise<ModelCallResult> {
  const { config, provider, model, slot, prompt, promptIndex, itemId, log } = params;
  const url = `${provider.baseUrl.replace(/\/+$/, '')}/chat/completions`;
  const startedAt = Date.now();

  let attempts = 0;
  let emptyRetries = 0;
  let budget = config.maxTokens;
  let retried = false;
  let lastEmptyReason = 'empty content';

  while (attempts < MAX_HTTP_ATTEMPTS) {
    attempts += 1;

    const body: Record<string, unknown> = {
      model,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: prompt },
      ],
      temperature: config.temperature,
      max_tokens: budget,
    };
    if (provider.disableReasoning) {
      body.chat_template_kwargs = { enable_thinking: false };
    }

    // Only send an Authorization header when there is a key. Local runtimes
    // (LM Studio, Ollama, llama.cpp) usually need none and some reject a
    // malformed empty bearer token.
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...(provider.headers ?? {}),
    };
    if (provider.apiKey.trim().length > 0) {
      headers.Authorization = `Bearer ${provider.apiKey.trim()}`;
    }

    let res: Response;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(300_000),
      });
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      throw new ModelCallError(0, `Could not reach ${provider.label} at ${url}: ${detail}`);
    }

    if (!res.ok) {
      // Transient provider trouble (rate limits, gateway hiccups) should not
      // kill an entire quiz. Back off and try again, honouring Retry-After.
      if (TRANSIENT_STATUS.has(res.status) && attempts < MAX_HTTP_ATTEMPTS) {
        const waitMs = retryAfterMs(res) ?? 500 * 2 ** (attempts - 1);
        const detail = await describeFailure(res);
        log?.(
          `transient ${res.status} from ${provider.label} — retrying in ${waitMs}ms ` +
            `(attempt ${attempts}/${MAX_HTTP_ATTEMPTS}): ${detail}`,
        );
        await sleep(waitMs);
        continue;
      }
      throw new ModelCallError(res.status, await describeFailure(res));
    }

    let json: ChatCompletionResponse;
    try {
      json = (await res.json()) as ChatCompletionResponse;
    } catch {
      throw new ModelCallError(res.status, `HTTP ${res.status}: response was not valid JSON`);
    }

    const choices = Array.isArray(json.choices) ? json.choices : [];
    const first = choices[0] as { message?: ChatChoiceMessage; finish_reason?: unknown } | undefined;
    const message = first?.message ?? {};
    const finishReason = typeof first?.finish_reason === 'string' ? first.finish_reason : null;
    const content = typeof message.content === 'string' ? message.content : '';

    // Reasoning is measured, never kept.
    const usage = (json.usage ?? {}) as {
      prompt_tokens?: unknown;
      completion_tokens?: unknown;
      completion_tokens_details?: { reasoning_tokens?: unknown };
      reasoning_tokens?: unknown;
    };
    const reasoningTokens = numberOrZero(
      usage.completion_tokens_details?.reasoning_tokens ?? usage.reasoning_tokens,
    );

    const text = content.trim();

    if (text.length > 0) {
      const reportedModel = typeof json.model === 'string' ? json.model : model;
      return {
        text,
        record: {
          itemId,
          promptIndex,
          prompt,
          slot,
          requestedModel: model,
          reportedModel,
          providerId: provider.id,
          providerLabel: provider.label,
          providerBaseUrl: provider.baseUrl,
          sha256: sha256(text),
          chars: text.length,
          promptTokens: numberOrZero(usage.prompt_tokens),
          completionTokens: numberOrZero(usage.completion_tokens),
          reasoningTokens,
          attempts,
          latencyMs: Date.now() - startedAt,
          retried,
          finishReason,
        },
      };
    }

    // Empty content: retry once with a doubled budget.
    lastEmptyReason = `empty content (finish_reason=${finishReason ?? 'unknown'}, completion_tokens=${numberOrZero(
      usage.completion_tokens,
    )}, reasoning_tokens=${reasoningTokens})`;
    if (emptyRetries < 1 && attempts < MAX_HTTP_ATTEMPTS) {
      emptyRetries += 1;
      retried = true;
      budget = config.maxTokens * 2;
      log?.(
        `empty content from ${model} on ${provider.label} — retrying with a doubled ` +
          `budget of ${budget} tokens`,
      );
      continue;
    }
    break;
  }

  const reasoningHint =
    lastEmptyReason.includes('reasoning_tokens=0')
      ? ''
      : ' The model spent its entire budget on reasoning and never emitted an answer — ' +
        'raise Max Tokens in Settings, or enable "Disable reasoning" for this provider.';

  throw new ModelCallError(
    200,
    `Model "${model}" on ${provider.label} returned ${lastEmptyReason} after ` +
      `${attempts} attempt(s) (final budget ${budget} tokens).${reasoningHint}`,
  );
}

/** Provider-side conditions that are worth retrying rather than failing on. */
const TRANSIENT_STATUS = new Set([408, 409, 425, 429, 500, 502, 503, 504, 529]);
const MAX_HTTP_ATTEMPTS = 3;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Parse a Retry-After header (seconds or HTTP date), if the provider sent one. */
function retryAfterMs(res: Response): number | null {
  const raw = res.headers.get('retry-after');
  if (!raw) return null;
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, 30_000);
  const date = Date.parse(raw);
  if (Number.isFinite(date)) {
    return Math.max(0, Math.min(date - Date.now(), 30_000));
  }
  return null;
}
/**
 * Ask a provider what it serves, via GET {baseUrl}/models.
 *
 * This runs server-side on purpose: local runtimes frequently send no CORS
 * headers, so the browser cannot call them directly.
 *
 * Handles the OpenAI shape ({ data: [{ id }] }) and the Ollama-native shape
 * ({ models: [{ name }] }) because both turn up in practice.
 */
export async function listProviderModels(params: {
  provider: ProviderConfig;
}): Promise<{ models: { id: string; ownedBy?: string }[]; latencyMs: number }> {
  const { provider } = params;
  const url = `${provider.baseUrl.replace(/\/+$/, '')}/models`;
  const startedAt = Date.now();

  const headers: Record<string, string> = { ...(provider.headers ?? {}) };
  if (provider.apiKey.trim().length > 0) {
    headers.Authorization = `Bearer ${provider.apiKey.trim()}`;
  }

  let res: Response;
  try {
    res = await fetch(url, { method: 'GET', headers, signal: AbortSignal.timeout(20_000) });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new ModelCallError(
      0,
      `Could not reach ${provider.label} at ${url}: ${detail}. ` +
        `Check the base URL and that the runtime is running.`,
    );
  }

  if (!res.ok) throw new ModelCallError(res.status, await describeFailure(res));

  let json: unknown;
  try {
    json = await res.json();
  } catch {
    throw new ModelCallError(res.status, `HTTP ${res.status}: ${url} did not return JSON.`);
  }

  const models: { id: string; ownedBy?: string }[] = [];
  const root = json as { data?: unknown; models?: unknown };

  if (Array.isArray(root.data)) {
    for (const entry of root.data) {
      const e = entry as { id?: unknown; owned_by?: unknown; name?: unknown };
      const id = typeof e.id === 'string' ? e.id : typeof e.name === 'string' ? e.name : null;
      if (id) {
        models.push({
          id,
          ...(typeof e.owned_by === 'string' ? { ownedBy: e.owned_by } : {}),
        });
      }
    }
  } else if (Array.isArray(root.models)) {
    for (const entry of root.models) {
      const e = entry as { id?: unknown; name?: unknown; model?: unknown };
      const id = typeof e.id === 'string' ? e.id : typeof e.name === 'string' ? e.name : null;
      if (id) models.push({ id });
    }
  } else if (Array.isArray(json)) {
    for (const entry of json) {
      if (typeof entry === 'string') models.push({ id: entry });
    }
  }

  if (models.length === 0) {
    throw new ModelCallError(
      res.status,
      `Reached ${provider.label} but found no models in the response from ${url}. ` +
        `Raw body: ${JSON.stringify(json).slice(0, 300)}`,
    );
  }

  models.sort((a, b) => a.id.localeCompare(b.id));
  return { models, latencyMs: Date.now() - startedAt };
}
