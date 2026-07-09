/**
 * docling-serve transport (SPIKE). Asserts the EXACT POST body to /v1/convert/source
 * (base64 PDF + options), success decoding, and every failure mode: non-'success'
 * status, non-2xx → VlmHttpError (the engine's retry currency), missing base URL, and a
 * success envelope with no json_content. All network is trapped by the global MockAgent
 * (test/net-guard.ts) — the docling host is covered by intercepts only, never live.
 */
import { describe, it, expect } from 'vitest';
import { MockAgent, getGlobalDispatcher } from 'undici';
import { doclingServeParser } from './index.js';
import { VlmHttpError } from '../../core/vlm.js';
import type { ParserContext } from '../types.js';
import type { DoclingDocument } from './decode.js';

const ORIGIN = 'https://fake-docling.test';
const PATH = '/v1/convert/source';
const agent = (): MockAgent => getGlobalDispatcher() as MockAgent;

function ctx(baseUrl: string | undefined, extra: Record<string, unknown> = {}): ParserContext {
  return { httpBaseUrl: baseUrl, settings: { ...doclingServeParser.spec.defaults, ...extra } };
}

/** A minimal one-text, one-page DoclingDocument for the success path. */
const MINI_DOC: DoclingDocument = {
  body: { children: [{ $ref: '#/texts/0' }] },
  texts: [
    {
      label: 'text',
      text: 'hello docling',
      prov: [{ page_no: 1, bbox: { l: 0, t: 100, r: 100, b: 0, coord_origin: 'BOTTOMLEFT' } }],
    },
  ],
  pages: { '1': { size: { width: 100, height: 100 } } },
};

type ReplyOpts = { body?: unknown; headers?: unknown };
const takeBody = (o: ReplyOpts): string => o.body as string;
const takeHeaders = (o: ReplyOpts): Record<string, string> => o.headers as Record<string, string>;

describe('doclingServeParser.parseDocument — transport', () => {
  it('POSTs the exact /v1/convert/source body (base64 PDF + to_formats:json) and decodes success', async () => {
    const captured: { body?: string; headers?: Record<string, string> } = {};
    agent()
      .get(ORIGIN)
      .intercept({ path: PATH, method: 'POST' })
      .reply(200, (opts: ReplyOpts) => {
        captured.body = takeBody(opts);
        captured.headers = takeHeaders(opts);
        return { status: 'success', processing_time: 0.4, errors: [], document: { json_content: MINI_DOC } };
      });

    const pdf = Uint8Array.from([1, 2, 3, 4]);
    const pages = await doclingServeParser.parseDocument!(pdf, ctx(ORIGIN));

    expect(JSON.parse(captured.body!)).toEqual({
      options: { to_formats: ['json'] },
      file_sources: [{ base64_string: Buffer.from(pdf).toString('base64'), filename: 'doc.pdf' }],
    });
    expect(captured.headers?.['content-type']).toContain('application/json');

    expect(pages).toHaveLength(1);
    expect(pages[0]).toMatchObject({ page: 1, markdown: 'hello docling' });
    expect(pages[0].blocks[0]).toMatchObject({ label: 'Text', text: 'hello docling' });
  });

  it('strips a trailing slash from the base URL before appending the path', async () => {
    let hit = false;
    agent()
      .get(ORIGIN)
      .intercept({ path: PATH, method: 'POST' })
      .reply(200, () => {
        hit = true;
        return { status: 'success', document: { json_content: MINI_DOC } };
      });
    await doclingServeParser.parseDocument!(Uint8Array.from([9]), ctx(`${ORIGIN}/`));
    expect(hit).toBe(true);
  });

  it('throws a plain Error (not VlmHttpError) on a non-"success" status, with the errors snippet', async () => {
    agent()
      .get(ORIGIN)
      .intercept({ path: PATH, method: 'POST' })
      .reply(200, { status: 'failure', errors: ['unsupported file'], document: {} });
    const err = await doclingServeParser.parseDocument!(Uint8Array.from([1]), ctx(ORIGIN)).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(VlmHttpError);
    expect(err.message).toContain('failure');
    expect(err.message).toContain('unsupported file');
  });

  it('throws VlmHttpError carrying the status + body on a non-2xx (500)', async () => {
    agent().get(ORIGIN).intercept({ path: PATH, method: 'POST' }).reply(500, 'upstream boom');
    const err = await doclingServeParser.parseDocument!(Uint8Array.from([1]), ctx(ORIGIN)).catch((e) => e);
    expect(err).toBeInstanceOf(VlmHttpError);
    expect(err.status).toBe(500);
    expect(err.body).toContain('upstream boom');
  });

  it('folds a body snippet into the VlmHttpError message on 400', async () => {
    agent()
      .get(ORIGIN)
      .intercept({ path: PATH, method: 'POST' })
      .reply(400, 'Invalid file_sources payload');
    const err = await doclingServeParser.parseDocument!(Uint8Array.from([1]), ctx(ORIGIN)).catch((e) => e);
    expect(err).toBeInstanceOf(VlmHttpError);
    expect(err.status).toBe(400);
    expect(err.message).toContain('Invalid file_sources payload');
  });

  it('throws a clear programmer-error when no base URL is injected', async () => {
    await expect(doclingServeParser.parseDocument!(Uint8Array.from([1]), ctx(undefined))).rejects.toThrow(
      /base URL/i,
    );
  });

  it('throws when status is "success" but the response has no json_content', async () => {
    agent()
      .get(ORIGIN)
      .intercept({ path: PATH, method: 'POST' })
      .reply(200, { status: 'success', document: {} });
    await expect(doclingServeParser.parseDocument!(Uint8Array.from([1]), ctx(ORIGIN))).rejects.toThrow(
      /json_content/,
    );
  });
});
