import type { BuildInput, ErrorClass, ProviderAdapter, UpstreamRequest } from './types.ts';
import type { Config } from '../../config/types.ts';

function classify(status: number): ErrorClass {
  if (status === 401 || status === 403) return 'auth';
  if (status === 429) return 'rate_limited';
  if (status >= 500 || status === 408 || status === 409) return 'retryable';
  return 'client';
}

interface Options {
  id: string;
  resalePolicy: ProviderAdapter['resalePolicy'];
  requiresBaseUrl: boolean;
  /** OpenAI's newer models reject `max_tokens`; compatible servers mostly expect it. */
  maxTokensField: 'max_tokens' | 'max_completion_tokens';
  forwardHeaderPrefixes?: string[];
}

function baseUrlFor(cfg: Config, id: string, credBase: string | null): string {
  const base = credBase || cfg.providers[id]?.baseUrl;
  if (!base) throw new Error(`provider ${id}: no base URL configured`);
  return base.replace(/\/$/, '');
}

export function openAiLike(o: Options): ProviderAdapter {
  return {
    id: o.id,
    resalePolicy: o.resalePolicy,
    requiresBaseUrl: o.requiresBaseUrl,
    buildChatRequest(input: BuildInput): UpstreamRequest {
      const body: Record<string, unknown> = { ...input.body, model: input.model.upstreamModel };
      if (body.max_tokens === undefined && body.max_completion_tokens === undefined) body[o.maxTokensField] = input.maxOutput;
      if (input.stream) {
        body.stream = true;
        body.stream_options = { ...(body.stream_options as object | undefined), include_usage: true };
      }
      const headers: Record<string, string> = {
        'content-type': 'application/json',
        authorization: `Bearer ${input.secret}`,
        accept: input.stream ? 'text/event-stream' : 'application/json',
      };
      for (const [k, v] of Object.entries(input.passthroughHeaders)) {
        if (o.forwardHeaderPrefixes?.some((p) => k.startsWith(p))) headers[k] = v;
      }
      return { url: `${baseUrlFor(input.cfg, o.id, input.baseUrl)}/chat/completions`, headers, body: JSON.stringify(body) };
    },
    classifyError: classify,
    async validate({ cfg, secret, baseUrl }) {
      try {
        const res = await fetch(`${baseUrlFor(cfg, o.id, baseUrl)}/models`, {
          headers: { authorization: `Bearer ${secret}` },
          signal: AbortSignal.timeout(10_000),
        });
        if (res.ok) return { ok: true };
        return { ok: false, detail: `HTTP ${res.status}` };
      } catch (e) {
        return { ok: false, detail: (e as Error).message };
      }
    },
  };
}
