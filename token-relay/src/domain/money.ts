import type { ModelConfig } from '../config/types.ts';

/** 1 USD = 1_000_000 micros. All money math is integer micros. */
export const MICROS = 1_000_000;
export const usdToMicros = (usd: number) => Math.round(usd * MICROS);
export const microsToUsd = (m: number) => m / MICROS;
export const fmtUsd = (m: number) => `$${(m / MICROS).toFixed(6).replace(/0{1,4}$/, '')}`;

/** Price per 1M tokens in USD equals micros per token, so cost = tokens * price. */
export function costMicros(model: ModelConfig, promptTokens: number, completionTokens: number): number {
  return Math.ceil(promptTokens * model.inputUsdPerMTok + completionTokens * model.outputUsdPerMTok);
}

/** Split a buyer charge; entries always sum exactly to `cost`. */
export function split(cost: number, takeRate: number): { seller: number; platform: number } {
  const seller = Math.floor(cost * (1 - takeRate));
  return { seller, platform: cost - seller };
}
