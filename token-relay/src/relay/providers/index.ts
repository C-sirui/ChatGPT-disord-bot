import type { ProviderAdapter } from './types.ts';
import { openAiLike } from './openai.ts';

export type { ProviderAdapter } from './types.ts';

/**
 * Resale policies are deliberately conservative defaults; they are a product
 * and legal decision (DESIGN.md §3, O1), not an engineering one.
 */
const ADAPTERS: Record<string, ProviderAdapter> = {
  openai: openAiLike({ id: 'openai', resalePolicy: 'requires_agreement', requiresBaseUrl: false, maxTokensField: 'max_completion_tokens' }),
  // Seller-operated open-weight model servers (vLLM, Ollama, TGI, llama.cpp). No third-party
  // provider terms are involved, so resale is permitted — but only with the seller's attestation.
  self_hosted: openAiLike({ id: 'self_hosted', resalePolicy: 'permitted', requiresBaseUrl: true, maxTokensField: 'max_tokens', requiresSelfHostAttestation: true }),
  openai_compatible: openAiLike({ id: 'openai_compatible', resalePolicy: 'requires_agreement', requiresBaseUrl: true, maxTokensField: 'max_tokens' }),
  mock: openAiLike({ id: 'mock', resalePolicy: 'permitted', requiresBaseUrl: false, maxTokensField: 'max_tokens', forwardHeaderPrefixes: ['x-mock-'] }),
};

export const getAdapter = (id: string): ProviderAdapter | undefined => ADAPTERS[id];
export const adapterIds = () => Object.keys(ADAPTERS);
