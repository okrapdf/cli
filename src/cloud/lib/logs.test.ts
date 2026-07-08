/**
 * Tests for local logging
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir, homedir } from 'os';

// Store original HOME
const originalHome = process.env.HOME;

describe('logs', () => {
  let testDir: string;

  beforeEach(() => {
    // Create temp directory for tests
    testDir = join(tmpdir(), `okrapdf-test-${Date.now()}`);
    mkdirSync(testDir, { recursive: true });

    // Point HOME to temp dir so config goes there
    process.env.HOME = testDir;

    // Reset module cache
    vi.resetModules();
  });

  afterEach(() => {
    // Restore HOME
    process.env.HOME = originalHome;

    // Clean up temp directory
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  describe('logJob', () => {
    it('should log a job and return entry with id', async () => {
      const { logJob } = await import('./logs.js');

      const entry = logJob({
        job_id: 'test-job-123',
        file_name: 'test.pdf',
        processor: 'docai',
        status: 'running',
        started_at: new Date().toISOString(),
      });

      expect(entry.id).toBeTruthy();
      expect(entry.job_id).toBe('test-job-123');
      expect(entry.file_name).toBe('test.pdf');
      expect(entry.processor).toBe('docai');
      expect(entry.status).toBe('running');
    });

    it('should persist logs', async () => {
      const { logJob, getJobLogs } = await import('./logs.js');

      logJob({
        job_id: 'job-1',
        processor: 'docai',
        status: 'completed',
        started_at: new Date().toISOString(),
      });

      logJob({
        job_id: 'job-2',
        processor: 'gemini',
        status: 'running',
        started_at: new Date().toISOString(),
      });

      const logs = getJobLogs();
      expect(logs.length).toBe(2);
    });
  });

  describe('updateJobLog', () => {
    it('should update existing log entry', async () => {
      const { logJob, updateJobLog, getJobLogs } = await import('./logs.js');

      const entry = logJob({
        job_id: 'update-test',
        processor: 'docai',
        status: 'running',
        started_at: new Date().toISOString(),
      });

      updateJobLog(entry.id, {
        status: 'completed',
        completed_at: new Date().toISOString(),
        duration_ms: 5000,
      });

      const logs = getJobLogs();
      const updated = logs.find(l => l.id === entry.id);

      expect(updated?.status).toBe('completed');
      expect(updated?.duration_ms).toBe(5000);
    });
  });

  describe('getJobLogs', () => {
    it('should return logs in reverse chronological order', async () => {
      const { logJob, getJobLogs } = await import('./logs.js');

      logJob({
        job_id: 'first',
        processor: 'docai',
        status: 'completed',
        started_at: '2024-01-01T00:00:00Z',
      });

      logJob({
        job_id: 'second',
        processor: 'docai',
        status: 'completed',
        started_at: '2024-01-02T00:00:00Z',
      });

      const logs = getJobLogs();
      expect(logs[0].job_id).toBe('second'); // Most recent first
      expect(logs[1].job_id).toBe('first');
    });

    it('should filter by status', async () => {
      const { logJob, getJobLogs } = await import('./logs.js');

      logJob({ job_id: '1', processor: 'docai', status: 'completed', started_at: new Date().toISOString() });
      logJob({ job_id: '2', processor: 'docai', status: 'failed', started_at: new Date().toISOString() });
      logJob({ job_id: '3', processor: 'docai', status: 'completed', started_at: new Date().toISOString() });

      const completed = getJobLogs({ status: 'completed' });
      expect(completed.length).toBe(2);
      expect(completed.every(l => l.status === 'completed')).toBe(true);
    });

    it('should filter by processor', async () => {
      const { logJob, getJobLogs } = await import('./logs.js');

      logJob({ job_id: '1', processor: 'docai', status: 'completed', started_at: new Date().toISOString() });
      logJob({ job_id: '2', processor: 'gemini', status: 'completed', started_at: new Date().toISOString() });
      logJob({ job_id: '3', processor: 'docai', status: 'completed', started_at: new Date().toISOString() });

      const docaiLogs = getJobLogs({ processor: 'docai' });
      expect(docaiLogs.length).toBe(2);
      expect(docaiLogs.every(l => l.processor === 'docai')).toBe(true);
    });

    it('should limit results', async () => {
      const { logJob, getJobLogs } = await import('./logs.js');

      for (let i = 0; i < 10; i++) {
        logJob({ job_id: `job-${i}`, processor: 'docai', status: 'completed', started_at: new Date().toISOString() });
      }

      const limited = getJobLogs({ limit: 5 });
      expect(limited.length).toBe(5);
    });

    it('should search by filename', async () => {
      const { logJob, getJobLogs } = await import('./logs.js');

      logJob({ job_id: '1', file_name: 'invoice.pdf', processor: 'docai', status: 'completed', started_at: new Date().toISOString() });
      logJob({ job_id: '2', file_name: 'report.pdf', processor: 'docai', status: 'completed', started_at: new Date().toISOString() });

      const results = getJobLogs({ search: 'invoice' });
      expect(results.length).toBe(1);
      expect(results[0].file_name).toBe('invoice.pdf');
    });
  });

  describe('getJobStats', () => {
    it('should return correct statistics', async () => {
      const { logJob, getJobStats } = await import('./logs.js');

      logJob({ job_id: '1', processor: 'docai', status: 'completed', pages: 10, duration_ms: 1000, started_at: new Date().toISOString() });
      logJob({ job_id: '2', processor: 'gemini', status: 'completed', pages: 5, duration_ms: 2000, started_at: new Date().toISOString() });
      logJob({ job_id: '3', processor: 'docai', status: 'failed', started_at: new Date().toISOString() });

      const stats = getJobStats();

      expect(stats.total).toBe(3);
      expect(stats.completed).toBe(2);
      expect(stats.failed).toBe(1);
      expect(stats.totalPages).toBe(15);
      expect(stats.avgDuration).toBe(1500);
      expect(stats.byProcessor.docai).toBe(2);
      expect(stats.byProcessor.gemini).toBe(1);
    });
  });

  describe('clearLogs', () => {
    it('should clear all logs', async () => {
      const { logJob, getJobLogs, clearLogs } = await import('./logs.js');

      logJob({ job_id: '1', processor: 'docai', status: 'completed', started_at: new Date().toISOString() });
      logJob({ job_id: '2', processor: 'docai', status: 'completed', started_at: new Date().toISOString() });

      expect(getJobLogs().length).toBe(2);

      clearLogs();

      expect(getJobLogs().length).toBe(0);
    });

    it('should clear only job logs when specified', async () => {
      const { logJob, logChat, getJobLogs, getChatLogs, clearLogs } = await import('./logs.js');

      logJob({ job_id: '1', processor: 'docai', status: 'completed', started_at: new Date().toISOString() });
      logChat({ document_uuid: 'doc-1', message: 'hello', response: 'hi', timestamp: new Date().toISOString() });

      clearLogs('jobs');

      expect(getJobLogs().length).toBe(0);
      expect(getChatLogs().length).toBe(1);
    });
  });

  describe('exportLogs', () => {
    it('should export logs as JSON', async () => {
      const { logJob, exportLogs } = await import('./logs.js');

      logJob({ job_id: '1', processor: 'docai', status: 'completed', started_at: new Date().toISOString() });

      const exported = exportLogs();
      const parsed = JSON.parse(exported);

      expect(parsed.jobs).toBeDefined();
      expect(parsed.chats).toBeDefined();
      expect(parsed.version).toBeDefined();
    });
  });
});
