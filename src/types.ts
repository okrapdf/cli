/**
 * OkraPDF CLI Types
 */

// Job status types matching the API
export type JobStatus = 'queued' | 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';

// Verification status types
export type VerificationStatus = 'pending' | 'verified' | 'flagged' | 'rejected' | 'skipped' | 'needs_review';

// Output format options
export type OutputFormat = 'table' | 'json' | 'jsonl' | 'csv' | 'markdown';

// Document types
export interface Document {
  uuid: string;
  file_name: string;
  file_size: number | null;
  upload_date: string;
  document_type: string;
  thumbnail_url: string | null;
  tables_count?: number;
}

// OCR Job types (API returns snake_case, some fields use different names)
export interface Job {
  // Can be either id or job_id depending on endpoint
  id?: string;
  job_id?: string;
  status: JobStatus;
  // Can be either file_name or filename
  file_name?: string | null;
  filename?: string | null;
  pdf_url?: string | null;
  total_pages: number | null;
  pages_completed: number | null;
  document_uuid?: string | null;
  // Timestamps can vary
  inserted_at?: string;
  created_at?: string;
  updated_at: string;
  error: string | null;
}

// Normalized job for CLI display
export interface NormalizedJob {
  id: string;
  status: JobStatus;
  file_name: string | null;
  total_pages: number | null;
  pages_completed: number | null;
  updated_at: string;
  error: string | null;
}

// Job creation response
export interface CreateJobResponse {
  job_id: string;
  status: JobStatus;
  poll_url: string;
  message?: string;
}

// Job results - matches actual API response structure
export interface JobResultsApiResponse {
  job_id: string;
  filename: string;
  total_pages: number;
  results: {
    tables: TableResult[];
    text: Array<{ page: number; content: string }>;
  };
}

// Normalized job results for CLI display
export interface JobResults {
  job_id: string;
  filename: string;
  total_pages: number;
  pages: PageResult[];
  tables: TableResult[];
}

export interface PageResult {
  page_number: number;
  text: string;
  entities: Entity[];
}

export interface Entity {
  type: string;
  value: string;
  confidence: number;
  bounding_box?: BoundingBox;
}

export interface TableResult {
  id: string;
  page_number: number;
  content_markdown: string;
  confidence: number | null;
  bbox?: BoundingBox;
}

export interface BoundingBox {
  xmin: number;
  ymin: number;
  xmax: number;
  ymax: number;
}

// Table types
export interface Table {
  id: string;
  document_uuid: string;
  page_number: number;
  content_markdown: string;
  processor_type: string;
  confidence: number | null;
  bbox: BoundingBox;
  verification_status?: VerificationStatus;
  verified_at?: string | null;
  verified_by?: string | null;
  created_at: string;
  updated_at?: string;
}

// Chat message types
export interface ChatMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp?: string;
}

export interface ChatResponse {
  message: ChatMessage;
  job_id?: string;
  output_files?: OutputFile[];
}

export interface OutputFile {
  filename: string;
  gcs_path: string;
  mime_type: string;
}

// API Response wrapper
export interface ApiResponse<T> {
  success: boolean;
  data?: T;
  error?: ApiError;
}

export interface ApiError {
  code: string;
  message: string;
  details?: Record<string, unknown>;
}

// Pagination
export interface PaginatedResponse<T> {
  items: T[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
    hasNextPage: boolean;
    hasPrevPage: boolean;
  };
}

// Config types
export interface CliConfig {
  api_key?: string;
  base_url: string;
  default_format: OutputFormat;
  default_ocr?: OcrEngine;
  default_vlm?: VlmModel;
}

// Upload types - API returns camelCase
export interface SignedUrlResponse {
  signedUrl: string;
  gcsPath: string;
  gcsFileName: string;
  // Legacy fields for backwards compat
  upload_url?: string;
  document_uuid?: string;
  gcs_path?: string;
}

// User info
export interface UserInfo {
  id: string;
  email: string;
  name?: string;
  created_at: string;
}

// Export formats
export type ExportFormat = 'docx' | 'xlsx' | 'zip' | 'csv' | 'json';

// ============================================================================
// Extraction Pipeline Types
// ============================================================================

export type OcrEngine = 'docai' | 'tesseract' | 'textract' | 'azure-read';

export type VlmModel = string;

export interface ExtractionOptions {
  ocr_engine?: OcrEngine;
  vlm_model?: VlmModel;
}
