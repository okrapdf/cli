/**
 * Tests for OCR Review Scorer
 *
 * These tests prove the deterministic scoring workflows work correctly
 * for prioritizing pages in large document review.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  OcrReviewScorer,
  createScorer,
  compareOcrToMarkdown,
  parsePagesJson,
  parseTablesJson,
  formatScoredPages,
  formatStats,
  DEFAULT_CONFIG,
  // Financial verification
  getConfidenceTier,
  categorizeByConfidence,
  runCheckSums,
  detectAnomalies,
  validateCrossQuery,
  runFinancialVerification,
  formatVerificationReport,
  CONFIDENCE_TIERS,
  FINANCIAL_CHECKSUMS,
  CROSS_QUERY_RULES,
  type PageData,
  type TableData,
  type OcrBlock,
  type ScoredPage,
  type ConfidenceTier,
} from './scorer.js';

// ============================================================================
// Test Fixtures
// ============================================================================

function createMockPage(overrides: Partial<PageData> = {}): PageData {
  return {
    page: 1,
    status: 'pending',
    total: 0,
    verified: 0,
    pending: 0,
    flagged: 0,
    rejected: 0,
    avgConfidence: 0.9,
    hasOcr: true,
    ocrLineCount: 50,
    hasCoverageGaps: false,
    uncoveredCount: 0,
    resolution: null,
    classification: null,
    isStale: false,
    ...overrides,
  };
}

function createMockTable(overrides: Partial<TableData> = {}): TableData {
  return {
    id: 'table-1',
    page_number: 1,
    markdown: '| Col1 | Col2 |\n|------|------|\n| A | B |',
    verification_status: 'pending',
    confidence: 0.85,
    ...overrides,
  };
}

function createMockOcrBlocks(): OcrBlock[] {
  return [
    { text: 'Header Text', bbox: { x: 100, y: 50, width: 200, height: 20 }, confidence: 0.95 },
    { text: 'First paragraph content here.', bbox: { x: 50, y: 100, width: 400, height: 40 }, confidence: 0.88 },
    { text: 'Table cell 1', bbox: { x: 50, y: 200, width: 100, height: 20 }, confidence: 0.82 },
    { text: 'Table cell 2', bbox: { x: 150, y: 200, width: 100, height: 20 }, confidence: 0.80 },
  ];
}

// ============================================================================
// Core Scorer Tests
// ============================================================================

describe('OcrReviewScorer', () => {
  let scorer: OcrReviewScorer;

  beforeEach(() => {
    scorer = new OcrReviewScorer();
  });

  describe('scorePage', () => {
    it('should return zero score for high confidence page with no tables', () => {
      const page = createMockPage({ avgConfidence: 0.95 });
      const result = scorer.scorePage(page);

      expect(result.score).toBeLessThan(10);
      expect(result.tableCount).toBe(0);
      expect(result.flags).not.toContain('has_tables');
    });

    it('should increase score for pages with tables', () => {
      const page = createMockPage({ page: 1 });
      const tables = [
        createMockTable({ page_number: 1 }),
        createMockTable({ page_number: 1, id: 'table-2' }),
      ];
      scorer.loadTables(tables);

      const result = scorer.scorePage(page);

      expect(result.score).toBeGreaterThan(0);
      expect(result.tableCount).toBe(2);
      expect(result.breakdown.tableScore).toBe(20); // 2 * 10 default weight
      expect(result.flags).toContain('has_tables');
    });

    it('should increase score for low confidence pages', () => {
      const highConfPage = createMockPage({ avgConfidence: 0.95, page: 1 });
      const lowConfPage = createMockPage({ avgConfidence: 0.5, page: 2 });

      const highResult = scorer.scorePage(highConfPage);
      const lowResult = scorer.scorePage(lowConfPage);

      expect(lowResult.score).toBeGreaterThan(highResult.score);
      expect(lowResult.breakdown.confidenceScore).toBeGreaterThan(highResult.breakdown.confidenceScore);
      expect(lowResult.flags).toContain('low_confidence');
    });

    it('should add penalty for coverage gaps', () => {
      const noGaps = createMockPage({ hasCoverageGaps: false });
      const hasGaps = createMockPage({ hasCoverageGaps: true });

      const noGapsResult = scorer.scorePage(noGaps);
      const hasGapsResult = scorer.scorePage(hasGaps);

      expect(hasGapsResult.score).toBeGreaterThan(noGapsResult.score);
      expect(hasGapsResult.breakdown.coverageScore).toBe(DEFAULT_CONFIG.weights.coverageGap);
      expect(hasGapsResult.flags).toContain('coverage_gaps');
    });

    it('should add penalty for flagged entities', () => {
      const noFlagged = createMockPage({ flagged: 0 });
      const hasFlagged = createMockPage({ flagged: 3 });

      const noFlaggedResult = scorer.scorePage(noFlagged);
      const hasFlaggedResult = scorer.scorePage(hasFlagged);

      expect(hasFlaggedResult.score).toBeGreaterThan(noFlaggedResult.score);
      expect(hasFlaggedResult.breakdown.flaggedScore).toBe(3 * DEFAULT_CONFIG.weights.flaggedEntity);
      expect(hasFlaggedResult.flags).toContain('has_flagged');
    });
  });

  describe('scoreAll', () => {
    it('should sort pages by score descending (highest priority first)', () => {
      const pages = [
        createMockPage({ page: 1, avgConfidence: 0.95 }),  // Low priority
        createMockPage({ page: 2, avgConfidence: 0.5 }),   // High priority (low confidence)
        createMockPage({ page: 3, avgConfidence: 0.8 }),   // Medium priority
      ];

      const results = scorer.scoreAll(pages);

      expect(results[0].page).toBe(2); // Lowest confidence = highest priority
      expect(results[1].page).toBe(3);
      expect(results[2].page).toBe(1); // Highest confidence = lowest priority
    });

    it('should correctly combine multiple scoring factors', () => {
      const tables = [
        createMockTable({ page_number: 2 }),
        createMockTable({ page_number: 2, id: 'table-2' }),
        createMockTable({ page_number: 2, id: 'table-3' }),
      ];
      scorer.loadTables(tables);

      const pages = [
        createMockPage({ page: 1, avgConfidence: 0.6, hasCoverageGaps: true }),  // Low conf + gaps
        createMockPage({ page: 2, avgConfidence: 0.9 }),  // 3 tables but high conf
        createMockPage({ page: 3, avgConfidence: 0.7, flagged: 2 }),  // Low conf + flagged
      ];

      const results = scorer.scoreAll(pages);

      // Page 3 should be highest: low conf + 2 flagged entities
      // Page 1: low conf + gaps
      // Page 2: 3 tables but high confidence
      expect(results[0].page).toBe(3);
      expect(results.map(r => r.page)).toEqual(expect.arrayContaining([1, 2, 3]));
    });
  });

  describe('filter', () => {
    it('should filter by status', () => {
      const pages = [
        createMockPage({ page: 1, status: 'pending' }),
        createMockPage({ page: 2, status: 'complete' }),
        createMockPage({ page: 3, status: 'flagged' }),
      ];

      const pending = scorer.filter(pages, { status: 'pending' });
      expect(pending.length).toBe(1);
      expect(pending[0].page).toBe(1);

      const multiple = scorer.filter(pages, { status: ['pending', 'flagged'] });
      expect(multiple.length).toBe(2);
    });

    it('should filter by confidence range', () => {
      const pages = [
        createMockPage({ page: 1, avgConfidence: 0.95 }),
        createMockPage({ page: 2, avgConfidence: 0.75 }),
        createMockPage({ page: 3, avgConfidence: 0.5 }),
      ];

      const lowConf = scorer.filter(pages, { maxConfidence: 0.8 });
      expect(lowConf.length).toBe(2);
      expect(lowConf.map(p => p.page)).toEqual([2, 3]);

      const highConf = scorer.filter(pages, { minConfidence: 0.9 });
      expect(highConf.length).toBe(1);
      expect(highConf[0].page).toBe(1);
    });

    it('should filter by table count', () => {
      const tables = [
        createMockTable({ page_number: 1 }),
        createMockTable({ page_number: 2, id: 't2' }),
        createMockTable({ page_number: 2, id: 't3' }),
      ];
      scorer.loadTables(tables);

      const pages = [
        createMockPage({ page: 1 }),
        createMockPage({ page: 2 }),
        createMockPage({ page: 3 }),
      ];

      const withTables = scorer.filter(pages, { minTables: 1 });
      expect(withTables.length).toBe(2);

      const manyTables = scorer.filter(pages, { minTables: 2 });
      expect(manyTables.length).toBe(1);
      expect(manyTables[0].page).toBe(2);

      const noTables = scorer.filter(pages, { maxTables: 0 });
      expect(noTables.length).toBe(1);
      expect(noTables[0].page).toBe(3);
    });

    it('should filter by coverage gaps', () => {
      const pages = [
        createMockPage({ page: 1, hasCoverageGaps: false }),
        createMockPage({ page: 2, hasCoverageGaps: true }),
      ];

      const withGaps = scorer.filter(pages, { hasGaps: true });
      expect(withGaps.length).toBe(1);
      expect(withGaps[0].page).toBe(2);

      const noGaps = scorer.filter(pages, { hasGaps: false });
      expect(noGaps.length).toBe(1);
      expect(noGaps[0].page).toBe(1);
    });
  });

  describe('getAutoApprovable', () => {
    it('should identify pages that can be auto-approved', () => {
      const pages = [
        createMockPage({ page: 1, avgConfidence: 0.98, status: 'pending', total: 0 }),
        createMockPage({ page: 2, avgConfidence: 0.85, status: 'pending', total: 0 }),  // Low conf
        createMockPage({ page: 3, avgConfidence: 0.98, status: 'complete', total: 0 }), // Already done
        createMockPage({ page: 4, avgConfidence: 0.98, status: 'pending', hasCoverageGaps: true }), // Has gaps
        createMockPage({ page: 5, avgConfidence: 0.98, status: 'pending', flagged: 1 }), // Has flagged
      ];

      // Add tables to page 1 to test table threshold
      scorer.loadTables([createMockTable({ page_number: 6 })]);
      pages.push(createMockPage({ page: 6, avgConfidence: 0.98, status: 'pending', total: 0 }));

      const autoApprovable = scorer.getAutoApprovable(pages);

      // Only page 1 should be auto-approvable (page 6 has tables)
      expect(autoApprovable.length).toBe(1);
      expect(autoApprovable[0].page).toBe(1);
    });
  });

  describe('getRequireReview', () => {
    it('should identify pages that need human review', () => {
      const tables = [createMockTable({ page_number: 3 })];
      scorer.loadTables(tables);

      const pages = [
        createMockPage({ page: 1, avgConfidence: 0.98 }),  // High conf, no issues
        createMockPage({ page: 2, avgConfidence: 0.5 }),   // Low confidence
        createMockPage({ page: 3, avgConfidence: 0.95 }), // Has table
        createMockPage({ page: 4, hasCoverageGaps: true }), // Has gaps
        createMockPage({ page: 5, flagged: 2 }),           // Has flagged
      ];

      const needsReview = scorer.getRequireReview(pages);

      // Pages 2, 3, 4, 5 should need review
      expect(needsReview.length).toBe(4);
      expect(needsReview.map(p => p.page)).not.toContain(1);
    });
  });

  describe('computeStats', () => {
    it('should compute accurate statistics', () => {
      const tables = [
        createMockTable({ page_number: 1 }),
        createMockTable({ page_number: 2, id: 't2' }),
        createMockTable({ page_number: 2, id: 't3' }),
      ];
      scorer.loadTables(tables);

      const pages = [
        createMockPage({ page: 1, status: 'pending', avgConfidence: 0.95 }),
        createMockPage({ page: 2, status: 'pending', avgConfidence: 0.6 }),
        createMockPage({ page: 3, status: 'complete', avgConfidence: 0.9 }),
        createMockPage({ page: 4, status: 'flagged', avgConfidence: 0.4, hasCoverageGaps: true }),
      ];

      const stats = scorer.computeStats(pages);

      expect(stats.totalPages).toBe(4);
      expect(stats.pagesWithTables).toBe(2);
      expect(stats.totalTables).toBe(3);
      expect(stats.avgConfidence).toBeCloseTo(0.7125, 2);
      expect(stats.lowConfidencePages).toBe(2); // Pages with conf < 0.7
      expect(stats.pagesWithGaps).toBe(1);
      expect(stats.byStatus).toEqual({
        pending: 2,
        complete: 1,
        flagged: 1,
      });
    });
  });
});

// ============================================================================
// Scoring Strategy Tests
// ============================================================================

describe('Scoring Strategies', () => {
  it('should create scorer with direct strategy (ignores tables)', () => {
    const scorer = createScorer('direct');
    const tables = [createMockTable({ page_number: 1 })];
    scorer.loadTables(tables);

    const page = createMockPage({ page: 1, avgConfidence: 0.8 });
    const result = scorer.scorePage(page);

    expect(result.breakdown.tableScore).toBe(0);
    expect(result.breakdown.structureScore).toBe(0);
  });

  it('should create scorer with structure strategy (emphasizes tables)', () => {
    const scorer = createScorer('structure');
    const tables = [createMockTable({ page_number: 1 })];
    scorer.loadTables(tables);

    const page = createMockPage({ page: 1 });
    const result = scorer.scorePage(page);

    // Structure strategy has tableCount weight of 20 vs default 10
    expect(result.breakdown.tableScore).toBe(20);
  });

  it('should create scorer with comparison strategy', () => {
    const scorer = createScorer('comparison');
    const result = scorer.scorePage(createMockPage());

    // Comparison strategy has lower table weight
    expect(result.score).toBeDefined();
  });
});

// ============================================================================
// OCR vs Markdown Comparison Tests
// ============================================================================

describe('compareOcrToMarkdown', () => {
  it('should detect minimal difference for matching content', () => {
    const ocrBlocks: OcrBlock[] = [
      { text: 'Hello World', confidence: 0.95 },
      { text: 'This is a test.', confidence: 0.90 },
    ];
    const markdown = 'Hello World\n\nThis is a test.';

    const result = compareOcrToMarkdown(ocrBlocks, markdown);

    expect(result.deltaPct).toBeLessThan(0.1);
    expect(result.flags).not.toContain('high_char_delta');
  });

  it('should detect significant difference when content differs', () => {
    const ocrBlocks: OcrBlock[] = [
      { text: 'This is a very long paragraph with lots of content that was captured by OCR.', confidence: 0.85 },
    ];
    const markdown = 'Short.';

    const result = compareOcrToMarkdown(ocrBlocks, markdown);

    expect(result.deltaPct).toBeGreaterThan(0.5);
    expect(result.flags).toContain('high_char_delta');
  });

  it('should evaluate spatial integrity', () => {
    const ocrBlocks: OcrBlock[] = [
      { text: 'Line 1', bbox: { x: 0, y: 0, width: 100, height: 20 }, confidence: 0.9 },
      { text: 'Line 2', bbox: { x: 0, y: 30, width: 100, height: 20 }, confidence: 0.9 },
      { text: 'Line 3', bbox: { x: 0, y: 60, width: 100, height: 20 }, confidence: 0.9 },
    ];
    const markdown = 'Line 1\n\nLine 2\n\nLine 3';

    const result = compareOcrToMarkdown(ocrBlocks, markdown);

    expect(result.spatialIntegrity).toBeGreaterThan(0.5);
  });

  it('should evaluate table structure preservation', () => {
    const ocrBlocks: OcrBlock[] = [
      { text: 'Col1', bbox: { x: 50, y: 0, width: 50, height: 20 } },
      { text: 'Col2', bbox: { x: 150, y: 0, width: 50, height: 20 } },
      { text: 'A', bbox: { x: 50, y: 30, width: 50, height: 20 } },
      { text: 'B', bbox: { x: 150, y: 30, width: 50, height: 20 } },
    ];
    const markdown = '| Col1 | Col2 |\n|------|------|\n| A | B |';

    const result = compareOcrToMarkdown(ocrBlocks, markdown);

    expect(result.tableStructureScore).toBeGreaterThan(0.5);
  });

  it('should flag missing OCR', () => {
    const ocrBlocks: OcrBlock[] = [];
    const markdown = 'Some content that exists in markdown but not OCR';

    const result = compareOcrToMarkdown(ocrBlocks, markdown);

    expect(result.flags).toContain('missing_ocr');
  });

  it('should flag missing markdown', () => {
    const ocrBlocks: OcrBlock[] = [
      { text: 'Content in OCR but not in markdown', confidence: 0.9 },
    ];
    const markdown = '';

    const result = compareOcrToMarkdown(ocrBlocks, markdown);

    expect(result.flags).toContain('missing_markdown');
  });
});

// ============================================================================
// JSON Parsing Tests
// ============================================================================

describe('JSON Parsing', () => {
  it('should parse pages JSON array', () => {
    const json = JSON.stringify([
      { page: 1, status: 'pending', avgConfidence: 0.9, total: 0, verified: 0, pending: 0, flagged: 0, rejected: 0, hasOcr: true, ocrLineCount: 50, hasCoverageGaps: false, uncoveredCount: 0, resolution: null, classification: null, isStale: false },
    ]);

    const pages = parsePagesJson(json);

    expect(pages.length).toBe(1);
    expect(pages[0].page).toBe(1);
  });

  it('should parse pages JSON object with pages key', () => {
    const json = JSON.stringify({
      pages: [{ page: 1, status: 'pending', avgConfidence: 0.9, total: 0, verified: 0, pending: 0, flagged: 0, rejected: 0, hasOcr: true, ocrLineCount: 50, hasCoverageGaps: false, uncoveredCount: 0, resolution: null, classification: null, isStale: false }],
    });

    const pages = parsePagesJson(json);

    expect(pages.length).toBe(1);
  });

  it('should parse tables JSON array', () => {
    const json = JSON.stringify([
      { id: 't1', page_number: 1, markdown: '| A |', verification_status: 'pending' },
    ]);

    const tables = parseTablesJson(json);

    expect(tables.length).toBe(1);
    expect(tables[0].id).toBe('t1');
  });

  it('should parse tables JSON object with tables key', () => {
    const json = JSON.stringify({
      tables: [{ id: 't1', page_number: 1, markdown: '| A |', verification_status: 'pending' }],
    });

    const tables = parseTablesJson(json);

    expect(tables.length).toBe(1);
  });
});

// ============================================================================
// Output Formatting Tests
// ============================================================================

describe('Output Formatting', () => {
  const sampleScored: ScoredPage[] = [
    {
      page: 1,
      score: 45.5,
      breakdown: { tableScore: 20, confidenceScore: 15.5, coverageScore: 0, flaggedScore: 0, structureScore: 10, comparisonScore: 0 },
      tableCount: 2,
      avgConfidence: 0.69,
      status: 'pending',
      flags: ['has_tables', 'low_confidence'],
    },
    {
      page: 2,
      score: 10,
      breakdown: { tableScore: 0, confidenceScore: 5, coverageScore: 0, flaggedScore: 0, structureScore: 5, comparisonScore: 0 },
      tableCount: 0,
      avgConfidence: 0.9,
      status: 'complete',
      flags: [],
    },
  ];

  it('should format as JSON', () => {
    const output = formatScoredPages(sampleScored, 'json');
    const parsed = JSON.parse(output);

    expect(parsed).toBeInstanceOf(Array);
    expect(parsed.length).toBe(2);
    expect(parsed[0].page).toBe(1);
  });

  it('should format as JSONL', () => {
    const output = formatScoredPages(sampleScored, 'jsonl');
    const lines = output.split('\n');

    expect(lines.length).toBe(2);
    expect(JSON.parse(lines[0]).page).toBe(1);
    expect(JSON.parse(lines[1]).page).toBe(2);
  });

  it('should format as CSV', () => {
    const output = formatScoredPages(sampleScored, 'csv');
    const lines = output.split('\n');

    expect(lines[0]).toBe('page,score,tableCount,avgConfidence,status,flags');
    expect(lines[1]).toContain('1');
    expect(lines[1]).toContain('45.50');
  });

  it('should format as table', () => {
    const output = formatScoredPages(sampleScored, 'table');

    expect(output).toContain('Page');
    expect(output).toContain('Score');
    expect(output).toContain('Tables');
    expect(output).toContain('has_tables');
  });
});

describe('Stats Formatting', () => {
  it('should format stats as JSON', () => {
    const stats = {
      totalPages: 100,
      pagesWithTables: 20,
      totalTables: 45,
      avgConfidence: 0.85,
      lowConfidencePages: 10,
      pagesWithGaps: 5,
      byStatus: { pending: 50, complete: 40, flagged: 10 },
      byPriority: { high: 5, medium: 15, low: 80 },
      estimatedReviewTime: { pages: 20, minutes: 25 },
    };

    const output = formatStats(stats, 'json');
    const parsed = JSON.parse(output);

    expect(parsed.totalPages).toBe(100);
    expect(parsed.byPriority.high).toBe(5);
  });

  it('should format stats as table', () => {
    const stats = {
      totalPages: 100,
      pagesWithTables: 20,
      totalTables: 45,
      avgConfidence: 0.85,
      lowConfidencePages: 10,
      pagesWithGaps: 5,
      byStatus: { pending: 50, complete: 40, flagged: 10 },
      byPriority: { high: 5, medium: 15, low: 80 },
      estimatedReviewTime: { pages: 20, minutes: 25 },
    };

    const output = formatStats(stats, 'table');

    expect(output).toContain('Total pages: 100');
    expect(output).toContain('Pages with tables: 20');
    expect(output).toContain('High (score >= 50): 5 pages');
    expect(output).toContain('Estimated review: 20 pages');
  });
});

// ============================================================================
// Workflow Integration Tests
// ============================================================================

describe('Workflow Integration', () => {
  it('should complete full table-priority workflow', () => {
    // Simulate a 50-page document with varying characteristics
    const pages: PageData[] = [];
    const tables: TableData[] = [];

    for (let i = 1; i <= 50; i++) {
      // Deterministic pseudo-random spread over [0.5, 0.99] — NOT Math.random(): the
      // unseeded version failed ~3% of runs (when no candidate page cleared the 0.95
      // auto-approve threshold), which surfaced as an intermittent full-suite "flake".
      // 37 is coprime with 50, so this cycles the whole [0,50) range; page 4 → 0.98
      // guarantees at least one auto-approvable page.
      const confidence = 0.5 + ((i * 37) % 50) / 100; // 0.5 - 0.99, deterministic
      const hasTables = i % 5 === 0; // Every 5th page has tables
      const hasGaps = i % 10 === 0; // Every 10th page has gaps

      pages.push(createMockPage({
        page: i,
        avgConfidence: confidence,
        hasCoverageGaps: hasGaps,
        status: i <= 40 ? 'pending' : 'complete',
      }));

      if (hasTables) {
        tables.push(createMockTable({ page_number: i, id: `table-${i}` }));
        if (i % 15 === 0) {
          // Some pages have multiple tables
          tables.push(createMockTable({ page_number: i, id: `table-${i}-2` }));
        }
      }
    }

    const scorer = new OcrReviewScorer();
    scorer.loadTables(tables);

    // Step 1: Get statistics
    const stats = scorer.computeStats(pages);
    expect(stats.totalPages).toBe(50);
    expect(stats.pagesWithTables).toBe(10); // 50/5 = 10 pages with tables

    // Step 2: Get auto-approvable pages (high confidence, no tables, no issues)
    const autoApprovable = scorer.getAutoApprovable(pages);
    expect(autoApprovable.length).toBeGreaterThan(0);

    // Step 3: Get pages requiring review
    const needsReview = scorer.getRequireReview(pages);
    expect(needsReview.length).toBeGreaterThan(0);

    // Step 4: Score all and verify priority ordering
    const scored = scorer.scoreAll(pages);
    expect(scored[0].score).toBeGreaterThanOrEqual(scored[scored.length - 1].score);

    // Step 5: Filter for table-heavy pages
    const tablePages = scorer.filter(pages, { minTables: 1 });
    expect(tablePages.length).toBe(10);

    // Verify the highest priority pages have tables or low confidence
    const topPriority = scored.slice(0, 5);
    for (const page of topPriority) {
      const hasIssue = page.tableCount > 0 ||
                       page.avgConfidence < 0.7 ||
                       page.flags.includes('coverage_gaps');
      expect(hasIssue).toBe(true);
    }
  });

  it('should complete OCR comparison workflow', () => {
    const ocrBlocks = createMockOcrBlocks();
    const markdown = `# Header Text

First paragraph content here.

| Table cell 1 | Table cell 2 |
|--------------|--------------|`;

    const comparison = compareOcrToMarkdown(ocrBlocks, markdown);

    // Should detect reasonable similarity
    expect(comparison.deltaPct).toBeLessThan(0.5);
    expect(comparison.spatialIntegrity).toBeGreaterThan(0);
    expect(comparison.tableStructureScore).toBeGreaterThan(0.5);
  });

  it('should handle empty document gracefully', () => {
    const scorer = new OcrReviewScorer();
    scorer.loadTables([]);

    const pages: PageData[] = [];
    const stats = scorer.computeStats(pages);

    expect(stats.totalPages).toBe(0);
    expect(stats.avgConfidence).toBe(0);
    expect(stats.byPriority).toEqual({ high: 0, medium: 0, low: 0 });
  });

  it('should handle all pages with tables', () => {
    const pages = [
      createMockPage({ page: 1 }),
      createMockPage({ page: 2 }),
      createMockPage({ page: 3 }),
    ];
    const tables = [
      createMockTable({ page_number: 1 }),
      createMockTable({ page_number: 2 }),
      createMockTable({ page_number: 3 }),
    ];

    const scorer = new OcrReviewScorer();
    scorer.loadTables(tables);

    const autoApprovable = scorer.getAutoApprovable(pages);
    expect(autoApprovable.length).toBe(0); // All have tables

    const needsReview = scorer.getRequireReview(pages);
    expect(needsReview.length).toBe(3);
  });
});

// ============================================================================
// Custom Configuration Tests
// ============================================================================

describe('Custom Configuration', () => {
  it('should apply custom weights', () => {
    const scorer = new OcrReviewScorer({
      weights: {
        tableCount: 100, // Much higher table weight
        inverseConfidence: 10,
        coverageGap: 5,
        flaggedEntity: 5,
        structurePenalty: 5,
        comparisonDelta: 5,
      },
    });

    const tables = [createMockTable({ page_number: 1 })];
    scorer.loadTables(tables);

    const page = createMockPage({ page: 1 });
    const result = scorer.scorePage(page);

    expect(result.breakdown.tableScore).toBe(100);
  });

  it('should apply custom thresholds', () => {
    const scorer = new OcrReviewScorer({
      thresholds: {
        autoApproveConfidence: 0.99, // Very strict
        requireReviewConfidence: 0.9,
        maxTablesForAutoApprove: 0,
        minOcrLinesForContent: 5,
      },
    });

    const pages = [
      createMockPage({ page: 1, avgConfidence: 0.98, status: 'pending' }),
      createMockPage({ page: 2, avgConfidence: 0.995, status: 'pending' }),
    ];

    const autoApprovable = scorer.getAutoApprovable(pages);
    expect(autoApprovable.length).toBe(1);
    expect(autoApprovable[0].page).toBe(2); // Only 0.995 passes 0.99 threshold
  });
});

// ============================================================================
// Financial Verification Tests
// ============================================================================

describe('Financial Verification', () => {
  describe('getConfidenceTier', () => {
    it('should categorize high confidence as auto_approve', () => {
      expect(getConfidenceTier(0.96)).toBe('auto_approve');
      expect(getConfidenceTier(0.99)).toBe('auto_approve');
      expect(getConfidenceTier(1.0)).toBe('auto_approve');
    });

    it('should categorize medium confidence as spot_check', () => {
      expect(getConfidenceTier(0.70)).toBe('spot_check');
      expect(getConfidenceTier(0.85)).toBe('spot_check');
      expect(getConfidenceTier(0.94)).toBe('spot_check');
    });

    it('should categorize low confidence as manual_review', () => {
      expect(getConfidenceTier(0.69)).toBe('manual_review');
      expect(getConfidenceTier(0.50)).toBe('manual_review');
      expect(getConfidenceTier(0.0)).toBe('manual_review');
    });
  });

  describe('categorizeByConfidence', () => {
    it('should categorize pages into tiers', () => {
      const pages = [
        createMockPage({ page: 1, avgConfidence: 0.98 }),
        createMockPage({ page: 2, avgConfidence: 0.85 }),
        createMockPage({ page: 3, avgConfidence: 0.60 }),
        createMockPage({ page: 4, avgConfidence: 0.75 }),
        createMockPage({ page: 5, avgConfidence: 0.96 }),
      ];

      const categorized = categorizeByConfidence(pages);

      expect(categorized.auto_approve.length).toBe(2); // pages 1, 5
      expect(categorized.spot_check.length).toBe(2);   // pages 2, 4
      expect(categorized.manual_review.length).toBe(1); // page 3
    });
  });

  describe('runCheckSums', () => {
    it('should validate balance sheet identity', () => {
      // Valid balance sheet: Assets = Liabilities + Equity
      const validValues = {
        total_assets: 1000000,
        total_liabilities: 600000,
        equity: 400000,
      };

      const results = runCheckSums(validValues);
      const balanceSheet = results.find(r => r.rule.name === 'Balance Sheet Identity');

      expect(balanceSheet).toBeDefined();
      expect(balanceSheet!.result.passed).toBe(true);
    });

    it('should detect balance sheet imbalance', () => {
      // Invalid: Assets don't equal Liabilities + Equity
      const invalidValues = {
        total_assets: 1000000,
        total_liabilities: 600000,
        equity: 300000, // Should be 400000
      };

      const results = runCheckSums(invalidValues);
      const balanceSheet = results.find(r => r.rule.name === 'Balance Sheet Identity');

      expect(balanceSheet).toBeDefined();
      expect(balanceSheet!.result.passed).toBe(false);
      expect(balanceSheet!.result.tolerancePct).toBeGreaterThan(1);
    });

    it('should validate net income calculation', () => {
      const values = {
        total_revenue: 5000000,
        total_expenses: 4200000,
        net_income: 800000,
      };

      const results = runCheckSums(values);
      const netIncomeCheck = results.find(r => r.rule.name === 'Net Income Check');

      expect(netIncomeCheck).toBeDefined();
      expect(netIncomeCheck!.result.passed).toBe(true);
    });

    it('should allow small tolerance for rounding', () => {
      // 0.5% rounding difference should pass
      const values = {
        total_assets: 1000000,
        total_liabilities: 600000,
        equity: 405000, // 0.5% over
      };

      const results = runCheckSums(values);
      const balanceSheet = results.find(r => r.rule.name === 'Balance Sheet Identity');

      expect(balanceSheet!.result.passed).toBe(true);
    });

    it('should skip rules with insufficient data', () => {
      const values = {
        total_assets: 1000000, // Only one field
      };

      const results = runCheckSums(values);

      // Should not validate balance sheet without liabilities/equity
      expect(results.length).toBe(0);
    });
  });

  describe('detectAnomalies', () => {
    it('should detect decimal point error', () => {
      const historical = [
        { revenue: 5000000 },
        { revenue: 5200000 },
        { revenue: 4800000 },
      ];

      const current = {
        revenue: 50000, // Missing two zeros - 100x error
      };

      const anomalies = detectAnomalies(current, historical);

      expect(anomalies.length).toBe(1);
      expect(anomalies[0].field).toBe('revenue');
      expect(anomalies[0].possibleCause).toContain('decimal point error');
    });

    it('should not flag normal variance', () => {
      const historical = [
        { revenue: 5000000 },
        { revenue: 5200000 },
        { revenue: 4800000 },
      ];

      const current = {
        revenue: 5100000, // Normal year-over-year change
      };

      const anomalies = detectAnomalies(current, historical);

      expect(anomalies.length).toBe(0);
    });

    it('should handle insufficient historical data', () => {
      const historical = [{ revenue: 5000000 }]; // Only one data point

      const current = { revenue: 50000 };

      const anomalies = detectAnomalies(current, historical);

      expect(anomalies.length).toBe(0); // Can't detect anomalies without enough history
    });

    it('should detect significant outliers', () => {
      const historical = [
        { profit: 100000 },
        { profit: 120000 },
        { profit: 110000 },
        { profit: 105000 },
      ];

      const current = {
        profit: 1000000, // 10x higher than historical
      };

      const anomalies = detectAnomalies(current, historical);

      expect(anomalies.length).toBe(1);
      expect(anomalies[0].zScore).toBeGreaterThan(3);
    });
  });

  describe('validateCrossQuery', () => {
    it('should validate total assets breakdown', () => {
      const values = {
        total_assets: 1000000,
        current_assets: 400000,
        non_current_assets: 600000,
      };

      const results = validateCrossQuery(values);
      const assetsCheck = results.find(r => r.rule.name === 'Total Assets Components');

      expect(assetsCheck).toBeDefined();
      expect(assetsCheck!.passed).toBe(true);
    });

    it('should detect missing component in total', () => {
      const values = {
        total_assets: 1000000,
        current_assets: 400000,
        // non_current_assets missing but total doesn't match
      };

      const results = validateCrossQuery(values);
      const assetsCheck = results.find(r => r.rule.name === 'Total Assets Components');

      expect(assetsCheck).toBeDefined();
      expect(assetsCheck!.passed).toBe(false);
      expect(assetsCheck!.differencePercent).toBeGreaterThan(2);
    });

    it('should allow tolerance for incomplete components', () => {
      const values = {
        total_revenue: 1000000,
        product_revenue: 800000,
        service_revenue: 180000,
        // other_revenue = 20000 is missing but within tolerance
      };

      const results = validateCrossQuery(values);
      const revenueCheck = results.find(r => r.rule.name === 'Total Revenue Components');

      expect(revenueCheck).toBeDefined();
      expect(revenueCheck!.passed).toBe(true); // Within 2% tolerance
    });
  });

  describe('runFinancialVerification', () => {
    it('should pass for valid financial data with high confidence', () => {
      const values = {
        total_assets: 1000000,
        total_liabilities: 600000,
        equity: 400000,
      };

      const report = runFinancialVerification(values, 0.98);

      expect(report.overallStatus).toBe('pass');
      expect(report.confidenceTier).toBe('auto_approve');
      expect(report.issues.length).toBe(0);
    });

    it('should fail for low confidence', () => {
      const values = {
        total_assets: 1000000,
        total_liabilities: 600000,
        equity: 400000,
      };

      const report = runFinancialVerification(values, 0.50);

      expect(report.overallStatus).toBe('fail');
      expect(report.confidenceTier).toBe('manual_review');
      expect(report.issues.some(i => i.includes('Low OCR confidence'))).toBe(true);
    });

    it('should fail for check-sum violations', () => {
      const values = {
        total_assets: 1000000,
        total_liabilities: 600000,
        equity: 200000, // Wrong!
      };

      const report = runFinancialVerification(values, 0.98);

      expect(report.overallStatus).toBe('fail');
      expect(report.issues.some(i => i.includes('Balance Sheet Identity failed'))).toBe(true);
    });

    it('should fail for anomalies with historical data', () => {
      const values = {
        revenue: 50000, // Should be ~5 million
      };

      const historical = [
        { revenue: 5000000 },
        { revenue: 5200000 },
        { revenue: 4800000 },
      ];

      const report = runFinancialVerification(values, 0.98, historical);

      expect(report.overallStatus).toBe('fail');
      expect(report.anomalies.length).toBe(1);
    });

    it('should provide recommendations for issues', () => {
      const values = {
        total_assets: 1000000,
        total_liabilities: 600000,
        equity: 200000,
      };

      const report = runFinancialVerification(values, 0.75);

      expect(report.recommendations.length).toBeGreaterThan(0);
      expect(report.recommendations.some(r => r.includes('spot-check'))).toBe(true);
    });
  });

  describe('formatVerificationReport', () => {
    it('should format passing report', () => {
      const values = {
        total_assets: 1000000,
        total_liabilities: 600000,
        equity: 400000,
      };

      const report = runFinancialVerification(values, 0.98);
      const formatted = formatVerificationReport(report);

      expect(formatted).toContain('Overall Status: PASS');
      expect(formatted).toContain('AUTO APPROVE');
    });

    it('should format failing report with details', () => {
      const values = {
        total_assets: 1000000,
        total_liabilities: 600000,
        equity: 200000,
      };

      const report = runFinancialVerification(values, 0.50);
      const formatted = formatVerificationReport(report);

      expect(formatted).toContain('Overall Status: FAIL');
      expect(formatted).toContain('Check-Sum Validations');
      expect(formatted).toContain('Issues:');
      expect(formatted).toContain('Recommendations:');
    });
  });
});

// ============================================================================
// End-to-End Financial Workflow Test
// ============================================================================

describe('Financial Document Review Workflow', () => {
  it('should complete full financial verification workflow', () => {
    // Simulate extracting data from a financial report

    // Step 1: OCR extracts pages with confidence scores
    const pages = [
      createMockPage({ page: 1, avgConfidence: 0.98, total: 2 }),  // Cover page
      createMockPage({ page: 2, avgConfidence: 0.92, total: 5 }),  // Balance sheet
      createMockPage({ page: 3, avgConfidence: 0.95, total: 4 }),  // Income statement
      createMockPage({ page: 4, avgConfidence: 0.65, total: 8 }),  // Notes (low quality)
      createMockPage({ page: 5, avgConfidence: 0.88, total: 3 }),  // Cash flow
    ];

    const tables = [
      createMockTable({ page_number: 2, id: 'balance-sheet-1' }),
      createMockTable({ page_number: 2, id: 'balance-sheet-2' }),
      createMockTable({ page_number: 3, id: 'income-statement' }),
      createMockTable({ page_number: 5, id: 'cash-flow' }),
    ];

    // Step 2: Categorize by confidence tier
    const categorized = categorizeByConfidence(pages);
    expect(categorized.auto_approve.length).toBe(2);  // Pages 1 (98%), 3 (95%)
    expect(categorized.spot_check.length).toBe(2);    // Pages 2, 5
    expect(categorized.manual_review.length).toBe(1); // Page 4 (65%)

    // Step 3: Score pages for review priority
    const scorer = new OcrReviewScorer();
    scorer.loadTables(tables);
    const scored = scorer.scoreAll(pages);

    // Highest priority pages should include those with low confidence or tables
    // Page 4 has lowest confidence (0.65), pages 2,3,5 have tables
    const topPriorityPages = scored.slice(0, 3).map(s => s.page);
    expect(topPriorityPages).toContain(4); // Low confidence page
    expect(topPriorityPages).toContain(2); // Has 2 tables

    // Step 4: Simulate extracted financial values
    const extractedValues = {
      total_assets: 10500000,
      current_assets: 3500000,
      non_current_assets: 7000000,
      total_liabilities: 6200000,
      current_liabilities: 2100000,
      non_current_liabilities: 4100000,
      equity: 4300000,
      working_capital: 1400000, // current_assets - current_liabilities
      total_revenue: 25000000,
      total_expenses: 22500000,
      net_income: 2500000,
    };

    // Step 5: Run financial verification
    const report = runFinancialVerification(extractedValues, 0.96);

    // Should pass - data is consistent and confidence is high enough
    expect(report.overallStatus).toBe('pass');
    expect(report.checkSums.every(c => c.result.passed)).toBe(true);

    // Step 6: Run cross-query validation
    const crossResults = validateCrossQuery(extractedValues);
    expect(crossResults.every(r => r.passed)).toBe(true);

    // Step 7: Test anomaly detection with historical data
    const historicalData = [
      { total_revenue: 24000000, net_income: 2400000 },
      { total_revenue: 23000000, net_income: 2300000 },
      { total_revenue: 22000000, net_income: 2200000 },
    ];

    const anomalies = detectAnomalies(extractedValues, historicalData);
    expect(anomalies.length).toBe(0); // No anomalies - growth is normal

    // Step 8: Format report for analyst
    const formatted = formatVerificationReport(report);
    expect(formatted).toContain('PASS');
  });

  it('should catch common OCR errors in financial data', () => {
    // Simulate OCR errors that commonly occur

    // Error 1: Decimal point shift
    const historicalRevenue = [
      { revenue: 5000000 },
      { revenue: 5200000 },
      { revenue: 4800000 },
    ];
    const decimalError = { revenue: 50000 }; // Missing 2 zeros

    const anomalies = detectAnomalies(decimalError, historicalRevenue);
    expect(anomalies.length).toBe(1);
    expect(anomalies[0].possibleCause).toContain('decimal point error');

    // Error 2: Balance sheet doesn't balance
    const unbalanced = {
      total_assets: 1000000,
      total_liabilities: 500000,
      equity: 400000, // Should be 500000
    };

    const checksumResults = runCheckSums(unbalanced);
    const balanceCheck = checksumResults.find(r => r.rule.name === 'Balance Sheet Identity');
    expect(balanceCheck!.result.passed).toBe(false);

    // Error 3: Components don't sum to total
    const missingComponent = {
      total_assets: 1000000,
      current_assets: 300000,
      // Missing non_current_assets that should be 700000
    };

    const crossResults = validateCrossQuery(missingComponent);
    const assetsCheck = crossResults.find(r => r.rule.name === 'Total Assets Components');
    expect(assetsCheck!.passed).toBe(false);
  });
});
