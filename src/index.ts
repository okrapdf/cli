#!/usr/bin/env node
/**
 * OkraPDF CLI - Entry Point
 *
 * A command-line interface for OkraPDF that provides:
 * - Document management (upload, list, download, delete)
 * - OCR job management (create, status, results, export)
 * - Table extraction and export
 * - Interactive document chat
 *
 * Usage:
 *   okra <command> [options]
 *
 * Examples:
 *   okra auth login
 *   okra extract invoice.pdf
 *   okra chat <document-uuid>
 */

import { run } from './cli.js';

run().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
