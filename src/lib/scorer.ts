/**
 * OCR Review Scorer - Deterministic scoring for prioritizing page review
 *
 * Composable scoring strategies inspired by document understanding research:
 * - Direct scoring: page-level metrics only
 * - Structure-aware: considers table density and layout
 * - Comparison-based: OCR layer vs rendered markdown
 *
 * Financial verification strategies from industry best practices:
 * - Cross-querying: verify related fields match (e.g., Assets = Liabilities + Equity)
 * - Check-sum logic: validate mathematical relationships between cells
 * - Confidence filtering: auto-approve >95%, spot-check 70-95%, manual <70%
 * - Anomaly detection: flag statistical outliers (e.g., decimal point errors)
 *
 * @see https://arxiv.org/html/2510.10138v1
 */

// ============================================================================
// Types
// ============================================================================

export interface PageData {
  page: number;
  status: string;
  total: number;
  verified: number;
  pending: number;
  flagged: number;
  rejected: number;
  avgConfidence: number;
  hasOcr: boolean;
  ocrLineCount: number;
  hasCoverageGaps: boolean;
  uncoveredCount: number;
  resolution: string | null;
  classification: string | null;
  isStale: boolean;
}

export interface TableData {
  id: string;
  page_number: number;
  markdown: string;
  verification_status: string;
  confidence?: number;
}

export interface OcrBlock {
  text: string;
  bbox?: { x: number; y: number; width: number; height: number };
  confidence?: number;
}

export interface ScoredPage {
  page: number;
  score: number;
  breakdown: ScoreBreakdown;
  tableCount: number;
  avgConfidence: number;
  status: string;
  flags: string[];
}

export interface ScoreBreakdown {
  tableScore: number;
  confidenceScore: number;
  coverageScore: number;
  flaggedScore: number;
  structureScore: number;
  comparisonScore: number;
}

export interface ScorerConfig {
  weights: ScorerWeights;
  thresholds: ScorerThresholds;
}

export interface ScorerWeights {
  tableCount: number;
  inverseConfidence: number;
  coverageGap: number;
  flaggedEntity: number;
  structurePenalty: number;
  comparisonDelta: number;
}

export interface ScorerThresholds {
  autoApproveConfidence: number;
  requireReviewConfidence: number;
  maxTablesForAutoApprove: number;
  minOcrLinesForContent: number;
}

export interface FilterOptions {
  status?: string | string[];
  minConfidence?: number;
  maxConfidence?: number;
  minTables?: number;
  maxTables?: number;
  hasGaps?: boolean;
  hasTables?: boolean;
  isStale?: boolean;
}

export interface ReviewStats {
  totalPages: number;
  pagesWithTables: number;
  totalTables: number;
  avgConfidence: number;
  lowConfidencePages: number;
  pagesWithGaps: number;
  byStatus: Record<string, number>;
  byPriority: { high: number; medium: number; low: number };
  estimatedReviewTime: { pages: number; minutes: number };
}

export interface ComparisonResult {
  page: number;
  ocrCharCount: number;
  markdownCharCount: number;
  delta: number;
  deltaPct: number;
  spatialIntegrity: number;
  tableStructureScore: number;
  flags: string[];
}

// ============================================================================
// Default Configuration
// ============================================================================

export const DEFAULT_CONFIG: ScorerConfig = {
  weights: {
    tableCount: 10,         // Points per table on page
    inverseConfidence: 50,  // Points for low confidence (scaled by 1-conf)
    coverageGap: 25,        // Points if page has coverage gaps
    flaggedEntity: 30,      // Points per flagged entity
    structurePenalty: 20,   // Points for structural issues
    comparisonDelta: 15,    // Points for OCR/markdown mismatch
  },
  thresholds: {
    autoApproveConfidence: 0.95,
    requireReviewConfidence: 0.7,
    maxTablesForAutoApprove: 0,
    minOcrLinesForContent: 5,
  },
};

// ============================================================================
// Core Scorer Class
// ============================================================================

export class OcrReviewScorer {
  private config: ScorerConfig;
  private tablesByPage: Map<number, TableData[]> = new Map();

  constructor(config: Partial<ScorerConfig> = {}) {
    this.config = {
      weights: { ...DEFAULT_CONFIG.weights, ...config.weights },
      thresholds: { ...DEFAULT_CONFIG.thresholds, ...config.thresholds },
    };
  }

