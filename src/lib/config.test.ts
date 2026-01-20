/**
 * Tests for configuration management
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

  describe('getApiKey', () => {
    it('should return OKRA_API_KEY from environment', async () => {
      process.env.OKRA_API_KEY = 'okra_test_key';

      const { getApiKey } = await import('./config.js');
      expect(getApiKey()).toBe('okra_test_key');
    });

    it('should prioritize environment over config', async () => {
      process.env.OKRA_API_KEY = 'okra_env_key';

      const { getApiKey, setApiKey } = await import('./config.js');
      setApiKey('okra_config_key');

      // Env should take priority
      expect(getApiKey()).toBe('okra_env_key');
    });
  });

  describe('getBaseUrl', () => {
    it('should return default URL when not configured', async () => {
      delete process.env.OKRA_BASE_URL;

      const { getBaseUrl } = await import('./config.js');
      expect(getBaseUrl()).toBe('https://okrapdf.com');
    });

    it('should return OKRA_BASE_URL from environment', async () => {
      process.env.OKRA_BASE_URL = 'https://custom.example.com';

      const { getBaseUrl } = await import('./config.js');
      expect(getBaseUrl()).toBe('https://custom.example.com');
    });
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

  describe('isAuthenticated', () => {
    it('should return false when no API key', async () => {
      delete process.env.OKRA_API_KEY;

      const { isAuthenticated, clearApiKey } = await import('./config.js');
      clearApiKey();

      expect(isAuthenticated()).toBe(false);
    });

    it('should return true when API key is set', async () => {
      process.env.OKRA_API_KEY = 'okra_test';

      const { isAuthenticated } = await import('./config.js');
      expect(isAuthenticated()).toBe(true);
    });
  });

  describe('getConfig', () => {
    it('should return full config object', async () => {
      process.env.OKRA_API_KEY = 'okra_test';
      process.env.OKRA_BASE_URL = 'https://test.com';
      process.env.OKRA_OUTPUT_FORMAT = 'json';

      const { getConfig } = await import('./config.js');
      const config = getConfig();

      expect(config).toEqual({
        api_key: 'okra_test',
        base_url: 'https://test.com',
        default_format: 'json',
      });
    });
  });
});
