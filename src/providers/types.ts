/**
 * Provider contract — opencode-model: a provider is a catalog entry (data row),
 * an auth resolution, and one of two transport dialects.
 * @architect-owned — see DESIGN.md "Seam 1 — Providers".
 */

/** Transport dialect. Exactly two exist; adding a provider must not add a third lightly. */
export type ProviderApi = 'gemini' | 'openai-chat';

export interface ModelSpec {
  /** Provider-native model id, e.g. 'gemini-3-flash' or 'qwen/qwen3-vl-235b-a22b-instruct'. */
  id: string;
  displayName?: string;
  /** All launch models are vision-capable; kept explicit for future text-only entries. */
  vision: boolean;
}

export interface ProviderSpec {
  id: 'gemini' | 'nvidia' | 'openrouter' | 'openai-compatible' | (string & {});
  displayName: string;
  api: ProviderApi;
  /** Env vars checked in order for the API key. */
  envKeys: string[];
  /**
   * Default base URL. `undefined` means the user MUST supply one
   * (openai-compatible) via flag/env/config — error copy names all three.
   */
  baseUrl?: string;
  /** Env var that can override/supply the base URL (openai-compatible: OPENAI_BASE_URL). */
  baseUrlEnvKey?: string;
  defaultModel: string;
  /** Curated launch models — informational for `okra providers list`; any id is accepted. */
  models: ModelSpec[];
  /** Free-text auth hint shown in `okra providers list` (where to get a key). */
  keyHint: string;
}

export type KeySource = 'flag' | 'env' | 'config';

export interface ResolvedProvider {
  spec: ProviderSpec;
  apiKey: string;
  baseUrl: string;
  keySource: KeySource;
}

/**
 * Inputs to resolution, precedence flag > env > config (DESIGN.md).
 * `config` is the `providers.<id>` section of the conf store.
 */
export interface ResolveInputs {
  flagKey?: string;
  flagBaseUrl?: string;
  env: NodeJS.ProcessEnv;
  config: { apiKey?: string; baseUrl?: string };
}