  /**
   * Load table data for scoring
   */
  loadTables(tables: TableData[]): void {
    this.tablesByPage.clear();
    for (const table of tables) {
      const pageNum = table.page_number;
      if (!this.tablesByPage.has(pageNum)) {
        this.tablesByPage.set(pageNum, []);
      }
      this.tablesByPage.get(pageNum)!.push(table);
    }
  }

  /**
   * Score a single page - deterministic priority calculation
   */
  scorePage(page: PageData): ScoredPage {
    const tables = this.tablesByPage.get(page.page) || [];
    const tableCount = tables.length;
    const { weights } = this.config;

    // Calculate component scores
    const tableScore = tableCount * weights.tableCount;
    const confidenceScore = (1 - page.avgConfidence) * weights.inverseConfidence;
    const coverageScore = page.hasCoverageGaps ? weights.coverageGap : 0;
    const flaggedScore = page.flagged * weights.flaggedEntity;

    // Structure score: penalize pages with many entities but low verification
    const verificationRatio = page.total > 0 ? page.verified / page.total : 1;
    const structureScore = page.total > 0 ? (1 - verificationRatio) * weights.structurePenalty : 0;

    // Comparison score: placeholder for OCR vs markdown comparison
    const comparisonScore = 0; // Computed separately via compareOcrToMarkdown

    const breakdown: ScoreBreakdown = {
      tableScore,
      confidenceScore,
      coverageScore,
      flaggedScore,
      structureScore,
      comparisonScore,
    };

    const score = tableScore + confidenceScore + coverageScore + flaggedScore + structureScore;

    // Generate flags for quick filtering
    const flags: string[] = [];
    if (tableCount > 0) flags.push('has_tables');
    if (page.avgConfidence < this.config.thresholds.requireReviewConfidence) flags.push('low_confidence');
    if (page.hasCoverageGaps) flags.push('coverage_gaps');
    if (page.flagged > 0) flags.push('has_flagged');
    if (page.isStale) flags.push('stale');
    if (tables.some(t => t.verification_status === 'flagged')) flags.push('flagged_table');

    return {
      page: page.page,
      score,
      breakdown,
      tableCount,
      avgConfidence: page.avgConfidence,
      status: page.status,
      flags,
    };
  }

  /**
   * Score all pages and return sorted by priority (highest first)
   */
  scoreAll(pages: PageData[]): ScoredPage[] {
    return pages
      .map(p => this.scorePage(p))
      .sort((a, b) => b.score - a.score);
  }

  /**
   * Filter pages by criteria before scoring
   */
  filter(pages: PageData[], options: FilterOptions): PageData[] {
    return pages.filter(page => {
      const tableCount = (this.tablesByPage.get(page.page) || []).length;

      if (options.status) {
        const statuses = Array.isArray(options.status) ? options.status : [options.status];
        if (!statuses.includes(page.status)) return false;
      }

      if (options.minConfidence !== undefined && page.avgConfidence < options.minConfidence) {
        return false;
      }
      if (options.maxConfidence !== undefined && page.avgConfidence > options.maxConfidence) {
        return false;
      }
      if (options.minTables !== undefined && tableCount < options.minTables) {
        return false;
      }
      if (options.maxTables !== undefined && tableCount > options.maxTables) {
        return false;
      }
      if (options.hasGaps === true && !page.hasCoverageGaps) {
        return false;
      }
      if (options.hasGaps === false && page.hasCoverageGaps) {
        return false;
      }
      if (options.hasTables === true && tableCount === 0) {
        return false;
      }
      if (options.hasTables === false && tableCount > 0) {
        return false;
      }
      if (options.isStale !== undefined && page.isStale !== options.isStale) {
        return false;
      }

      return true;
    });
  }

  /**
   * Get pages eligible for auto-approval
   */
  getAutoApprovable(pages: PageData[]): PageData[] {
    const { thresholds } = this.config;
    return pages.filter(page => {
      const tableCount = (this.tablesByPage.get(page.page) || []).length;
      return (
        page.avgConfidence >= thresholds.autoApproveConfidence &&
        tableCount <= thresholds.maxTablesForAutoApprove &&
        page.status === 'pending' &&
        !page.hasCoverageGaps &&
        page.flagged === 0
      );
    });
  }

