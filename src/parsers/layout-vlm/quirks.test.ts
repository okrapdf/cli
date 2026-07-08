/**
 * Golden tests for the model-family quirk table (bboxOrderFor) and the canonical
 * label map (DESIGN.md #3 TDD map). bbox order is a fact about the MODEL, so
 * gemini-through-openrouter (namespaced id) still resolves to y-first.
 */
import { describe, it, expect } from 'vitest';
import { bboxOrderFor } from './quirks.js';
import { canonicalLabel } from './prompts.js';

describe('bboxOrderFor', () => {
  it('resolves native gemini ids to yxyx (y-first)', () => {
    expect(bboxOrderFor('gemini-3-flash')).toBe('yxyx');
    expect(bboxOrderFor('gemini-2.5-flash')).toBe('yxyx');
  });

  it('resolves a provider-namespaced gemini id to yxyx via the bare-name check', () => {
    expect(bboxOrderFor('google/gemini-3-flash-preview')).toBe('yxyx');
  });

  it('resolves qwen (and other non-gemini) ids to xyxy (x-first)', () => {
    expect(bboxOrderFor('qwen/qwen3-vl-235b-a22b-instruct')).toBe('xyxy');
    expect(bboxOrderFor('nvidia/some-vlm')).toBe('xyxy');
  });

  it('defaults an unknown/empty id to xyxy', () => {
    expect(bboxOrderFor('unknown-model')).toBe('xyxy');
    expect(bboxOrderFor('')).toBe('xyxy');
  });
});

describe('canonicalLabel', () => {
  it('normalizes lowercase category names to the canonical casing', () => {
    expect(canonicalLabel('title')).toBe('Title');
    expect(canonicalLabel('text')).toBe('Text');
    expect(canonicalLabel('table')).toBe('Table');
    expect(canonicalLabel('caption')).toBe('Caption');
  });

  it('is case-insensitive on already-canonical input', () => {
    expect(canonicalLabel('Title')).toBe('Title');
    expect(canonicalLabel('Section-header')).toBe('Section-header');
  });

  it('accepts both hyphen and underscore separator variants', () => {
    expect(canonicalLabel('section_header')).toBe('Section-header');
    expect(canonicalLabel('section-header')).toBe('Section-header');
    expect(canonicalLabel('list_item')).toBe('List-item');
    expect(canonicalLabel('list-item')).toBe('List-item');
    expect(canonicalLabel('page_footer')).toBe('Page-footer');
    expect(canonicalLabel('page-header')).toBe('Page-header');
  });

  it('maps the figure alias to Picture', () => {
    expect(canonicalLabel('figure')).toBe('Picture');
    expect(canonicalLabel('picture')).toBe('Picture');
  });

  it('passes an unknown label through unchanged', () => {
    expect(canonicalLabel('Weird-Category')).toBe('Weird-Category');
    expect(canonicalLabel('custom_thing')).toBe('custom_thing');
  });
});
