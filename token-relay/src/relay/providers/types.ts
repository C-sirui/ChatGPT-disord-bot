import type { Config, ModelConfig } from '../../config/types.ts';

export type ResalePolicy = 'permitted' | 'requires_agreement' | 'prohibited';
export type ErrorClass = 'retryable' | 'rate_limited' | 'auth' | 'client';

export interface UpstreamRequest {
  url: string;
  headers: Record<string, string>;
  body: string;
}

export interface BuildInput {
  cfg: Config;
  model: ModelConfig;
  secret: string;
  baseUrl: string | null;
  body: Record<string, unknown>;
  stream: boolean;
  maxOutput: number;
  /** Extra headers forwarded from the client (dev-only fault injection etc.). */
  passthroughHeaders: Record<string, string>;
}

export interface ProviderAdapter {
  readonly id: string;
  /**
   * Whether the provider's terms allow reselling capacity. `requires_agreement`
   * providers route only if the operator sets providers.<id>.resaleAcknowledged.
   */
  readonly resalePolicy: ResalePolicy;
  readonly requiresBaseUrl: boolean;
  buildChatRequest(input: BuildInput): UpstreamRequest;
  classifyError(status: number): ErrorClass;
  validate(input: { cfg: Config; secret: string; baseUrl: string | null }): Promise<{ ok: boolean; detail?: string }>;
}
