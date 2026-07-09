/**
 * API Client for OkraPDF with retry logic and error handling
 */

import got, { type Got, type Options, type Response } from 'got';
import { getApiKey, getBaseUrl } from './okra-config.js';
import type { ApiResponse, ApiError } from '../../types.js';

// Exit codes
export const EXIT_CODES = {
  SUCCESS: 0,
  GENERAL_ERROR: 1,
  INVALID_ARGS: 2,
  AUTH_ERROR: 3,
  NOT_FOUND: 4,
  RATE_LIMITED: 5,
  JOB_FAILED: 6,
} as const;

// Custom error class
export class OkraApiError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly statusCode?: number,
    public readonly details?: Record<string, unknown>
  ) {
    super(message);
    this.name = 'OkraApiError';
  }

  get exitCode(): number {
    if (this.statusCode === 401 || this.statusCode === 403) {
      return EXIT_CODES.AUTH_ERROR;
    }
    if (this.statusCode === 404) {
      return EXIT_CODES.NOT_FOUND;
    }
    if (this.statusCode === 429) {
      return EXIT_CODES.RATE_LIMITED;
    }
    return EXIT_CODES.GENERAL_ERROR;
  }
}

/**
 * Check if user is authenticated
 */
export function isAuthenticated(): boolean {
  return !!getApiKey();
}

/**
 * Create an anonymous API client (no auth, for rate-limited public endpoints)
 */
export function createAnonymousClient(): Got {
  const baseUrl = getBaseUrl();

  return got.extend({
    prefixUrl: baseUrl,
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': 'okrapdf-cli/0.2.0',
    },
    retry: {
      limit: 2,
      methods: ['GET', 'POST'],
      statusCodes: [408, 500, 502, 503, 504],
      backoffLimit: 5000,
    },
    timeout: {
      request: 300000, // 5 minutes for extraction
    },
  });
}

/**
 * Create an API client instance
 */
export function createClient(): Got {
  const apiKey = getApiKey();
  const baseUrl = getBaseUrl();

  if (!apiKey) {
    throw new OkraApiError(
      'auth_required',
      'Not authenticated. Run `okra cloud login` first.',
      401
    );
  }

  return got.extend({
    prefixUrl: baseUrl,
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      'User-Agent': 'okrapdf-cli/0.2.0',
    },
    retry: {
      limit: 3,
      methods: ['GET', 'POST', 'PUT', 'DELETE'],
      statusCodes: [408, 429, 500, 502, 503, 504],
      backoffLimit: 8000,
    },
    timeout: {
      request: 60000, // 60 seconds
    },
    hooks: {
      beforeRetry: [
        (error, retryCount) => {
          console.error(`Request failed, retrying (${retryCount}/3)...`);
        },
      ],
    },
  });
}

/**
 * Make an authenticated API request
 */
export async function apiRequest<T>(
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  endpoint: string,
  options: Partial<Options> = {}
): Promise<T> {
  const client = createClient();

  try {
    const response = await client(endpoint, {
      method,
      ...options,
      responseType: 'json',
      isStream: false,
    } as const);

    const body = response.body as ApiResponse<T> | T;

    // Check if it's a wrapped response with success/error
    if (body && typeof body === 'object' && 'success' in body) {
      const wrapped = body as ApiResponse<T>;
      if (!wrapped.success && wrapped.error) {
        throw new OkraApiError(
          wrapped.error.code,
          wrapped.error.message,
          response.statusCode,
          wrapped.error.details
        );
      }
      // Return unwrapped data
      if (wrapped.data !== undefined) {
        return wrapped.data;
      }
    }

    return body as T;
  } catch (error: unknown) {
    if (error instanceof OkraApiError) {
      throw error;
    }

    // Handle got errors
    if (error && typeof error === 'object' && 'response' in error) {
      const gotError = error as { response?: Response<unknown>; message?: string };
      const statusCode = gotError.response?.statusCode;
      const body = gotError.response?.body as ApiResponse<unknown> | undefined;

      if (body?.error) {
        throw new OkraApiError(
          body.error.code,
          body.error.message,
          statusCode,
          body.error.details
        );
      }

      throw new OkraApiError(
        'request_failed',
        gotError.message || 'Request failed',
        statusCode
      );
    }

    throw new OkraApiError(
      'unknown_error',
      error instanceof Error ? error.message : 'Unknown error occurred'
    );
  }
}

/**
 * GET request helper
 */
export async function get<T>(endpoint: string, searchParams?: Record<string, string | number | boolean>): Promise<T> {
  return apiRequest<T>('GET', endpoint, { searchParams });
}

/**
 * POST request helper
 */
export async function post<T>(endpoint: string, json?: unknown): Promise<T> {
  return apiRequest<T>('POST', endpoint, { json });
}

/**
 * PUT request helper
 */
export async function put<T>(endpoint: string, json?: unknown): Promise<T> {
  return apiRequest<T>('PUT', endpoint, { json });
}

/**
 * DELETE request helper
 */
export async function del<T>(endpoint: string): Promise<T> {
  return apiRequest<T>('DELETE', endpoint);
}

/**
 * PATCH request helper
 */
export async function patch<T>(endpoint: string, json?: unknown): Promise<T> {
  return apiRequest<T>('PATCH' as any, endpoint, { json });
}

/**
 * Upload a file to a signed URL
 */
export async function uploadFile(signedUrl: string, filePath: string, contentType: string): Promise<void> {
  const fs = await import('fs');
  const fileStream = fs.createReadStream(filePath);
  const stats = fs.statSync(filePath);

  await got.put(signedUrl, {
    body: fileStream,
    headers: {
      'Content-Type': contentType,
      'Content-Length': stats.size.toString(),
    },
    retry: {
      limit: 3,
    },
  });
}

/**
 * Download a file from a URL
 */
export async function downloadFile(url: string, outputPath: string): Promise<void> {
  const fs = await import('fs');
  const { pipeline } = await import('stream/promises');

  const downloadStream = got.stream(url);
  const writeStream = fs.createWriteStream(outputPath);

  await pipeline(downloadStream, writeStream);
}

/**
 * Download binary from an authenticated API endpoint
 */
export async function downloadFromApi(endpoint: string, outputPath: string): Promise<void> {
  const client = createClient();
  const fs = await import('fs');
  const { pipeline } = await import('stream/promises');

  const downloadStream = client.stream(endpoint);
  const writeStream = fs.createWriteStream(outputPath);

  await pipeline(downloadStream, writeStream);
}
