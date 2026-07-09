/**
 * gemini transport — request-shape golden (native generateContent body: inlineData
 * images before the text part, x-goog-api-key header), response + usageMetadata
 * mapping, and non-2xx -> VlmHttpError (DESIGN.md #2).
 */
import { describe, it, expect } from 'vitest';
import { MockAgent, getGlobalDispatcher } from 'undici';
import { createGeminiClient } from './gemini.js';
import { VlmHttpError } from '../../core/vlm.js';
import type { VlmRequest } from '../../core/vlm.js';
import type { ResolvedProvider } from '../types.js';

const ORIGIN = 'https://fake-gemini.test';

const resolved: ResolvedProvider = {
  spec: {
    id: 'gemini',
    displayName: 'Google Gemini (test)',
    api: 'gemini',
    envKeys: ['GEMINI_API_KEY', 'GOOGLE_API_KEY'],
    baseUrl: ORIGIN,
    defaultModel: 'gemini-3-flash',
    models: [],
    keyHint: '',
  },
  apiKey: 'gk-test-123',
  baseUrl: ORIGIN,
  keySource: 'env',
};

const agent = () => getGlobalDispatcher() as MockAgent;
const png = (bytes: number[]): Uint8Array => Uint8Array.from(bytes);
const b64 = (bytes: number[]): string => Buffer.from(Uint8Array.from(bytes)).toString('base64');
const pathFor = (model: string) => `/v1beta/models/${model}:generateContent`;

interface Captured {
  body?: string;
  headers?: Record<string, string>;
}

/** Supertype of undici's MockResponseCallbackOptions (body/headers are broadly typed). */
type ReplyOpts = { body?: unknown; headers?: unknown };
const takeBody = (o: ReplyOpts): string => o.body as string;
const takeHeaders = (o: ReplyOpts): Record<string, string> => o.headers as Record<string, string>;

describe('createGeminiClient', () => {
  it('POSTs generateContent with inlineData images before text and x-goog-api-key', async () => {
    const captured: Captured = {};
    agent()
      .get(ORIGIN)
      .intercept({ path: pathFor('gemini-3-flash'), method: 'POST' })
      .reply(200, (opts: ReplyOpts) => {
        captured.body = takeBody(opts);
        captured.headers = takeHeaders(opts);
        return {
          candidates: [{ content: { parts: [{ text: 'grounded answer' }] } }],
          usageMetadata: { promptTokenCount: 30, candidatesTokenCount: 12 },
        };
      });

    const req: VlmRequest = {
      model: 'gemini-3-flash',
      system: 'SYS',
      user: 'USR',
      images: [{ png: png([1, 2, 3]), width: 100, height: 200 }],
      maxOutputTokens: 8192,
      temperature: 0,
    };
    const res = await createGeminiClient(resolved).complete(req);

    expect(JSON.parse(captured.body!)).toEqual({
      systemInstruction: { parts: [{ text: 'SYS' }] },
      contents: [
        {
          role: 'user',
          parts: [
            { inlineData: { mimeType: 'image/png', data: b64([1, 2, 3]) } },
            { text: 'USR' },
          ],
        },
      ],
      generationConfig: { temperature: 0, maxOutputTokens: 8192 },
    });
    expect(captured.headers?.['x-goog-api-key']).toBe('gk-test-123');

    expect(res.text).toBe('grounded answer');
    expect(res.usage).toEqual({ inputTokens: 30, outputTokens: 12, thinkingTokens: 0 });
  });

  it('joins multiple text parts and maps thoughtsTokenCount into thinkingTokens', async () => {
    agent()
      .get(ORIGIN)
      .intercept({ path: pathFor('gemini-3.1-pro'), method: 'POST' })
      .reply(200, {
        candidates: [{ content: { parts: [{ text: 'foo' }, { text: 'bar' }] } }],
        usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 9, thoughtsTokenCount: 4 },
      });

    const res = await createGeminiClient(resolved).complete({
      model: 'gemini-3.1-pro',
      system: 's',
      user: 'u',
      images: [],
    });
    expect(res.text).toBe('foobar');
    expect(res.usage).toEqual({ inputTokens: 5, outputTokens: 9, thinkingTokens: 4 });
  });

  it('emits one inlineData part per image, in order, before the text part', async () => {
    const captured: Captured = {};
    agent()
      .get(ORIGIN)
      .intercept({ path: pathFor('gemini-3-flash'), method: 'POST' })
      .reply(200, (opts: ReplyOpts) => {
        captured.body = takeBody(opts);
        return { candidates: [{ content: { parts: [{ text: '' }] } }], usageMetadata: {} };
      });

    await createGeminiClient(resolved).complete({
      model: 'gemini-3-flash',
      system: 's',
      user: 'u',
      images: [
        { png: png([7]), width: 1, height: 1 },
        { png: png([6]), width: 1, height: 1 },
      ],
    });

    const parts = JSON.parse(captured.body!).contents[0].parts as Array<{
      inlineData?: { data: string };
      text?: string;
    }>;
    expect(parts[0].inlineData!.data).toBe(b64([7]));
    expect(parts[1].inlineData!.data).toBe(b64([6]));
    expect(parts[2].text).toBe('u');
  });

  it('throws VlmHttpError with status + body on non-2xx', async () => {
    agent()
      .get(ORIGIN)
      .intercept({ path: pathFor('gemini-3-flash'), method: 'POST' })
      .reply(503, 'overloaded');
    const err = await createGeminiClient(resolved)
      .complete({ model: 'gemini-3-flash', system: 's', user: 'u', images: [] })
      .catch((e) => e);
    expect(err).toBeInstanceOf(VlmHttpError);
    expect(err.status).toBe(503);
    expect(err.body).toContain('overloaded');
  });

  it('folds a trimmed body snippet into the VlmHttpError message on 400 (#15)', async () => {
    agent()
      .get(ORIGIN)
      .intercept({ path: pathFor('gemini-3-flash'), method: 'POST' })
      .reply(400, '{ "error": { "message": "API key not valid. Please pass a valid API key." } }');
    const err = await createGeminiClient(resolved)
      .complete({ model: 'gemini-3-flash', system: 's', user: 'u', images: [] })
      .catch((e) => e);
    expect(err).toBeInstanceOf(VlmHttpError);
    expect(err.status).toBe(400);
    expect(err.message).toContain('API key not valid');
  });
});
