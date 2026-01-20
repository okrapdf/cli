/**
 * Tests for output formatters
 */

import { describe, it, expect } from 'vitest';
import {
  formatOutput,
  formatJson,
  formatJsonl,
  formatCsv,
  formatMarkdown,
  formatFileSize,
  formatDate,
  formatStatus,
} from './output.js';

describe('output formatters', () => {
  describe('formatJson', () => {
    it('should format object as JSON', () => {
      const data = { name: 'test', value: 123 };
      const result = formatJson(data);

      expect(JSON.parse(result)).toEqual(data);
    });

    it('should format arrays', () => {
      const data = [{ id: 1 }, { id: 2 }];
      const result = formatJson(data);

      expect(JSON.parse(result)).toEqual(data);
    });

    it('should pretty print with indentation', () => {
      const data = { key: 'value' };
      const result = formatJson(data);

      expect(result).toContain('\n');
      expect(result).toContain('  ');
    });
  });

  describe('formatJsonl', () => {
    it('should format array as JSON lines', () => {
      const data = [{ id: 1 }, { id: 2 }];
      const result = formatJsonl(data);
      const lines = result.split('\n');

      expect(lines).toHaveLength(2);
      expect(JSON.parse(lines[0])).toEqual({ id: 1 });
      expect(JSON.parse(lines[1])).toEqual({ id: 2 });
    });

    it('should format single object as single line', () => {
      const data = { id: 1 };
      const result = formatJsonl(data);

      expect(result).not.toContain('\n');
      expect(JSON.parse(result)).toEqual(data);
    });
  });

  describe('formatCsv', () => {
    it('should format array as CSV', () => {
      const data = [
        { name: 'Alice', age: 30 },
        { name: 'Bob', age: 25 },
      ];
      const result = formatCsv(data);
      const lines = result.split('\n');

      expect(lines[0]).toBe('name,age');
      expect(lines[1]).toBe('Alice,30');
      expect(lines[2]).toBe('Bob,25');
    });

    it('should escape fields with commas', () => {
      const data = [{ name: 'Last, First', value: 'ok' }];
      const result = formatCsv(data);

      expect(result).toContain('"Last, First"');
    });

    it('should escape fields with quotes', () => {
      const data = [{ name: 'Say "hello"', value: 'ok' }];
      const result = formatCsv(data);

      expect(result).toContain('"Say ""hello"""');
    });

    it('should use custom columns', () => {
      const data = [{ first: 'A', second: 'B', third: 'C' }];
      const columns = [
        { key: 'first', header: 'First Column' },
        { key: 'third', header: 'Third Column' },
      ];
      const result = formatCsv(data, columns);
      const lines = result.split('\n');

      expect(lines[0]).toBe('First Column,Third Column');
      expect(lines[1]).toBe('A,C');
    });
  });

  describe('formatMarkdown', () => {
    it('should format as markdown table', () => {
      const data = [
        { name: 'Alice', age: 30 },
        { name: 'Bob', age: 25 },
      ];
      const result = formatMarkdown(data);

      expect(result).toContain('| name | age |');
      expect(result).toContain('| --- | --- |');
      expect(result).toContain('| Alice | 30 |');
    });

    it('should escape pipe characters', () => {
      const data = [{ name: 'A | B', value: 'ok' }];
      const result = formatMarkdown(data);

      expect(result).toContain('A \\| B');
    });
  });

  describe('formatOutput', () => {
    const testData = [{ id: 1, name: 'test' }];

    it('should format as json', () => {
      const result = formatOutput(testData, 'json');
      expect(JSON.parse(result)).toEqual(testData);
    });

    it('should format as jsonl', () => {
      const result = formatOutput(testData, 'jsonl');
      expect(JSON.parse(result)).toEqual(testData[0]);
    });

    it('should format as csv', () => {
      const result = formatOutput(testData, 'csv');
      expect(result).toContain('id,name');
    });

    it('should format as markdown', () => {
      const result = formatOutput(testData, 'markdown');
      expect(result).toContain('| id | name |');
    });

    it('should default to table format', () => {
      const result = formatOutput(testData, 'table');
      // Table format includes box-drawing characters
      expect(result).toBeTruthy();
    });
  });

  describe('formatFileSize', () => {
    it('should format bytes', () => {
      expect(formatFileSize(500)).toBe('500.0 B');
    });

    it('should format kilobytes', () => {
      expect(formatFileSize(1024)).toBe('1.0 KB');
      expect(formatFileSize(2048)).toBe('2.0 KB');
    });

    it('should format megabytes', () => {
      expect(formatFileSize(1024 * 1024)).toBe('1.0 MB');
      expect(formatFileSize(5 * 1024 * 1024)).toBe('5.0 MB');
    });

    it('should format gigabytes', () => {
      expect(formatFileSize(1024 * 1024 * 1024)).toBe('1.0 GB');
    });

    it('should handle null', () => {
      expect(formatFileSize(null)).toBe('-');
    });
  });

  describe('formatDate', () => {
    it('should format recent dates as relative', () => {
      const now = new Date();
      const fiveMinutesAgo = new Date(now.getTime() - 5 * 60 * 1000);

      const result = formatDate(fiveMinutesAgo.toISOString());
      expect(result).toContain('m ago');
    });

    it('should format hours ago', () => {
      const now = new Date();
      const twoHoursAgo = new Date(now.getTime() - 2 * 60 * 60 * 1000);

      const result = formatDate(twoHoursAgo.toISOString());
      expect(result).toContain('h ago');
    });

    it('should format days ago', () => {
      const now = new Date();
      const threeDaysAgo = new Date(now.getTime() - 3 * 24 * 60 * 60 * 1000);

      const result = formatDate(threeDaysAgo.toISOString());
      expect(result).toContain('d ago');
    });
  });

  describe('formatStatus', () => {
    it('should format completed status', () => {
      const result = formatStatus('completed');
      expect(result).toContain('completed');
    });

    it('should format failed status', () => {
      const result = formatStatus('failed');
      expect(result).toContain('failed');
    });

    it('should format running status', () => {
      const result = formatStatus('running');
      expect(result).toContain('running');
    });

    it('should format queued status', () => {
      const result = formatStatus('queued');
      expect(result).toContain('queued');
    });
  });
});
