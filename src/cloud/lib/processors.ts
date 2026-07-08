/**
 * Processor Plugin System
 *
 * Provides vendor-agnostic abstraction for different OCR/extraction providers.
 * Inspired by Simon Willison's llm plugin architecture.
 */

export interface ProcessorOptions {
  /** Pages to process (e.g., "1-5", "1,3,5", "all") */
  pages?: string;
  /** Output format preference */
  format?: 'markdown' | 'json' | 'html';
  /** Language hint for OCR */
  language?: string;
  /** Enable table detection */
  tables?: boolean;
  /** Enable form field detection */
  forms?: boolean;
  /** Custom processor-specific options */
  custom?: Record<string, unknown>;
}

export interface ProcessorResult {
  pages: Array<{
    page_number: number;
    text: string;
    tables?: Array<{
      content: string;
      confidence?: number;
    }>;
    entities?: Array<{
      type: string;
      value: string;
      confidence?: number;
    }>;
  }>;
  metadata?: Record<string, unknown>;
}

export interface Processor {
  /** Unique processor identifier */
  id: string;
  /** Human-readable name */
  name: string;
  /** Description */
  description: string;
  /** Whether this processor is available (has required config/API keys) */
  isAvailable(): Promise<boolean>;
  /** Process a document */
  process(documentUuid: string, options?: ProcessorOptions): Promise<ProcessorResult>;
}

// Built-in processor definitions
export const BUILTIN_PROCESSORS: Record<string, {
  id: string;
  name: string;
  description: string;
  apiEndpoint: string;
  requiresKey?: string;
}> = {
  'docai': {
    id: 'docai',
    name: 'Google Document AI',
    description: 'Google Cloud Document AI for high-accuracy OCR and form parsing',
    apiEndpoint: 'api/v1/ocr/google-docai',
    requiresKey: 'GOOGLE_DOCAI',
  },
  'qwen': {
    id: 'qwen',
    name: 'Qwen VL',
    description: 'Qwen Vision-Language model for document understanding',
    apiEndpoint: 'api/qwen/extract',
  },
  'llamaparse': {
    id: 'llamaparse',
    name: 'LlamaParse',
    description: 'LlamaIndex parser for complex document layouts',
    apiEndpoint: 'api/parse/llama',
    requiresKey: 'LLAMA_CLOUD',
  },
  'gemini': {
    id: 'gemini',
    name: 'Google Gemini',
    description: 'Google Gemini multimodal model for document analysis',
    apiEndpoint: 'api/parse/gemini',
    requiresKey: 'GOOGLE_GEMINI',
  },
  'pdfplumber': {
    id: 'pdfplumber',
    name: 'PDFPlumber',
    description: 'Local Python-based PDF text extraction (no OCR)',
    apiEndpoint: 'api/extract-text',
  },
  'default': {
    id: 'default',
    name: 'okraPDF Default',
    description: 'Automatic processor selection based on document type',
    apiEndpoint: 'api/v1/extract',
  },
};

// Processor aliases for convenience
export const PROCESSOR_ALIASES: Record<string, string> = {
  'google': 'docai',
  'gcp': 'docai',
  'llama': 'llamaparse',
  'lp': 'llamaparse',
  'q': 'qwen',
  'g': 'gemini',
  'local': 'pdfplumber',
  'auto': 'default',
};

/**
 * Resolve a processor name (including aliases) to a processor ID
 */
export function resolveProcessor(nameOrAlias: string): string {
  const lower = nameOrAlias.toLowerCase();
  return PROCESSOR_ALIASES[lower] || lower;
}

/**
 * Get processor info by ID
 */
export function getProcessor(id: string): typeof BUILTIN_PROCESSORS[string] | undefined {
  const resolved = resolveProcessor(id);
  return BUILTIN_PROCESSORS[resolved];
}

/**
 * List all available processors
 */
export function listProcessors(): Array<typeof BUILTIN_PROCESSORS[string]> {
  return Object.values(BUILTIN_PROCESSORS);
}

/**
 * Format processor list for display
 */
export function formatProcessorList(): string {
  const processors = listProcessors();
  const lines = processors.map(p => {
    const aliases = Object.entries(PROCESSOR_ALIASES)
      .filter(([_, v]) => v === p.id)
      .map(([k]) => k);
    const aliasStr = aliases.length > 0 ? ` (aliases: ${aliases.join(', ')})` : '';
    return `  ${p.id.padEnd(12)} ${p.name}${aliasStr}\n                 ${p.description}`;
  });
  return lines.join('\n\n');
}
