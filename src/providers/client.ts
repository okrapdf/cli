/**
 * createClient — the provider-facing entry point: given a ResolvedProvider, build the
 * `VlmClient` for its transport dialect. The engine/commands call this; parsers never do.
 *
 * providers/** may import core/** only (dependency rule 2).
 */

import type { VlmClient } from '../core/vlm.js';
import type { ResolvedProvider } from './types.js';
import { createGeminiClient } from './transports/gemini.js';
import { createOpenAiChatClient } from './transports/openai-chat.js';

export function createClient(resolved: ResolvedProvider): VlmClient {
  switch (resolved.spec.api) {
    case 'gemini':
      return createGeminiClient(resolved);
    case 'openai-chat':
      return createOpenAiChatClient(resolved);
    default: {
      // Exhaustive over ProviderApi; guards a future dialect added without a transport.
      const api: string = resolved.spec.api;
      throw new Error(`No transport for provider api '${api}' (provider ${resolved.spec.id}).`);
    }
  }
}
