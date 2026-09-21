import type { ProviderConfig, QuizConfig } from './types';

/** A provider preset the user can add in one click. */
export interface ProviderPreset {
  key: string;
  label: string;
  baseUrl: string;
  /** Whether a key is normally required for this endpoint. */
  keyRequired: boolean;
  disableReasoning: boolean;
  hint: string;
}

export const PROVIDER_PRESETS: ProviderPreset[] = [
  {
    key: 'particle',
    label: 'Particle.ai',
    baseUrl: 'https://api.particle.ai/v1',
    keyRequired: true,
    disableReasoning: true,
    hint: 'Hosted inference. Needs an API key.',
  },
  {
    key: 'lmstudio',
    label: 'LM Studio (local)',
    baseUrl: 'http://localhost:1234/v1',
    keyRequired: false,
    disableReasoning: false,
    hint: 'Local server. Start LM Studio and enable its OpenAI-compatible server on port 1234.',
  },
  {
    key: 'ollama',
    label: 'Ollama (local)',
    baseUrl: 'http://localhost:11434/v1',
    keyRequired: false,
    disableReasoning: false,
    hint: 'Local server. Needs `ollama serve` running.',
  },
  {
    key: 'llamacpp',
    label: 'llama.cpp / vLLM (local)',
    baseUrl: 'http://localhost:8080/v1',
    keyRequired: false,
    disableReasoning: false,
    hint: 'Any local OpenAI-compatible server on port 8080.',
  },
  {
    key: 'openai',
    label: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    keyRequired: true,
    disableReasoning: false,
    hint: 'Hosted inference. Needs an API key.',
  },
  {
    key: 'openrouter',
    label: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    keyRequired: true,
    disableReasoning: false,
    hint: 'Hosted aggregator. Needs an API key.',
  },
  {
    key: 'custom',
    label: 'Custom endpoint',
    baseUrl: '',
    keyRequired: false,
    disableReasoning: false,
    hint: 'Any OpenAI-compatible /chat/completions endpoint.',
  },
];

export function makeProvider(preset: ProviderPreset, id: string): ProviderConfig {
  return {
    id,
    label: preset.label,
    baseUrl: preset.baseUrl,
    apiKey: '',
    disableReasoning: preset.disableReasoning,
  };
}

/** True for loopback / private-network endpoints — mirrors the server's check. */
export function isLocalUrl(baseUrl: string): boolean {
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

export function shortHost(baseUrl: string): string {
  try {
    const u = new URL(baseUrl);
    return u.host;
  } catch {
    return baseUrl || 'no url';
  }
}

// --------------------------------------------------------------- persistence

const STORAGE_KEY = 'wmwt.config.v2';
const LEGACY_KEY = 'wmwt.config.v1';

export const DEFAULT_PROVIDER_A: ProviderConfig = {
  id: 'particle',
  label: 'Particle.ai',
  baseUrl: 'https://api.particle.ai/v1',
  apiKey: '',
  disableReasoning: true,
};

export const DEFAULT_PROVIDER_B: ProviderConfig = {
  ...DEFAULT_PROVIDER_A,
};

export const DEFAULT_CONFIG: QuizConfig = {
  providers: [DEFAULT_PROVIDER_A],
  modelA: 'deepseek-v4-flash-0731',
  providerAId: 'particle',
  modelB: 'deepseek-v4.1-flash',
  providerBId: 'particle',
  temperature: 0,
  maxTokens: 1600,
};

/** Migrate the pre-multi-provider single-endpoint shape. */
function migrateLegacy(raw: string): QuizConfig | null {
  try {
    const old = JSON.parse(raw) as {
      baseUrl?: string;
      apiKey?: string;
      modelA?: string;
      modelB?: string;
      temperature?: number;
      maxTokens?: number;
      disableReasoning?: boolean;
    };
    const provider: ProviderConfig = {
      id: 'legacy',
      label: old.baseUrl ? shortHost(old.baseUrl) : 'Particle.ai',
      baseUrl: old.baseUrl ?? DEFAULT_PROVIDER_A.baseUrl,
      apiKey: old.apiKey ?? '',
      disableReasoning: old.disableReasoning ?? true,
    };
    return {
      providers: [provider],
      modelA: old.modelA ?? DEFAULT_CONFIG.modelA,
      providerAId: provider.id,
      modelB: old.modelB ?? DEFAULT_CONFIG.modelB,
      providerBId: provider.id,
      temperature: typeof old.temperature === 'number' ? old.temperature : 0,
      maxTokens: typeof old.maxTokens === 'number' ? old.maxTokens : 1600,
    };
  } catch {
    return null;
  }
}

export function loadConfig(): QuizConfig {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<QuizConfig>;
      const providers = Array.isArray(parsed.providers) && parsed.providers.length > 0
        ? parsed.providers.map((p, i) => ({
            id: p.id || `provider-${i + 1}`,
            label: p.label || p.baseUrl || `Provider ${i + 1}`,
            baseUrl: p.baseUrl ?? '',
            apiKey: p.apiKey ?? '',
            disableReasoning: p.disableReasoning ?? false,
            ...(p.headers ? { headers: p.headers } : {}),
          }))
        : [DEFAULT_PROVIDER_A];
      const ids = new Set(providers.map((p) => p.id));
      return {
        providers,
        modelA: parsed.modelA ?? DEFAULT_CONFIG.modelA,
        providerAId: ids.has(parsed.providerAId ?? '')
          ? (parsed.providerAId as string)
          : (providers[0] as ProviderConfig).id,
        modelB: parsed.modelB ?? DEFAULT_CONFIG.modelB,
        providerBId: ids.has(parsed.providerBId ?? '')
          ? (parsed.providerBId as string)
          : (providers[0] as ProviderConfig).id,
        temperature: typeof parsed.temperature === 'number' ? parsed.temperature : 0,
        maxTokens: typeof parsed.maxTokens === 'number' ? parsed.maxTokens : 1600,
      };
    }

    const legacy = localStorage.getItem(LEGACY_KEY);
    if (legacy) {
      const migrated = migrateLegacy(legacy);
      if (migrated) return migrated;
    }
  } catch {
    /* fall through to defaults */
  }
  return { ...DEFAULT_CONFIG, providers: [{ ...DEFAULT_PROVIDER_A }] };
}

export function saveConfig(config: QuizConfig): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(config));
  } catch {
    /* storage unavailable — settings simply do not persist */
  }
}

/** Resolve the provider object a slot points at. */
export function providerFor(config: QuizConfig, slot: 'A' | 'B'): ProviderConfig {
  const id = slot === 'A' ? config.providerAId : config.providerBId;
  const found = config.providers.find((p) => p.id === id);
  if (found) return found;
  return (
    config.providers[0] ?? { ...DEFAULT_PROVIDER_A }
  );
}