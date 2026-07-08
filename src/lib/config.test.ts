/**
 * Tests for shared, cloud-agnostic configuration (default output format).
 * The okra-cloud credential helpers (getApiKey / getBaseUrl / isAuthenticated /
 * getConfig) live in cloud/lib/okra-config.ts and are tested in okra-config.test.ts.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Mock environment variables
const originalEnv = process.env;

describe('config', () => {
  beforeEach(() => {
    vi.resetModules();
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe('getDefaultFormat', () => {
    it('should return table as default', async () => {
      delete process.env.OKRA_OUTPUT_FORMAT;

      const { getDefaultFormat } = await import('./config.js');
      expect(getDefaultFormat()).toBe('table');
    });

    it('should return OKRA_OUTPUT_FORMAT from environment', async () => {
      process.env.OKRA_OUTPUT_FORMAT = 'json';

      const { getDefaultFormat } = await import('./config.js');
      expect(getDefaultFormat()).toBe('json');
    });
  });
});
