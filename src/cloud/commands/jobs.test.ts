/**
 * Tests for job commands
 */

import { describe, it, expect } from 'vitest';

// Test the normalizeJob function extracted from jobs.ts
function normalizeJob(job: {
  id?: string;
  job_id?: string;
  status: string;
  file_name?: string | null;
  filename?: string | null;
  total_pages: number | null;
  pages_completed: number | null;
  updated_at?: string;
  created_at?: string;
  error: string | null;
}) {
  return {
    id: job.id || job.job_id || '',
    status: job.status,
    file_name: job.file_name || job.filename || null,
    total_pages: job.total_pages,
    pages_completed: job.pages_completed,
    updated_at: job.updated_at || job.created_at || '',
    error: job.error,
  };
}

describe('jobs', () => {
  describe('normalizeJob', () => {
    it('should normalize job with id field', () => {
      const job = {
        id: 'abc-123',
        status: 'completed',
        file_name: 'test.pdf',
        total_pages: 10,
        pages_completed: 10,
        updated_at: '2024-01-01T00:00:00Z',
        error: null,
      };

      const normalized = normalizeJob(job);

      expect(normalized.id).toBe('abc-123');
      expect(normalized.file_name).toBe('test.pdf');
      expect(normalized.updated_at).toBe('2024-01-01T00:00:00Z');
    });

    it('should normalize job with job_id field', () => {
      const job = {
        job_id: 'xyz-789',
        status: 'running',
        filename: 'report.pdf',
        total_pages: 5,
        pages_completed: 2,
        created_at: '2024-01-02T00:00:00Z',
        error: null,
      };

      const normalized = normalizeJob(job);

      expect(normalized.id).toBe('xyz-789');
      expect(normalized.file_name).toBe('report.pdf');
      expect(normalized.updated_at).toBe('2024-01-02T00:00:00Z');
    });

    it('should prefer id over job_id', () => {
      const job = {
        id: 'primary-id',
        job_id: 'secondary-id',
        status: 'completed',
        total_pages: null,
        pages_completed: null,
        error: null,
      };

      const normalized = normalizeJob(job);
      expect(normalized.id).toBe('primary-id');
    });

    it('should prefer file_name over filename', () => {
      const job = {
        id: 'test',
        status: 'completed',
        file_name: 'primary.pdf',
        filename: 'secondary.pdf',
        total_pages: null,
        pages_completed: null,
        error: null,
      };

      const normalized = normalizeJob(job);
      expect(normalized.file_name).toBe('primary.pdf');
    });

    it('should handle null values', () => {
      const job = {
        id: 'test',
        status: 'failed',
        file_name: null,
        total_pages: null,
        pages_completed: null,
        error: 'Something went wrong',
      };

      const normalized = normalizeJob(job);

      expect(normalized.file_name).toBeNull();
      expect(normalized.total_pages).toBeNull();
      expect(normalized.error).toBe('Something went wrong');
    });

    it('should handle missing optional fields', () => {
      const job = {
        status: 'queued',
        total_pages: null,
        pages_completed: null,
        error: null,
      };

      const normalized = normalizeJob(job);

      expect(normalized.id).toBe('');
      expect(normalized.file_name).toBeNull();
      expect(normalized.updated_at).toBe('');
    });
  });

  describe('job status values', () => {
    it('should handle all valid status values', () => {
      const statuses = ['queued', 'pending', 'running', 'completed', 'failed', 'cancelled'];

      for (const status of statuses) {
        const job = {
          id: 'test',
          status,
          total_pages: null,
          pages_completed: null,
          error: null,
        };

        const normalized = normalizeJob(job);
        expect(normalized.status).toBe(status);
      }
    });
  });

  describe('normalizeJobResults', () => {
    function normalizeJobResults(apiResponse: {
      job_id: string;
      filename: string;
      total_pages: number;
      results: {
        tables: Array<{ id: string; page_number: number; content_markdown: string }>;
        text: Array<{ page: number; content: string }>;
      };
    }) {
      return {
        job_id: apiResponse.job_id,
        filename: apiResponse.filename,
        total_pages: apiResponse.total_pages,
        tables: apiResponse.results?.tables || [],
        pages: (apiResponse.results?.text || []).map(t => ({
          page_number: t.page,
          text: t.content,
          entities: [],
        })),
      };
    }

    it('should transform API response to CLI format', () => {
      const apiResponse = {
        job_id: 'ocr-abc123',
        filename: 'test.pdf',
        total_pages: 2,
        results: {
          tables: [],
          text: [
            { page: 1, content: '# Page 1 content' },
            { page: 2, content: '# Page 2 content' },
          ],
        },
      };

      const normalized = normalizeJobResults(apiResponse);

      expect(normalized.job_id).toBe('ocr-abc123');
      expect(normalized.filename).toBe('test.pdf');
      expect(normalized.total_pages).toBe(2);
      expect(normalized.pages).toHaveLength(2);
      expect(normalized.pages[0].page_number).toBe(1);
      expect(normalized.pages[0].text).toBe('# Page 1 content');
      expect(normalized.tables).toHaveLength(0);
    });

    it('should handle response with tables', () => {
      const apiResponse = {
        job_id: 'ocr-xyz789',
        filename: 'report.pdf',
        total_pages: 1,
        results: {
          tables: [
            { id: 'table-1', page_number: 1, content_markdown: '| A | B |' },
          ],
          text: [{ page: 1, content: 'Report content' }],
        },
      };

      const normalized = normalizeJobResults(apiResponse);

      expect(normalized.tables).toHaveLength(1);
      expect(normalized.tables[0].id).toBe('table-1');
      expect(normalized.tables[0].content_markdown).toBe('| A | B |');
    });

    it('should handle empty results gracefully', () => {
      const apiResponse = {
        job_id: 'ocr-empty',
        filename: 'empty.pdf',
        total_pages: 0,
        results: {
          tables: [],
          text: [],
        },
      };

      const normalized = normalizeJobResults(apiResponse);

      expect(normalized.pages).toHaveLength(0);
      expect(normalized.tables).toHaveLength(0);
    });

    it('should handle missing results field', () => {
      const apiResponse = {
        job_id: 'ocr-missing',
        filename: 'missing.pdf',
        total_pages: 1,
        results: undefined as unknown as { tables: []; text: [] },
      };

      const normalized = normalizeJobResults(apiResponse);

      expect(normalized.pages).toHaveLength(0);
      expect(normalized.tables).toHaveLength(0);
    });
  });
});
