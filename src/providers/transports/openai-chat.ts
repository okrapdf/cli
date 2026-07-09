/**
 * openai-chat transport — the OpenAI /chat/completions dialect (NVIDIA, OpenRouter,
 * vLLM/Ollama, any OpenAI-compatible endpoint). Implements core `VlmClient` over the
 * GLOBAL `fetch` only (no got/axios/SDK) so the no-cloud guard stays airtight.
 *
 * providers/** may import core/** only (dependency rule 2).
 */

import type { VlmClient, VlmRequest, VlmResponse } from '../../core/vlm.js';
import type { TokenUsage } from '../../core/blocks.js';
import type { ResolvedProvider } from '../types.js';
import { vlmHttpError } from './http-error.js';

/** Fallbacks used only when the parser omits them (parsers pass explicit values). */
const DEFAULT_MAX_TOKENS = 4096;
const DEFAULT_TEMPERATURE = 0;

function dataUri(png: Uint8Array): string {
  return `data:image/png;base64,${Buffer.from(png).toString('base64')}`;
}

interface OpenAiChatResponse {
  choices?: Array<{ message?: { content?: string | null } }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    completion_tokens_details?: { reasoning_tokens?: number };
  };
}

export function createOpenAiChatClient(resolved: ResolvedProvider): VlmClient {
  const base = resolved.baseUrl.replace(/\/+$/, '');
  const url = `${base}/chat/completions`;

  return {
    async complete(req: VlmRequest, signal?: AbortSignal): Promise<VlmResponse> {
      const body = {
        model: req.model,
        temperature: req.temperature ?? DEFAULT_TEMPERATURE,
        max_tokens: req.maxOutputTokens ?? DEFAULT_MAX_TOKENS,
        messages: [
          { role: 'system', content: req.system },
          {
            role: 'user',
            content: [
              { type: 'text', text: req.user },
              ...req.images.map((img) => ({
                type: 'image_url',
                image_url: { url: dataUri(img.png) },
              })),
            ],
          },
        ],
      };

      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${resolved.apiKey}`,
        },
        body: JSON.stringify(body),
        signal,
      });

      if (!res.ok) {
        const errBody = await res.text().catch(() => '');
        throw vlmHttpError(
          `${resolved.spec.id} chat/completions failed with HTTP ${res.status}`,
          res.status,
          errBody,
        );
      }

      const json = (await res.json()) as OpenAiChatResponse;
      const text = json.choices?.[0]?.message?.content ?? '';
      const usage: TokenUsage = {
        inputTokens: json.usage?.prompt_tokens ?? 0,
        outputTokens: json.usage?.completion_tokens ?? 0,
        thinkingTokens: json.usage?.completion_tokens_details?.reasoning_tokens ?? 0,
      };
      return { text, usage, raw: json };
    },
  };
}
