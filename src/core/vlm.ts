/**
 * VlmClient — the neutral transport seam between parsers and providers.
 * @architect-owned — see DESIGN.md "The two seams".
 *
 * Lives in core so parsers can depend on the interface without importing providers
 * (dependency rule 1). Providers implement it (rule 2). The engine injects it.
 */

import type { TokenUsage } from './blocks.js';

export interface VlmImage {
  /** PNG bytes. */
  png: Uint8Array;
  /** Pixel dimensions of the rendered image. */
  width: number;
  height: number;
}

export interface VlmRequest {
  model: string;
  system: string;
  user: string;
  images: VlmImage[];
  maxOutputTokens?: number;
  temperature?: number;
}

export interface VlmResponse {
  /** Concatenated text output of the model. */
  text: string;
  usage: TokenUsage;
  /** Provider-specific response payload for debugging; never parsed by core. */
  raw?: unknown;
}

export interface VlmClient {
  complete(req: VlmRequest, signal?: AbortSignal): Promise<VlmResponse>;
}

/** Thrown by transports on non-2xx; engine retry policy keys off `status`. */
export class VlmHttpError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly body?: string,
  ) {
    super(message);
    this.name = 'VlmHttpError';
  }
}
