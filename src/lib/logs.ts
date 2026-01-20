/**
 * Local SQLite Logging
 *
 * Stores job history, results cache, and usage metrics locally.
 * Inspired by Simon Willison's llm logging system.
 */

import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

// Log entry types
export interface JobLogEntry {
  id: string;
  job_id: string;
  document_uuid?: string;
  file_name?: string;
  processor: string;
  template?: string;
  status: string;
  pages?: number;
  tables_count?: number;
  started_at: string;
  completed_at?: string;
  duration_ms?: number;
  error?: string;
  result_summary?: string;
}

export interface ChatLogEntry {
  id: string;
  document_uuid: string;
  message: string;
  response: string;
  model?: string;
  timestamp: string;
  duration_ms?: number;
  tokens_used?: number;
}

// Simple JSON-based log storage (can be upgraded to SQLite later)
interface LogStore {
  jobs: JobLogEntry[];
  chats: ChatLogEntry[];
  version: number;
}

const LOG_VERSION = 1;

/**
 * Get the logs directory path
 */
export function getLogsDir(): string {
  const dir = join(homedir(), '.okrapdf', 'logs');
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  return dir;
}

/**
 * Get the log file path
 */
function getLogPath(): string {
  return join(getLogsDir(), 'history.json');
}

/**
 * Load the log store
 */
function loadStore(): LogStore {
  const path = getLogPath();
  if (existsSync(path)) {
    try {
      const content = readFileSync(path, 'utf-8');
      return JSON.parse(content) as LogStore;
    } catch {
      // Return empty store on error
    }
  }
  return { jobs: [], chats: [], version: LOG_VERSION };
}

/**
 * Save the log store
 */
function saveStore(store: LogStore): void {
  const path = getLogPath();
  writeFileSync(path, JSON.stringify(store, null, 2), 'utf-8');
}

/**
 * Generate a unique log ID
 */
function generateId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Log a job
 */
export function logJob(entry: Omit<JobLogEntry, 'id'>): JobLogEntry {
  const store = loadStore();
  const logEntry: JobLogEntry = {
    id: generateId(),
    ...entry,
  };
  store.jobs.unshift(logEntry); // Most recent first

  // Keep only last 1000 entries
  if (store.jobs.length > 1000) {
    store.jobs = store.jobs.slice(0, 1000);
  }

  saveStore(store);
  return logEntry;
}

/**
 * Update a job log entry
 */
export function updateJobLog(id: string, updates: Partial<JobLogEntry>): void {
  const store = loadStore();
  const index = store.jobs.findIndex(j => j.id === id);
  if (index >= 0) {
    store.jobs[index] = { ...store.jobs[index], ...updates };
    saveStore(store);
  }
}

/**
 * Log a chat message
 */
export function logChat(entry: Omit<ChatLogEntry, 'id'>): ChatLogEntry {
  const store = loadStore();
  const logEntry: ChatLogEntry = {
    id: generateId(),
    ...entry,
  };
  store.chats.unshift(logEntry);

  // Keep only last 500 chat entries
  if (store.chats.length > 500) {
    store.chats = store.chats.slice(0, 500);
  }

  saveStore(store);
  return logEntry;
}

/**
 * Get recent job logs
 */
export function getJobLogs(options: {
  limit?: number;
  status?: string;
  processor?: string;
  search?: string;
} = {}): JobLogEntry[] {
  const store = loadStore();
  let jobs = store.jobs;

  if (options.status) {
    jobs = jobs.filter(j => j.status === options.status);
  }

  if (options.processor) {
    jobs = jobs.filter(j => j.processor === options.processor);
  }

  if (options.search) {
    const search = options.search.toLowerCase();
    jobs = jobs.filter(j =>
      j.file_name?.toLowerCase().includes(search) ||
      j.job_id.toLowerCase().includes(search) ||
      j.document_uuid?.toLowerCase().includes(search)
    );
  }

  return jobs.slice(0, options.limit || 50);
}

/**
 * Get recent chat logs
 */
export function getChatLogs(options: {
  limit?: number;
  documentUuid?: string;
  search?: string;
} = {}): ChatLogEntry[] {
  const store = loadStore();
  let chats = store.chats;

  if (options.documentUuid) {
    chats = chats.filter(c => c.document_uuid === options.documentUuid);
  }

  if (options.search) {
    const search = options.search.toLowerCase();
    chats = chats.filter(c =>
      c.message.toLowerCase().includes(search) ||
      c.response.toLowerCase().includes(search)
    );
  }

  return chats.slice(0, options.limit || 50);
}

/**
 * Get job stats
 */
export function getJobStats(): {
  total: number;
  completed: number;
  failed: number;
  byProcessor: Record<string, number>;
  totalPages: number;
  avgDuration: number;
} {
  const store = loadStore();
  const jobs = store.jobs;

  const byProcessor: Record<string, number> = {};
  let totalPages = 0;
  let totalDuration = 0;
  let durationCount = 0;

  for (const job of jobs) {
    byProcessor[job.processor] = (byProcessor[job.processor] || 0) + 1;
    if (job.pages) totalPages += job.pages;
    if (job.duration_ms) {
      totalDuration += job.duration_ms;
      durationCount++;
    }
  }

  return {
    total: jobs.length,
    completed: jobs.filter(j => j.status === 'completed').length,
    failed: jobs.filter(j => j.status === 'failed').length,
    byProcessor,
    totalPages,
    avgDuration: durationCount > 0 ? Math.round(totalDuration / durationCount) : 0,
  };
}

/**
 * Clear all logs
 */
export function clearLogs(type?: 'jobs' | 'chats'): void {
  const store = loadStore();
  if (!type || type === 'jobs') {
    store.jobs = [];
  }
  if (!type || type === 'chats') {
    store.chats = [];
  }
  saveStore(store);
}

/**
 * Export logs to JSON
 */
export function exportLogs(): string {
  const store = loadStore();
  return JSON.stringify(store, null, 2);
}

/**
 * Format job log for display
 */
export function formatJobLog(entry: JobLogEntry): string {
  const duration = entry.duration_ms
    ? `${(entry.duration_ms / 1000).toFixed(1)}s`
    : '-';

  return [
    `${entry.started_at.slice(0, 19)} | ${entry.status.padEnd(10)} | ${entry.processor.padEnd(10)} | ${duration.padStart(6)} | ${entry.file_name || entry.job_id}`,
  ].join('');
}
