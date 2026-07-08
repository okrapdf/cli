/**
 * gemini transport — Google's native `generateContent` REST dialect. Implements core
 * `VlmClient` over the GLOBAL `fetch` only (no SDK), keeping the no-cloud guard airtight.
 *
 * providers/** may import core/** only (dependency rule 2).
 */

import type { VlmClient, VlmRequest, VlmResponse } from '../../core/vlm.js';
import { VlmHttpError } from '../../core/vlm.js';
import type { TokenUsage } from '../../core/blocks.js';
import type { ResolvedProvider } from '../types.js';

const DEFAULT_MAX_TOKENS = 4096;
const DEFAULT_TEMPERATURE = 0;

interface GeminiResponse {
  candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    thoughtsTokenCount?: number;
  };
}

export function createGeminiClient(resolved: ResolvedProvider): VlmClient {
  const base = resolved.baseUrl.replace(/\/+$/, '');

  return {
    async complete(req: VlmRequest, signal?: AbortSignal): Promise<VlmResponse> {
      const url = `${base}/v1beta/models/${req.model}:generateContent`;
      const body = {
        systemInstruction: { parts: [{ text: req.system }] },
        contents: [
          {
            role: 'user',
            parts: [
              // images first, then the text prompt (native generateContent order)
              ...req.images.map((img) => ({
                inlineData: { mimeType: 'image/png', data: Buffer.from(img.png).toString('base64') },
              })),
              { text: req.user },
            ],
          },
        ],
        generationConfig: {
          temperature: req.temperature ?? DEFAULT_TEMPERATURE,
          maxOutputTokens: req.maxOutputTokens ?? DEFAULT_MAX_TOKENS,
        },
      };

      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-goog-api-key': resolved.apiKey,
        },
        body: JSON.stringify(body),
        signal,
      });

      if (!res.ok) {
        const errBody = await res.text().catch(() => '');
        throw new VlmHttpError(
          `${resolved.spec.id} generateContent failed with HTTP ${res.status}`,
          res.status,
          errBody,
        );
      }

      const json = (await res.json()) as GeminiResponse;
      const text = (json.candidates?.[0]?.content?.parts ?? [])
        .map((p) => p.text ?? '')
        .join('');
      const usage: TokenUsage = {
        inputTokens: json.usageMetadata?.promptTokenCount ?? 0,
        outputTokens: json.usageMetadata?.candidatesTokenCount ?? 0,
        thinkingTokens: json.usageMetadata?.thoughtsTokenCount ?? 0,
      };
      return { text, usage, raw: json };
    },
  };
}
