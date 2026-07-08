/**
 * Tests for extraction templates
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, existsSync, writeFileSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  BUILTIN_TEMPLATES,
  loadTemplate,
  saveTemplate,
  listTemplates,
  deleteTemplate,
  formatTemplateInfo,
  Template,
} from './templates.js';

describe('templates', () => {
  describe('BUILTIN_TEMPLATES', () => {
    it('should have expected templates', () => {
      expect(BUILTIN_TEMPLATES).toHaveProperty('invoice');
      expect(BUILTIN_TEMPLATES).toHaveProperty('receipt');
      expect(BUILTIN_TEMPLATES).toHaveProperty('financial-statement');
      expect(BUILTIN_TEMPLATES).toHaveProperty('contract');
      expect(BUILTIN_TEMPLATES).toHaveProperty('resume');
      expect(BUILTIN_TEMPLATES).toHaveProperty('table');
    });

    it('should have required fields for each template', () => {
      for (const [id, tpl] of Object.entries(BUILTIN_TEMPLATES)) {
        expect(tpl.id).toBe(id);
        expect(tpl.name).toBeTruthy();
        expect(tpl.description).toBeTruthy();
        expect(tpl.documentType).toBeTruthy();
        expect(Array.isArray(tpl.fields)).toBe(true);
        expect(tpl.builtin).toBe(true);
      }
    });

    it('invoice template should have expected fields', () => {
      const invoice = BUILTIN_TEMPLATES.invoice;
      const fieldNames = invoice.fields.map(f => f.name);

      expect(fieldNames).toContain('vendor_name');
      expect(fieldNames).toContain('invoice_number');
      expect(fieldNames).toContain('total_amount');
    });

    it('receipt template should have expected fields', () => {
      const receipt = BUILTIN_TEMPLATES.receipt;
      const fieldNames = receipt.fields.map(f => f.name);

      expect(fieldNames).toContain('merchant_name');
      expect(fieldNames).toContain('total');
      expect(fieldNames).toContain('items');
    });
  });

  describe('loadTemplate', () => {
    it('should load builtin templates', () => {
      const invoice = loadTemplate('invoice');
      expect(invoice).toBeDefined();
      expect(invoice?.id).toBe('invoice');
      expect(invoice?.builtin).toBe(true);
    });

    it('should return undefined for unknown templates', () => {
      expect(loadTemplate('nonexistent')).toBeUndefined();
    });
  });

  describe('listTemplates', () => {
    it('should return all builtin templates', () => {
      const templates = listTemplates();
      const builtinCount = Object.keys(BUILTIN_TEMPLATES).length;

      // Should have at least all builtins
      expect(templates.length).toBeGreaterThanOrEqual(builtinCount);

      // All builtins should be present
      for (const id of Object.keys(BUILTIN_TEMPLATES)) {
        expect(templates.find(t => t.id === id)).toBeDefined();
      }
    });

    it('should return sorted templates', () => {
      const templates = listTemplates();
      const ids = templates.map(t => t.id);
      const sortedIds = [...ids].sort();

      expect(ids).toEqual(sortedIds);
    });
  });

  describe('formatTemplateInfo', () => {
    it('should format template info as string', () => {
      const invoice = BUILTIN_TEMPLATES.invoice;
      const formatted = formatTemplateInfo(invoice);

      expect(formatted).toContain('invoice');
      expect(formatted).toContain('Invoice');
      expect(formatted).toContain('Fields:');
      expect(formatted).toContain('vendor_name');
    });

    it('should indicate builtin status', () => {
      const invoice = BUILTIN_TEMPLATES.invoice;
      const formatted = formatTemplateInfo(invoice);

      expect(formatted).toContain('builtin');
    });
  });

  describe('template fields', () => {
    it('should have valid field types', () => {
      const validTypes = ['string', 'number', 'date', 'currency', 'array', 'table'];

      for (const tpl of Object.values(BUILTIN_TEMPLATES)) {
        for (const field of tpl.fields) {
          expect(validTypes).toContain(field.type);
        }
      }
    });

    it('required fields should be marked', () => {
      const invoice = BUILTIN_TEMPLATES.invoice;
      const vendorField = invoice.fields.find(f => f.name === 'vendor_name');

      expect(vendorField?.required).toBe(true);
    });
  });
});