  /**
   * Get pages that require human review
   */
  getRequireReview(pages: PageData[]): ScoredPage[] {
    const { thresholds } = this.config;
    const needsReview = pages.filter(page => {
      const tableCount = (this.tablesByPage.get(page.page) || []).length;
      return (
        page.avgConfidence < thresholds.requireReviewConfidence ||
        tableCount > 0 ||
        page.hasCoverageGaps ||
        page.flagged > 0
      );
    });
    return this.scoreAll(needsReview);
  }

  /**
   * Compute review statistics
   */
  computeStats(pages: PageData[]): ReviewStats {
    const scored = this.scoreAll(pages);
    const pagesWithTables = pages.filter(p => (this.tablesByPage.get(p.page) || []).length > 0);

    let totalTables = 0;
    this.tablesByPage.forEach(tables => {
      totalTables += tables.length;
    });

    const avgConfidence = pages.length > 0
      ? pages.reduce((sum, p) => sum + p.avgConfidence, 0) / pages.length
      : 0;

    const lowConfidencePages = pages.filter(
      p => p.avgConfidence < this.config.thresholds.requireReviewConfidence
    ).length;

    const pagesWithGaps = pages.filter(p => p.hasCoverageGaps).length;

    const byStatus: Record<string, number> = {};
    for (const page of pages) {
      byStatus[page.status] = (byStatus[page.status] || 0) + 1;
    }

    const HIGH_THRESHOLD = 50;
    const MEDIUM_THRESHOLD = 20;
    const byPriority = {
      high: scored.filter(s => s.score >= HIGH_THRESHOLD).length,
      medium: scored.filter(s => s.score >= MEDIUM_THRESHOLD && s.score < HIGH_THRESHOLD).length,
      low: scored.filter(s => s.score < MEDIUM_THRESHOLD).length,
    };

    // Estimate 2 min per high priority, 1 min per medium, 0 for low (auto-approve)
    const estimatedMinutes = byPriority.high * 2 + byPriority.medium * 1;

    return {
      totalPages: pages.length,
      pagesWithTables: pagesWithTables.length,
      totalTables,
      avgConfidence,
      lowConfidencePages,
      pagesWithGaps,
      byStatus,
      byPriority,
      estimatedReviewTime: {
        pages: byPriority.high + byPriority.medium,
        minutes: estimatedMinutes,
      },
    };
  }
}

// ============================================================================
// OCR vs Markdown Comparison (Composable Strategy)
// ============================================================================

/**
 * Compare OCR text blocks to rendered markdown for quality assessment
 * Inspired by spatial structure preservation evaluation
 */
