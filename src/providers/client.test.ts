/**
 * createClient — dispatches on resolved.spec.api to the right transport (DESIGN.md #2).
 */
import { describe, it, expect } from 'vitest';
import { MockAgent, getGlobalDispatcher } from 'undici';
import { createClient } from './client.js';
import type { ProviderApi, ResolvedProvider } from './types.js';

const agent = () => getGlobalDispatcher() as MockAgent;

const resolvedWith = (api: ProviderApi, origin: string): ResolvedProvider => ({
  spec: {
    id: api === 'gemini' ? 'gemini' : 'openrouter',
    displayName: 'x',
    api,
    envKeys: ['K'],
    baseUrl: origin,
    defaultModel: 'm',
    models: [],
    keyHint: '',
  },
  apiKey: 'key',
  baseUrl: origin,
  keySource: 'env',
});

describe('createClient', () => {
  it('dispatches api=gemini to the generateContent transport', async () => {
    const origin = 'https://client-gemini.test';
    agent()
      .get(origin)
      .intercept({ path: '/v1beta/models/m:generateContent', method: 'POST' })
      .reply(200, { candidates: [{ content: { parts: [{ text: 'G' }] } }], usageMetadata: {} });

    const res = await createClient(resolvedWith('gemini', origin)).complete({
      model: 'm',
      system: 's',
      user: 'u',
      images: [],
    });
    expect(res.text).toBe('G');
  });

  it('dispatches api=openai-chat to the chat/completions transport', async () => {
    const origin = 'https://client-openai.test';
    agent()
      .get(origin)
      .intercept({ path: '/chat/completions', method: 'POST' })
      .reply(200, { choices: [{ message: { content: 'O' } }], usage: {} });

    const res = await createClient(resolvedWith('openai-chat', origin)).complete({
      model: 'm',
      system: 's',
      user: 'u',
      images: [],
    });
    expect(res.text).toBe('O');
  });

  it('throws on an unknown provider api', () => {
    const bad = resolvedWith('gemini', 'https://x.test');
    (bad.spec as { api: string }).api = 'bogus';
    expect(() => createClient(bad)).toThrow(/bogus/);
  });
});
