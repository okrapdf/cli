/**
 * openai-chat transport — request-shape golden (exact body incl. data-URI images +
 * Bearer auth), response + usage mapping, and non-2xx -> VlmHttpError (DESIGN.md #2).
 * All network is trapped by the global MockAgent (test/net-guard.ts).
 */
import { describe, it, expect } from 'vitest';
import { MockAgent, getGlobalDispatcher } from 'undici';
import { createOpenAiChatClient } from './openai-chat.js';
import { VlmHttpError } from '../../core/vlm.js';
import type { VlmRequest } from '../../core/vlm.js';
import type { ResolvedProvider } from '../types.js';

const ORIGIN = 'https://fake-openai.test';
const BASE = `${ORIGIN}/v1`;
const PATH = '/v1/chat/completions';

const resolved: ResolvedProvider = {
  spec: {
    id: 'openrouter',
    displayName: 'OpenRouter (test)',
    api: 'openai-chat',
    envKeys: ['OPENROUTER_API_KEY'],
    baseUrl: BASE,
    defaultModel: 'm',
    models: [],
    keyHint: '',
  },
  apiKey: 'sk-test-123',
  baseUrl: BASE,
  keySource: 'env',
};

const agent = () => getGlobalDispatcher() as MockAgent;
const png = (bytes: number[]): Uint8Array => Uint8Array.from(bytes);
const b64 = (bytes: number[]): string => Buffer.from(Uint8Array.from(bytes)).toString('base64');

interface Captured {
  body?: string;
  headers?: Record<string, string>;
}

/** Supertype of undici's MockResponseCallbackOptions (body/headers are broadly typed). */
type ReplyOpts = { body?: unknown; headers?: unknown };
const takeBody = (o: ReplyOpts): string => o.body as string;
const takeHeaders = (o: ReplyOpts): Record<string, string> => o.headers as Record<string, string>;

describe('createOpenAiChatClient', () => {
  it('POSTs the exact /chat/completions body with data-URI images and Bearer auth', async () => {
    const captured: Captured = {};
    agent()
      .get(ORIGIN)
      .intercept({ path: PATH, method: 'POST' })
      .reply(200, (opts: ReplyOpts) => {
        captured.body = takeBody(opts);
        captured.headers = takeHeaders(opts);
        return {
          choices: [{ message: { content: 'hello twin' } }],
          usage: { prompt_tokens: 11, completion_tokens: 22 },
        };
      });

    const req: VlmRequest = {
      model: 'qwen/qwen3-vl-235b-a22b-instruct',
      system: 'SYSTEM PROMPT',
      user: 'USER PROMPT',
      images: [{ png: png([1, 2, 3, 4]), width: 100, height: 200 }],
      maxOutputTokens: 4096,
      temperature: 0,
    };
    const res = await createOpenAiChatClient(resolved).complete(req);

    expect(JSON.parse(captured.body!)).toEqual({
      model: 'qwen/qwen3-vl-235b-a22b-instruct',
      temperature: 0,
      max_tokens: 4096,
      messages: [
        { role: 'system', content: 'SYSTEM PROMPT' },
        {
          role: 'user',
          content: [
            { type: 'text', text: 'USER PROMPT' },
            { type: 'image_url', image_url: { url: `data:image/png;base64,${b64([1, 2, 3, 4])}` } },
          ],
        },
      ],
    });
    expect(captured.headers?.authorization).toBe('Bearer sk-test-123');

    expect(res.text).toBe('hello twin');
    expect(res.usage).toEqual({ inputTokens: 11, outputTokens: 22, thinkingTokens: 0 });
  });

  it('maps completion_tokens_details.reasoning_tokens into thinkingTokens', async () => {
    agent()
      .get(ORIGIN)
      .intercept({ path: PATH, method: 'POST' })
      .reply(200, {
        choices: [{ message: { content: 'x' } }],
        usage: {
          prompt_tokens: 1,
          completion_tokens: 2,
          completion_tokens_details: { reasoning_tokens: 7 },
        },
      });

    const res = await createOpenAiChatClient(resolved).complete({
      model: 'm',
      system: 's',
      user: 'u',
      images: [],
    });
    expect(res.usage).toEqual({ inputTokens: 1, outputTokens: 2, thinkingTokens: 7 });
  });

  it('emits the text part first, then one image_url part per image, in order', async () => {
    const captured: Captured = {};
    agent()
      .get(ORIGIN)
      .intercept({ path: PATH, method: 'POST' })
      .reply(200, (opts: ReplyOpts) => {
        captured.body = takeBody(opts);
        return { choices: [{ message: { content: '' } }], usage: {} };
      });

    await createOpenAiChatClient(resolved).complete({
      model: 'm',
      system: 's',
      user: 'u',
      images: [
        { png: png([9]), width: 1, height: 1 },
        { png: png([8]), width: 1, height: 1 },
      ],
    });

    const content = JSON.parse(captured.body!).messages[1].content as Array<{
      type: string;
      image_url?: { url: string };
    }>;
    expect(content.map((c) => c.type)).toEqual(['text', 'image_url', 'image_url']);
    expect(content[1].image_url!.url).toBe(`data:image/png;base64,${b64([9])}`);
    expect(content[2].image_url!.url).toBe(`data:image/png;base64,${b64([8])}`);
  });

  it('throws VlmHttpError carrying the status on 429', async () => {
    agent().get(ORIGIN).intercept({ path: PATH, method: 'POST' }).reply(429, 'rate limited');
    await expect(
      createOpenAiChatClient(resolved).complete({ model: 'm', system: 's', user: 'u', images: [] }),
    ).rejects.toMatchObject({ name: 'VlmHttpError', status: 429 });
  });

  it('throws VlmHttpError with status + body on 500', async () => {
    agent().get(ORIGIN).intercept({ path: PATH, method: 'POST' }).reply(500, 'upstream boom');
    const err = await createOpenAiChatClient(resolved)
      .complete({ model: 'm', system: 's', user: 'u', images: [] })
      .catch((e) => e);
    expect(err).toBeInstanceOf(VlmHttpError);
    expect(err.status).toBe(500);
    expect(err.body).toContain('upstream boom');
  });
});
