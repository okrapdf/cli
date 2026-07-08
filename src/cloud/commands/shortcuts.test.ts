import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as client from '../lib/client.js';

vi.mock('../lib/client.js', () => ({
  post: vi.fn(),
  get: vi.fn(),
}));

vi.mock('../../lib/config.js', () => ({
  getDefaultFormat: () => 'table',
  getDefaultOcr: () => null,
  getDefaultVlm: () => null,
}));

vi.mock('../lib/logs.js', () => ({
  logJob: () => ({ id: 'log-1' }),
  updateJobLog: vi.fn(),
}));

describe('extract command vlm_model passthrough', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should include vlm_model in job payload when --vlm flag is provided', async () => {
    const mockPost = vi.mocked(client.post);
    mockPost.mockResolvedValueOnce({ job_id: 'test-job-123', status: 'queued' });

    const jobPayload: Record<string, unknown> = { url: 'https://example.com/test.pdf' };
    const vlmModel = 'google/gemini-3-flash-preview';
    
    if (vlmModel) jobPayload.vlm_model = vlmModel;

    await client.post('api/v1/extract', jobPayload);

    expect(mockPost).toHaveBeenCalledWith('api/v1/extract', {
      url: 'https://example.com/test.pdf',
      vlm_model: 'google/gemini-3-flash-preview',
    });
  });

  it('should NOT include vlm_model in job payload when --vlm flag is not provided', async () => {
    const mockPost = vi.mocked(client.post);
    mockPost.mockResolvedValueOnce({ job_id: 'test-job-123', status: 'queued' });

    const jobPayload: Record<string, unknown> = { url: 'https://example.com/test.pdf' };
    const vlmModel = null;
    
    if (vlmModel) jobPayload.vlm_model = vlmModel;

    await client.post('api/v1/extract', jobPayload);

    expect(mockPost).toHaveBeenCalledWith('api/v1/extract', {
      url: 'https://example.com/test.pdf',
    });
    expect(mockPost).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ vlm_model: expect.anything() })
    );
  });

  it('should include both ocr_engine and vlm_model when both flags provided', async () => {
    const mockPost = vi.mocked(client.post);
    mockPost.mockResolvedValueOnce({ job_id: 'test-job-123', status: 'queued' });

    const jobPayload: Record<string, unknown> = { document_uuid: 'abc-123' };
    const ocrEngine = 'docai';
    const vlmModel = 'qwen/qwen3-vl-235b-a22b-instruct';
    
    if (ocrEngine) jobPayload.ocr_engine = ocrEngine;
    if (vlmModel) jobPayload.vlm_model = vlmModel;

    await client.post('api/v1/extract', jobPayload);

    expect(mockPost).toHaveBeenCalledWith('api/v1/extract', {
      document_uuid: 'abc-123',
      ocr_engine: 'docai',
      vlm_model: 'qwen/qwen3-vl-235b-a22b-instruct',
    });
  });
});
