/**
 * The five prompts. Deliberately spanning the spectrum from constrained to
 * creative: the creative end is where two sibling models actually diverge,
 * which is what makes the quiz interesting rather than a pure coin flip.
 */
export const DEFAULT_PROMPTS: readonly string[] = [
  'Write a haiku about a broken clock.',
  'Explain photosynthesis in exactly one sentence.',
  'Write a short product description for a smart umbrella that warns you before it rains.',
  'Tell me a joke about programmers.',
  'Write a three-sentence story about a lighthouse keeper who forgets why the light matters.',
];

export const SYSTEM_PROMPT =
  "You are a precise assistant. Answer the user's request directly.";

/**
 * Defaults. The provider presets here mirror the ones the UI ships with, so a
 * request that omits configuration still behaves sensibly.
 */
export const PARTICLE_PROVIDER = {
  id: 'particle',
  label: 'Particle.ai',
  baseUrl: 'https://api.particle.ai/v1',
  apiKey: '',
  disableReasoning: true,
} as const;

export const LM_STUDIO_PROVIDER = {
  id: 'lmstudio',
  label: 'LM Studio (local)',
  baseUrl: 'http://localhost:1234/v1',
  apiKey: '',
  disableReasoning: false,
} as const;

export const DEFAULT_CONFIG = {
  providerA: { ...PARTICLE_PROVIDER },
  modelA: 'deepseek-v4-flash-0731',
  providerB: { ...PARTICLE_PROVIDER },
  modelB: 'deepseek-v4.1-flash',
  temperature: 0,
  maxTokens: 1600,
} as const;