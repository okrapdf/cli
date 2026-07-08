/**
 * Tests for processor plugin system
 */

import { describe, it, expect } from 'vitest';
import {
  resolveProcessor,
  getProcessor,
  listProcessors,
  BUILTIN_PROCESSORS,
  PROCESSOR_ALIASES,
} from './processors.js';

describe('processors', () => {
  describe('BUILTIN_PROCESSORS', () => {
    it('should have expected processors', () => {
      expect(BUILTIN_PROCESSORS).toHaveProperty('docai');
      expect(BUILTIN_PROCESSORS).toHaveProperty('qwen');
      expect(BUILTIN_PROCESSORS).toHaveProperty('llamaparse');
      expect(BUILTIN_PROCESSORS).toHaveProperty('gemini');
      expect(BUILTIN_PROCESSORS).toHaveProperty('pdfplumber');
      expect(BUILTIN_PROCESSORS).toHaveProperty('default');
    });

    it('should have required fields for each processor', () => {
      for (const [id, proc] of Object.entries(BUILTIN_PROCESSORS)) {
        expect(proc.id).toBe(id);
        expect(proc.name).toBeTruthy();
        expect(proc.description).toBeTruthy();
        expect(proc.apiEndpoint).toBeTruthy();
      }
    });
  });

  describe('resolveProcessor', () => {
    it('should return processor ID as-is if not an alias', () => {
      expect(resolveProcessor('docai')).toBe('docai');
      expect(resolveProcessor('gemini')).toBe('gemini');
    });

    it('should resolve aliases to processor IDs', () => {
      expect(resolveProcessor('google')).toBe('docai');
      expect(resolveProcessor('gcp')).toBe('docai');
      expect(resolveProcessor('llama')).toBe('llamaparse');
      expect(resolveProcessor('lp')).toBe('llamaparse');
      expect(resolveProcessor('auto')).toBe('default');
    });

    it('should be case-insensitive', () => {
      expect(resolveProcessor('DOCAI')).toBe('docai');
      expect(resolveProcessor('Google')).toBe('docai');
    });

    it('should return unknown processor as-is', () => {
      expect(resolveProcessor('unknown')).toBe('unknown');
    });
  });

  describe('getProcessor', () => {
    it('should return processor info for valid ID', () => {
      const proc = getProcessor('docai');
      expect(proc).toBeDefined();
      expect(proc?.id).toBe('docai');
      expect(proc?.name).toBe('Google Document AI');
    });

    it('should resolve aliases', () => {
      const proc = getProcessor('google');
      expect(proc).toBeDefined();
      expect(proc?.id).toBe('docai');
    });

    it('should return undefined for unknown processor', () => {
      expect(getProcessor('nonexistent')).toBeUndefined();
    });
  });

  describe('listProcessors', () => {
    it('should return all processors', () => {
      const processors = listProcessors();
      expect(processors.length).toBe(Object.keys(BUILTIN_PROCESSORS).length);
    });

    it('should return processors with required fields', () => {
      const processors = listProcessors();
      for (const proc of processors) {
        expect(proc.id).toBeTruthy();
        expect(proc.name).toBeTruthy();
        expect(proc.description).toBeTruthy();
      }
    });
  });

  describe('PROCESSOR_ALIASES', () => {
    it('should map to valid processors', () => {
      for (const [alias, target] of Object.entries(PROCESSOR_ALIASES)) {
        expect(BUILTIN_PROCESSORS[target]).toBeDefined();
      }
    });
  });
});
