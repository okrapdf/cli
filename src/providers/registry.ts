/**
 * The provider catalog + resolution.
 * @architect-owned data table; `resolveProvider` implementation is worker's (TDD per DESIGN.md).
 */

import type { ProviderSpec, ResolvedProvider, ResolveInputs } from './types.js';

export const PROVIDERS: ProviderSpec[] = [
  {
    id: 'gemini',
    displayName: 'Google Gemini (AI Studio)',
    api: 'gemini',
    envKeys: ['GEMINI_API_KEY', 'GOOGLE_API_KEY'],
    baseUrl: 'https://generativelanguage.googleapis.com',
    defaultModel: 'gemini-3-flash',
    models: [
      { id: 'gemini-3-flash', vision: true },
      { id: 'gemini-3.1-pro', vision: true },
      { id: 'gemini-3.1-flash-lite', vision: true },
      { id: 'gemini-2.5-flash', vision: true },
    ],
    keyHint: 'Free key at https://aistudio.google.com/apikey',
  },
  {
    id: 'nvidia',
    displayName: 'NVIDIA NIM',
    api: 'openai-chat',
    envKeys: ['NVIDIA_API_KEY'],
    baseUrl: 'https://integrate.api.nvidia.com/v1',
    // Curated list intentionally short — verify live availability before extending
    // (`okra models --provider nvidia` hits /v1/models with the user's key).
    defaultModel: 'qwen/qwen3-vl-235b-a22b-instruct',
    models: [{ id: 'qwen/qwen3-vl-235b-a22b-instruct', vision: true }],
    keyHint: 'Key at https://build.nvidia.com (free dev tier)',
  },
  {
    id: 'openrouter',
    displayName: 'OpenRouter',
    api: 'openai-chat',
    envKeys: ['OPENROUTER_API_KEY'],
    baseUrl: 'https://openrouter.ai/api/v1',
    defaultModel: 'google/gemini-3-flash-preview',
    models: [
      { id: 'google/gemini-3-flash-preview', vision: true },
      { id: 'qwen/qwen3-vl-235b-a22b-instruct', vision: true },
    ],
    keyHint: 'Key at https://openrouter.ai/keys',
  },
  {
    id: 'openai-compatible',
    displayName: 'OpenAI-compatible endpoint (vLLM / Ollama / …)',
    api: 'openai-chat',
    envKeys: ['OPENAI_API_KEY'],
    baseUrl: undefined,
    baseUrlEnvKey: 'OPENAI_BASE_URL',
    defaultModel: '',
    models: [],
    keyHint: 'Your own endpoint: set OPENAI_BASE_URL + OPENAI_API_KEY, or `okra auth login openai-compatible`',
  },
];

export function getProvider(id: string): ProviderSpec | undefined {
  return PROVIDERS.find((p) => p.id === id);
}

/**
 * Resolve key + base URL with precedence flag > env > config (DESIGN.md, issue #2).
 * Throws a user-facing Error when the key (or a required base URL) is missing —
 * the message MUST name the first env var and the `okra auth login <id>` fix.
 */
export function resolveProvider(_spec: ProviderSpec, _inputs: ResolveInputs): ResolvedProvider {
  throw new Error('TODO(worker): implement per DESIGN.md — tests first');
}
