/**
 * Extraction Templates
 *
 * Reusable patterns for common document types.
 * Users can create custom templates stored in ~/.okrapdf/templates/
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from 'fs';
import { join, basename } from 'path';
import { homedir } from 'os';

export interface ExtractField {
  name: string;
  description: string;
  type: 'string' | 'number' | 'date' | 'currency' | 'array' | 'table';
  required?: boolean;
  format?: string;
}

export interface Template {
  id: string;
  name: string;
  description: string;
  /** Document type this template is for */
  documentType: string;
  /** Preferred processor for this template */
  processor?: string;
  /** Fields to extract */
  fields: ExtractField[];
  /** System prompt for LLM-based extraction */
  systemPrompt?: string;
  /** Example output format */
  exampleOutput?: Record<string, unknown>;
  /** Whether this is a built-in template */
  builtin?: boolean;
}

// Built-in templates for common document types
export const BUILTIN_TEMPLATES: Record<string, Template> = {
  'invoice': {
    id: 'invoice',
    name: 'Invoice',
    description: 'Extract data from invoices and bills',
    documentType: 'invoice',
    processor: 'docai',
    fields: [
      { name: 'vendor_name', description: 'Vendor/supplier name', type: 'string', required: true },
      { name: 'invoice_number', description: 'Invoice number', type: 'string', required: true },
      { name: 'invoice_date', description: 'Invoice date', type: 'date', format: 'YYYY-MM-DD' },
      { name: 'due_date', description: 'Payment due date', type: 'date', format: 'YYYY-MM-DD' },
      { name: 'total_amount', description: 'Total amount due', type: 'currency', required: true },
      { name: 'tax_amount', description: 'Tax amount', type: 'currency' },
      { name: 'line_items', description: 'Line items', type: 'table' },
    ],
    systemPrompt: 'Extract invoice data. Return structured JSON with vendor_name, invoice_number, invoice_date, due_date, total_amount, tax_amount, and line_items array.',
    builtin: true,
  },
  'receipt': {
    id: 'receipt',
    name: 'Receipt',
    description: 'Extract data from receipts',
    documentType: 'receipt',
    processor: 'gemini',
    fields: [
      { name: 'merchant_name', description: 'Store/merchant name', type: 'string', required: true },
      { name: 'date', description: 'Transaction date', type: 'date' },
      { name: 'total', description: 'Total amount', type: 'currency', required: true },
      { name: 'tax', description: 'Tax amount', type: 'currency' },
      { name: 'items', description: 'Purchased items', type: 'array' },
      { name: 'payment_method', description: 'Payment method', type: 'string' },
    ],
    builtin: true,
  },
  'financial-statement': {
    id: 'financial-statement',
    name: 'Financial Statement',
    description: 'Extract data from financial statements (balance sheet, income statement)',
    documentType: 'financial',
    processor: 'llamaparse',
    fields: [
      { name: 'company_name', description: 'Company name', type: 'string', required: true },
      { name: 'period', description: 'Reporting period', type: 'string', required: true },
      { name: 'statement_type', description: 'Type of statement', type: 'string' },
      { name: 'total_assets', description: 'Total assets', type: 'currency' },
      { name: 'total_liabilities', description: 'Total liabilities', type: 'currency' },
      { name: 'total_equity', description: 'Total equity', type: 'currency' },
      { name: 'revenue', description: 'Total revenue', type: 'currency' },
      { name: 'net_income', description: 'Net income', type: 'currency' },
      { name: 'tables', description: 'Financial tables', type: 'table' },
    ],
    builtin: true,
  },
  'contract': {
    id: 'contract',
    name: 'Contract',
    description: 'Extract key terms from contracts and agreements',
    documentType: 'contract',
    processor: 'qwen',
    fields: [
      { name: 'parties', description: 'Contracting parties', type: 'array', required: true },
      { name: 'effective_date', description: 'Effective date', type: 'date' },
      { name: 'termination_date', description: 'Termination/expiry date', type: 'date' },
      { name: 'contract_value', description: 'Contract value', type: 'currency' },
      { name: 'key_terms', description: 'Key terms and conditions', type: 'array' },
      { name: 'obligations', description: 'Key obligations', type: 'array' },
    ],
    builtin: true,
  },
  'resume': {
    id: 'resume',
    name: 'Resume/CV',
    description: 'Extract structured data from resumes',
    documentType: 'resume',
    processor: 'gemini',
    fields: [
      { name: 'name', description: 'Full name', type: 'string', required: true },
      { name: 'email', description: 'Email address', type: 'string' },
      { name: 'phone', description: 'Phone number', type: 'string' },
      { name: 'location', description: 'Location', type: 'string' },
      { name: 'summary', description: 'Professional summary', type: 'string' },
      { name: 'experience', description: 'Work experience', type: 'array' },
      { name: 'education', description: 'Education', type: 'array' },
      { name: 'skills', description: 'Skills', type: 'array' },
    ],
    builtin: true,
  },
  'table': {
    id: 'table',
    name: 'Table Extraction',
    description: 'Extract all tables from a document',
    documentType: 'any',
    processor: 'default',
    fields: [
      { name: 'tables', description: 'All tables in the document', type: 'table', required: true },
    ],
    builtin: true,
  },
};