export function compareOcrToMarkdown(
  ocrBlocks: OcrBlock[],
  markdownContent: string
): ComparisonResult & { score: number } {
  // Extract text from OCR blocks
  const ocrText = ocrBlocks.map(b => b.text).join(' ');
  const ocrCharCount = ocrText.replace(/\s+/g, '').length;

  // Clean markdown for comparison
  const cleanMarkdown = markdownContent
    .replace(/[#*_\[\]()|\-]+/g, ' ')  // Remove markdown syntax
    .replace(/\s+/g, ' ')
    .trim();
  const markdownCharCount = cleanMarkdown.replace(/\s+/g, '').length;

  // Character delta
  const delta = Math.abs(ocrCharCount - markdownCharCount);
  const maxChars = Math.max(ocrCharCount, markdownCharCount, 1);
  const deltaPct = delta / maxChars;

  // Spatial integrity: check if block positions are preserved
  // Higher score = better spatial preservation
  const sortedBlocks = [...ocrBlocks].sort((a, b) => {
    if (!a.bbox || !b.bbox) return 0;
    return a.bbox.y - b.bbox.y || a.bbox.x - b.bbox.x;
  });
  const spatialText = sortedBlocks.map(b => b.text).join(' ');
  const spatialIntegrity = computeStringSimilarity(spatialText, cleanMarkdown);

  // Table structure score: check if table delimiters are preserved
  const tableStructureScore = computeTableStructureScore(ocrBlocks, markdownContent);

  // Generate comparison flags
  const flags: string[] = [];
  if (deltaPct > 0.2) flags.push('high_char_delta');
  if (spatialIntegrity < 0.7) flags.push('spatial_mismatch');
  if (tableStructureScore < 0.5) flags.push('table_structure_issue');
  if (ocrCharCount === 0 && markdownCharCount > 0) flags.push('missing_ocr');
  if (markdownCharCount === 0 && ocrCharCount > 0) flags.push('missing_markdown');

  // Composite score: lower is better (0 = perfect match)
  const score = (deltaPct * 40) + ((1 - spatialIntegrity) * 35) + ((1 - tableStructureScore) * 25);

  return {
    page: 0, // Caller should set
    ocrCharCount,
    markdownCharCount,
    delta,
    deltaPct,
    spatialIntegrity,
    tableStructureScore,
    flags,
    score,
  };
}

/**
 * Simple string similarity using bigrams (Dice coefficient)
 */
function computeStringSimilarity(a: string, b: string): number {
  if (a.length === 0 && b.length === 0) return 1;
  if (a.length < 2 || b.length < 2) return a === b ? 1 : 0;

  const bigramsA = new Set<string>();
  for (let i = 0; i < a.length - 1; i++) {
    bigramsA.add(a.slice(i, i + 2).toLowerCase());
  }

  const bigramsB = new Set<string>();
  for (let i = 0; i < b.length - 1; i++) {
    bigramsB.add(b.slice(i, i + 2).toLowerCase());
  }

  let intersection = 0;
  bigramsA.forEach(bg => {
    if (bigramsB.has(bg)) intersection++;
  });

  return (2 * intersection) / (bigramsA.size + bigramsB.size);
}

/**
 * Evaluate table structure preservation
 */
function computeTableStructureScore(ocrBlocks: OcrBlock[], markdown: string): number {
  // Check for table-like patterns in markdown
  const hasMarkdownTable = /\|.*\|/.test(markdown);
  if (!hasMarkdownTable) return 1; // No table to evaluate

  // Count table delimiters
  const pipeCount = (markdown.match(/\|/g) || []).length;
  const dashCount = (markdown.match(/-{3,}/g) || []).length;

  // Check if OCR captured tabular structure
  const ocrText = ocrBlocks.map(b => b.text).join('\n');
  const ocrHasColumns = ocrBlocks.length > 3 && ocrBlocks.some(b => b.bbox && b.bbox.x > 100);

  // Score based on structure indicators
  let score = 0.5; // Base score
  if (pipeCount > 4) score += 0.2;
  if (dashCount > 0) score += 0.15;
  if (ocrHasColumns) score += 0.15;

  return Math.min(score, 1);
}

// ============================================================================
// Composable Scoring Strategies
// ============================================================================

export type ScoringStrategy = 'direct' | 'structure' | 'comparison' | 'combined';

/**
 * Create a scorer with a specific strategy
 */
export function createScorer(
  strategy: ScoringStrategy,
  config: Partial<ScorerConfig> = {}
): OcrReviewScorer {
  const strategyConfig = { ...config };

  switch (strategy) {
    case 'direct':
      // Page-level metrics only, no structure analysis
      strategyConfig.weights = {
        ...DEFAULT_CONFIG.weights,
        tableCount: 0,
        structurePenalty: 0,
        ...config.weights,
      };
      break;

    case 'structure':
      // Emphasize table and structure analysis
      strategyConfig.weights = {
        ...DEFAULT_CONFIG.weights,
        tableCount: 20,
        structurePenalty: 30,
        inverseConfidence: 30,
        ...config.weights,
      };
      break;

    case 'comparison':
      // Emphasize OCR vs markdown comparison
      strategyConfig.weights = {
        ...DEFAULT_CONFIG.weights,
        comparisonDelta: 40,
        tableCount: 5,
        ...config.weights,
      };
      break;

    case 'combined':
    default:
      // Balanced approach
      break;
  }

  return new OcrReviewScorer(strategyConfig);
}

// ============================================================================
// Utility Functions for CLI Integration
// ============================================================================

/**
 * Parse pages JSON from CLI output
 */
export function parsePagesJson(json: string): PageData[] {
  const data = JSON.parse(json);
  return Array.isArray(data) ? data : data.pages || [];
}

/**
 * Parse tables JSON from CLI output
 */
export function parseTablesJson(json: string): TableData[] {
  const data = JSON.parse(json);
  return Array.isArray(data) ? data : data.tables || [];
}

/**
 * Format scored pages for output
 */
export function formatScoredPages(
  pages: ScoredPage[],
  format: 'json' | 'jsonl' | 'table' | 'csv' = 'table'
): string {
  switch (format) {
    case 'json':
      return JSON.stringify(pages, null, 2);

    case 'jsonl':
      return pages.map(p => JSON.stringify(p)).join('\n');

    case 'csv':
      const headers = ['page', 'score', 'tableCount', 'avgConfidence', 'status', 'flags'];
      const rows = pages.map(p => [
        p.page,
        p.score.toFixed(2),
        p.tableCount,
        (p.avgConfidence * 100).toFixed(1) + '%',
        p.status,
        p.flags.join(';'),
      ]);
      return [headers.join(','), ...rows.map(r => r.join(','))].join('\n');

    case 'table':
    default:
      const colWidths = { page: 6, score: 8, tables: 8, conf: 8, status: 12, flags: 30 };
      const header = [
        'Page'.padEnd(colWidths.page),
        'Score'.padEnd(colWidths.score),
        'Tables'.padEnd(colWidths.tables),
        'Conf'.padEnd(colWidths.conf),
        'Status'.padEnd(colWidths.status),
        'Flags',
      ].join('  ');
      const divider = '-'.repeat(header.length);
      const tableRows = pages.map(p => [
        String(p.page).padEnd(colWidths.page),
        p.score.toFixed(1).padEnd(colWidths.score),
        String(p.tableCount).padEnd(colWidths.tables),
        ((p.avgConfidence * 100).toFixed(0) + '%').padEnd(colWidths.conf),
        p.status.padEnd(colWidths.status),
        p.flags.slice(0, 3).join(', '),
      ].join('  '));
      return [header, divider, ...tableRows].join('\n');
  }
}

/**
 * Format stats for output
 */
export function formatStats(stats: ReviewStats, format: 'json' | 'table' = 'table'): string {
  if (format === 'json') {
    return JSON.stringify(stats, null, 2);
  }

  const lines = [
    `Total pages: ${stats.totalPages}`,
    `Pages with tables: ${stats.pagesWithTables} (${(stats.pagesWithTables / stats.totalPages * 100).toFixed(1)}%)`,
    `Total tables: ${stats.totalTables}`,
    `Average confidence: ${(stats.avgConfidence * 100).toFixed(1)}%`,
    `Low confidence pages: ${stats.lowConfidencePages}`,
    `Pages with coverage gaps: ${stats.pagesWithGaps}`,
    '',
    'By Status:',
    ...Object.entries(stats.byStatus).map(([k, v]) => `  ${k}: ${v}`),
    '',
    'Review Priority:',
    `  High (score >= 50): ${stats.byPriority.high} pages`,
    `  Medium (score 20-49): ${stats.byPriority.medium} pages`,
    `  Low (score < 20): ${stats.byPriority.low} pages`,
    '',
    `Estimated review: ${stats.estimatedReviewTime.pages} pages, ~${stats.estimatedReviewTime.minutes} minutes`,
  ];

  return lines.join('\n');
}

// ============================================================================
// Financial Verification Strategies
// ============================================================================

/**
 * Confidence-based filtering thresholds
 * Based on industry best practices for financial document verification
 */
export const CONFIDENCE_TIERS = {
  AUTO_APPROVE: 0.95,    // Score > 95%: Auto-approve
  SPOT_CHECK: 0.70,      // Score 70%–95%: Spot-check
  MANUAL_REVIEW: 0.70,   // Score < 70%: Mandatory manual verification
} as const;

export type ConfidenceTier = 'auto_approve' | 'spot_check' | 'manual_review';

/**
 * Categorize a confidence score into action tiers
 */
export function getConfidenceTier(confidence: number): ConfidenceTier {
  if (confidence >= CONFIDENCE_TIERS.AUTO_APPROVE) return 'auto_approve';
  if (confidence >= CONFIDENCE_TIERS.SPOT_CHECK) return 'spot_check';
  return 'manual_review';
}

/**
 * Batch categorize pages by confidence tier
 */
export function categorizeByConfidence(pages: PageData[]): Record<ConfidenceTier, PageData[]> {
  const result: Record<ConfidenceTier, PageData[]> = {
    auto_approve: [],
    spot_check: [],
    manual_review: [],
  };

  for (const page of pages) {
    const tier = getConfidenceTier(page.avgConfidence);
    result[tier].push(page);
  }

  return result;
}

/**
 * Financial value extracted from a table cell
 */
export interface FinancialValue {
  label: string;
  value: number;
  page: number;
  tableId?: string;
  confidence?: number;
}

/**
 * Check-sum validation rule
 */
export interface CheckSumRule {
  name: string;
  formula: string;  // e.g., "Total Assets = Liabilities + Equity"
  fields: string[];
  validate: (values: Record<string, number>) => CheckSumResult;
}

export interface CheckSumResult {
  passed: boolean;
  expected: number;
  actual: number;
  difference: number;
  tolerancePct: number;
}

/**
 * Common financial check-sum rules
 */
export const FINANCIAL_CHECKSUMS: CheckSumRule[] = [
  {
    name: 'Balance Sheet Identity',
    formula: 'Total Assets = Total Liabilities + Equity',
    fields: ['total_assets', 'total_liabilities', 'equity', 'shareholders_equity'],
    validate: (v) => {
      const assets = v.total_assets || 0;
      const liabilities = v.total_liabilities || 0;
      const equity = v.equity || v.shareholders_equity || 0;
      const expected = liabilities + equity;
      const difference = Math.abs(assets - expected);
      const tolerancePct = assets > 0 ? (difference / assets) * 100 : 0;
      return {
        passed: tolerancePct < 1, // 1% tolerance for rounding
        expected,
        actual: assets,
        difference,
        tolerancePct,
      };
    },
  },
  {
    name: 'Net Income Check',
    formula: 'Net Income = Revenue - Expenses',
    fields: ['net_income', 'total_revenue', 'total_expenses'],
    validate: (v) => {
      const netIncome = v.net_income || 0;
      const revenue = v.total_revenue || 0;
      const expenses = v.total_expenses || 0;
      const expected = revenue - expenses;
      const difference = Math.abs(netIncome - expected);
      const tolerancePct = Math.abs(expected) > 0 ? (difference / Math.abs(expected)) * 100 : 0;
      return {
        passed: tolerancePct < 1,
        expected,
        actual: netIncome,
        difference,
        tolerancePct,
      };
    },
  },
  {
    name: 'Working Capital',
    formula: 'Working Capital = Current Assets - Current Liabilities',
    fields: ['working_capital', 'current_assets', 'current_liabilities'],
    validate: (v) => {
      const workingCapital = v.working_capital || 0;
      const currentAssets = v.current_assets || 0;
      const currentLiabilities = v.current_liabilities || 0;
      const expected = currentAssets - currentLiabilities;
      const difference = Math.abs(workingCapital - expected);
      const tolerancePct = Math.abs(expected) > 0 ? (difference / Math.abs(expected)) * 100 : 0;
      return {
        passed: tolerancePct < 1,
        expected,
        actual: workingCapital,
        difference,
        tolerancePct,
      };
    },
  },
];

/**
 * Run all applicable check-sum validations on extracted values
 */
export function runCheckSums(
  values: Record<string, number>,
  rules: CheckSumRule[] = FINANCIAL_CHECKSUMS
): Array<{ rule: CheckSumRule; result: CheckSumResult }> {
  const results: Array<{ rule: CheckSumRule; result: CheckSumResult }> = [];

  for (const rule of rules) {
    // Check if we have at least 2 of the required fields
    const presentFields = rule.fields.filter(f => values[f] !== undefined);
    if (presentFields.length >= 2) {
      results.push({
        rule,
        result: rule.validate(values),
      });
    }
  }

  return results;
}

/**
 * Anomaly detection result
 */
export interface AnomalyResult {
  field: string;
  currentValue: number;
  historicalMean: number;
  historicalStdDev: number;
  zScore: number;
  isAnomaly: boolean;
  possibleCause: string;
}

/**
 * Detect anomalies in extracted values using statistical analysis
 * Flags potential OCR errors like decimal point shifts
 */
export function detectAnomalies(
  currentValues: Record<string, number>,
  historicalValues: Array<Record<string, number>>,
  zScoreThreshold: number = 3.0
): AnomalyResult[] {
  const anomalies: AnomalyResult[] = [];

  if (historicalValues.length < 2) return anomalies;

  for (const [field, currentValue] of Object.entries(currentValues)) {
    const historicalData = historicalValues
      .map(h => h[field])
      .filter((v): v is number => v !== undefined);

    if (historicalData.length < 2) continue;

    // Calculate mean and standard deviation
    const mean = historicalData.reduce((a, b) => a + b, 0) / historicalData.length;
    const variance = historicalData.reduce((sum, val) => sum + Math.pow(val - mean, 2), 0) / historicalData.length;
    const stdDev = Math.sqrt(variance);

    // Calculate z-score
    const zScore = stdDev > 0 ? Math.abs(currentValue - mean) / stdDev : 0;

    if (zScore > zScoreThreshold) {
      // Try to identify the cause
      let possibleCause = 'Unexpected value';

      // Check for decimal point error (value is 10x, 100x, or 1000x off)
      const ratios = [10, 100, 1000, 0.1, 0.01, 0.001];
      for (const ratio of ratios) {
        const adjustedZScore = stdDev > 0 ? Math.abs((currentValue / ratio) - mean) / stdDev : 0;
        if (adjustedZScore < 1) {
          possibleCause = `Possible decimal point error (value appears to be ${ratio}x expected)`;
          break;
        }
      }

      // Check for sign error
      if (Math.abs((-currentValue) - mean) / stdDev < 1) {
        possibleCause = 'Possible sign error (negative vs positive)';
      }

      anomalies.push({
        field,
        currentValue,
        historicalMean: mean,
        historicalStdDev: stdDev,
        zScore,
        isAnomaly: true,
        possibleCause,
      });
    }
  }

  return anomalies;
}

/**
 * Cross-query validation - verify related fields match
 * e.g., verify Total = Sum of components
 */
export interface CrossQueryRule {
  name: string;
  totalField: string;
  componentFields: string[];
  tolerance: number; // Percentage tolerance
}

export const CROSS_QUERY_RULES: CrossQueryRule[] = [
  {
    name: 'Total Assets Components',
    totalField: 'total_assets',
    componentFields: ['current_assets', 'non_current_assets', 'fixed_assets', 'intangible_assets'],
    tolerance: 2,
  },
  {
    name: 'Total Revenue Components',
    totalField: 'total_revenue',
    componentFields: ['product_revenue', 'service_revenue', 'other_revenue'],
    tolerance: 2,
  },
  {
    name: 'Total Liabilities Components',
    totalField: 'total_liabilities',
    componentFields: ['current_liabilities', 'non_current_liabilities', 'long_term_debt'],
    tolerance: 2,
  },
];

export interface CrossQueryResult {
  rule: CrossQueryRule;
  passed: boolean;
  totalValue: number;
  componentSum: number;
  difference: number;
  differencePercent: number;
  presentComponents: string[];
}

/**
 * Validate that total fields match sum of their components
 */
export function validateCrossQuery(
  values: Record<string, number>,
  rules: CrossQueryRule[] = CROSS_QUERY_RULES
): CrossQueryResult[] {
  const results: CrossQueryResult[] = [];

  for (const rule of rules) {
    const totalValue = values[rule.totalField];
    if (totalValue === undefined) continue;

    const presentComponents = rule.componentFields.filter(f => values[f] !== undefined);
    if (presentComponents.length === 0) continue;

    const componentSum = presentComponents.reduce((sum, f) => sum + (values[f] || 0), 0);
    const difference = Math.abs(totalValue - componentSum);
    const differencePercent = totalValue > 0 ? (difference / totalValue) * 100 : 0;

    results.push({
      rule,
      passed: differencePercent <= rule.tolerance,
      totalValue,
      componentSum,
      difference,
      differencePercent,
      presentComponents,
    });
  }

  return results;
}

/**
 * Complete financial verification result
 */
export interface VerificationReport {
  confidenceTier: ConfidenceTier;
  checkSums: Array<{ rule: CheckSumRule; result: CheckSumResult }>;
  anomalies: AnomalyResult[];
  crossQueries: CrossQueryResult[];
  overallStatus: 'pass' | 'warning' | 'fail';
  issues: string[];
  recommendations: string[];
}

/**
 * Run comprehensive financial verification
 */
export function runFinancialVerification(
  extractedValues: Record<string, number>,
  confidence: number,
  historicalValues: Array<Record<string, number>> = []
): VerificationReport {
  const confidenceTier = getConfidenceTier(confidence);
  const checkSums = runCheckSums(extractedValues);
  const anomalies = detectAnomalies(extractedValues, historicalValues);
  const crossQueries = validateCrossQuery(extractedValues);

  const issues: string[] = [];
  const recommendations: string[] = [];

  // Analyze confidence tier
  if (confidenceTier === 'manual_review') {
    issues.push(`Low OCR confidence (${(confidence * 100).toFixed(1)}%) - mandatory manual verification required`);
    recommendations.push('Review original document alongside extracted data');
  } else if (confidenceTier === 'spot_check') {
    recommendations.push(`Moderate OCR confidence (${(confidence * 100).toFixed(1)}%) - spot-check recommended`);
  }

  // Analyze check-sums
  for (const { rule, result } of checkSums) {
    if (!result.passed) {
      issues.push(`${rule.name} failed: expected ${result.expected.toLocaleString()}, got ${result.actual.toLocaleString()} (${result.tolerancePct.toFixed(2)}% off)`);
      recommendations.push(`Verify ${rule.formula}`);
    }
  }

  // Analyze anomalies
  for (const anomaly of anomalies) {
    issues.push(`Anomaly detected in "${anomaly.field}": ${anomaly.possibleCause}`);
    recommendations.push(`Compare "${anomaly.field}" value (${anomaly.currentValue.toLocaleString()}) with source document`);
  }

  // Analyze cross-queries
  for (const cq of crossQueries) {
    if (!cq.passed) {
      issues.push(`${cq.rule.name}: total (${cq.totalValue.toLocaleString()}) doesn't match component sum (${cq.componentSum.toLocaleString()})`);
      recommendations.push(`Verify components: ${cq.presentComponents.join(', ')}`);
    }
  }

  // Determine overall status
  let overallStatus: 'pass' | 'warning' | 'fail';
  if (issues.length === 0) {
    overallStatus = 'pass';
  } else if (confidenceTier === 'manual_review' || checkSums.some(c => !c.result.passed) || anomalies.length > 0) {
    overallStatus = 'fail';
  } else {
    overallStatus = 'warning';
  }

  return {
    confidenceTier,
    checkSums,
    anomalies,
    crossQueries,
    overallStatus,
    issues,
    recommendations,
  };
}

/**
 * Format verification report for display
 */
export function formatVerificationReport(report: VerificationReport): string {
  const lines: string[] = [
    '═══════════════════════════════════════════════════════════',
    '                  FINANCIAL VERIFICATION REPORT            ',
    '═══════════════════════════════════════════════════════════',
    '',
    `Overall Status: ${report.overallStatus.toUpperCase()}`,
    `Confidence Tier: ${report.confidenceTier.replace('_', ' ').toUpperCase()}`,
    '',
  ];

  if (report.checkSums.length > 0) {
    lines.push('Check-Sum Validations:');
    for (const { rule, result } of report.checkSums) {
      const status = result.passed ? '✓' : '✗';
      lines.push(`  ${status} ${rule.name}`);
      if (!result.passed) {
        lines.push(`    Expected: ${result.expected.toLocaleString()}, Actual: ${result.actual.toLocaleString()}`);
      }
    }
    lines.push('');
  }

  if (report.anomalies.length > 0) {
    lines.push('Anomalies Detected:');
    for (const anomaly of report.anomalies) {
      lines.push(`  ⚠ ${anomaly.field}: ${anomaly.possibleCause}`);
      lines.push(`    Value: ${anomaly.currentValue.toLocaleString()}, Expected ~${anomaly.historicalMean.toLocaleString()}`);
    }
    lines.push('');
  }

  if (report.crossQueries.length > 0) {
    lines.push('Cross-Query Validations:');
    for (const cq of report.crossQueries) {
      const status = cq.passed ? '✓' : '✗';
      lines.push(`  ${status} ${cq.rule.name}`);
      if (!cq.passed) {
        lines.push(`    Total: ${cq.totalValue.toLocaleString()}, Sum: ${cq.componentSum.toLocaleString()} (${cq.differencePercent.toFixed(1)}% off)`);
      }
    }
    lines.push('');
  }

  if (report.issues.length > 0) {
    lines.push('Issues:');
    for (const issue of report.issues) {
      lines.push(`  • ${issue}`);
    }
    lines.push('');
  }

  if (report.recommendations.length > 0) {
    lines.push('Recommendations:');
    for (const rec of report.recommendations) {
      lines.push(`  → ${rec}`);
    }
  }

  return lines.join('\n');
}
