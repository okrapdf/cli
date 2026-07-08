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
    // Ids verified against the live v1beta ListModels response 2026-07-08 —
    // GA models have bare ids; the 3-series flash/pro are still `-preview`.
    defaultModel: 'gemini-3-flash-preview',
    models: [
      { id: 'gemini-3-flash-preview', vision: true },
      { id: 'gemini-3.5-flash', vision: true },
      { id: 'gemini-3.1-flash-lite', vision: true },
      { id: 'gemini-3.1-pro-preview', vision: true },
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
    // Ids verified against the live /v1/models response 2026-07-08. Curated list
    // intentionally short — verify live availability before extending.
    defaultModel: 'nvidia/llama-3.1-nemotron-nano-vl-8b-v1',
    models: [
      { id: 'nvidia/llama-3.1-nemotron-nano-vl-8b-v1', vision: true },
      { id: 'meta/llama-3.2-90b-vision-instruct', vision: true },
      { id: 'microsoft/phi-3-vision-128k-instruct', vision: true },
    ],
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
 * Pure: never a network lookup.
 */
export function resolveProvider(spec: ProviderSpec, inputs: ResolveInputs): ResolvedProvider {
  const { flagKey, flagBaseUrl, env, config } = inputs;

  // --- API key: flag > env (envKeys in order) > config ---
  let apiKey: string | undefined;
  let keySource: ResolvedProvider['keySource'] | undefined;

  if (flagKey) {
    apiKey = flagKey;
    keySource = 'flag';
  } else {
    for (const envKey of spec.envKeys) {
      const v = env[envKey];
      if (v) {
        apiKey = v;
        keySource = 'env';
        break;
      }
    }
    if (!apiKey && config.apiKey) {
      apiKey = config.apiKey;
      keySource = 'config';
    }
  }

  if (!apiKey || !keySource) {
    const firstEnv = spec.envKeys[0];
    throw new Error(
      `No API key found for ${spec.id} (${spec.displayName}). ` +
        `Set ${firstEnv} in your environment, or run \`okra auth login ${spec.id}\`.`,
    );
  }

  // --- base URL: flag > baseUrlEnvKey env > config > spec default ---
  let baseUrl: string | undefined;
  if (flagBaseUrl) {
    baseUrl = flagBaseUrl;
  } else if (spec.baseUrlEnvKey && env[spec.baseUrlEnvKey]) {
    baseUrl = env[spec.baseUrlEnvKey];
  } else if (config.baseUrl) {
    baseUrl = config.baseUrl;
  } else {
    baseUrl = spec.baseUrl;
  }

  if (!baseUrl) {
    // Only reachable for openai-compatible (spec.baseUrl === undefined).
    const envHint = spec.baseUrlEnvKey ? `, set ${spec.baseUrlEnvKey},` : ',';
    throw new Error(
      `No base URL for ${spec.id} (${spec.displayName}). ` +
        `Pass --base-url <url>${envHint} or run \`okra auth login ${spec.id}\`.`,
    );
  }

  return { spec, apiKey, baseUrl, keySource };
}