/**
 * Get the templates directory path
 */
export function getTemplatesDir(): string {
  const dir = join(homedir(), '.okrapdf', 'templates');
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  return dir;
}

/**
 * Load a template by ID (checks user templates first, then builtins)
 */
export function loadTemplate(id: string): Template | undefined {
  // Check user templates first
  const userPath = join(getTemplatesDir(), `${id}.json`);
  if (existsSync(userPath)) {
    try {
      const content = readFileSync(userPath, 'utf-8');
      return JSON.parse(content) as Template;
    } catch {
      // Fall through to builtin
    }
  }

  // Check builtins
  return BUILTIN_TEMPLATES[id];
}

/**
 * Save a custom template
 */
export function saveTemplate(template: Template): void {
  const path = join(getTemplatesDir(), `${template.id}.json`);
  writeFileSync(path, JSON.stringify(template, null, 2), 'utf-8');
}

/**
 * List all available templates (user + builtin)
 */
export function listTemplates(): Template[] {
  const templates: Template[] = [];

  // Add user templates
  const userDir = getTemplatesDir();
  if (existsSync(userDir)) {
    const files = readdirSync(userDir).filter(f => f.endsWith('.json'));
    for (const file of files) {
      try {
        const content = readFileSync(join(userDir, file), 'utf-8');
        const template = JSON.parse(content) as Template;
        template.builtin = false;
        templates.push(template);
      } catch {
        // Skip invalid templates
      }
    }
  }

  // Add builtins (that aren't overridden)
  const userIds = new Set(templates.map(t => t.id));
  for (const builtin of Object.values(BUILTIN_TEMPLATES)) {
    if (!userIds.has(builtin.id)) {
      templates.push(builtin);
    }
  }

  return templates.sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * Delete a user template
 */
export function deleteTemplate(id: string): boolean {
  const path = join(getTemplatesDir(), `${id}.json`);
  if (existsSync(path)) {
    const { unlinkSync } = require('fs');
    unlinkSync(path);
    return true;
  }
  return false;
}

/**
 * Format template for display
 */
export function formatTemplateInfo(template: Template): string {
  const lines = [
    `ID: ${template.id}${template.builtin ? ' (builtin)' : ''}`,
    `Name: ${template.name}`,
    `Description: ${template.description}`,
    `Document Type: ${template.documentType}`,
    template.processor ? `Processor: ${template.processor}` : null,
    '',
    'Fields:',
    ...template.fields.map(f =>
      `  - ${f.name} (${f.type})${f.required ? ' *required' : ''}: ${f.description}`
    ),
  ].filter(Boolean);

  return lines.join('\n');
}
