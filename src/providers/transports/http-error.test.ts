/**
 * Body-snippet helper (#15): non-2xx transport errors carry a trimmed, single-line
 * snippet of the provider response body in the VlmHttpError message, so the CLI can
 * surface the provider's own explanation (e.g. Gemini's "API key not valid").
 */
import { describe, it, expect } from 'vitest';
import { bodySnippet, vlmHttpError } from './http-error.js';
import { VlmHttpError } from '../../core/vlm.js';

describe('bodySnippet', () => {
  it('returns an empty string for undefined/empty/whitespace bodies', () => {
    expect(bodySnippet(undefined)).toBe('');
    expect(bodySnippet('')).toBe('');
    expect(bodySnippet('   \n\t  ')).toBe('');
  });

  it('collapses internal whitespace/newlines to a single line', () => {
    expect(bodySnippet('API key not valid.\n  Please pass a valid API key.')).toBe(
      'API key not valid. Please pass a valid API key.',
    );
  });

  it('truncates to <=200 chars with an ellipsis', () => {
    const long = 'x'.repeat(500);
    const out = bodySnippet(long);
    expect(out.length).toBe(200);
    expect(out.endsWith('…')).toBe(true);
  });

  it('leaves a short body intact (no ellipsis)', () => {
    expect(bodySnippet('bad request')).toBe('bad request');
  });
});

describe('vlmHttpError', () => {
  it('appends the snippet to the message when a body is present', () => {
    const err = vlmHttpError('nvidia chat/completions failed with HTTP 400', 400, 'API key not valid');
    expect(err).toBeInstanceOf(VlmHttpError);
    expect(err.status).toBe(400);
    expect(err.body).toBe('API key not valid');
    expect(err.message).toBe('nvidia chat/completions failed with HTTP 400: API key not valid');
  });

  it('leaves the base message alone when the body is empty', () => {
    const err = vlmHttpError('gemini generateContent failed with HTTP 500', 500, '');
    expect(err.message).toBe('gemini generateContent failed with HTTP 500');
  });
});
