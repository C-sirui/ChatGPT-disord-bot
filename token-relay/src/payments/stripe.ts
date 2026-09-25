import type { Config } from '../config/types.ts';
import { hmacSha256hex, safeEqual } from '../lib/crypto.ts';
import { ApiError } from '../lib/errors.ts';
import type { PaymentProvider } from './types.ts';

const TOLERANCE_S = 300;

/**
 * Stripe Checkout via the REST API (no SDK dependency). Buyers pay on a
 * Stripe-hosted page; `checkout.session.completed` with payment_status=paid
 * credits the wallet. Webhooks are verified per Stripe's v1 signature scheme.
 */
export function stripePayments(cfg: Config['payments']['stripe'], nowS: () => number = () => Math.floor(Date.now() / 1000)): PaymentProvider {
  return {
    id: 'stripe',
    async createCheckout(req) {
      const cents = Math.round(req.amountMicros / 10_000);
      const form = new URLSearchParams({
        mode: 'payment',
        success_url: cfg.successUrl,
        cancel_url: cfg.cancelUrl,
        client_reference_id: req.paymentId,
        customer_email: req.email,
        'metadata[payment_id]': req.paymentId,
        'metadata[user_id]': req.userId,
        'line_items[0][quantity]': '1',
        'line_items[0][price_data][currency]': 'usd',
        'line_items[0][price_data][unit_amount]': String(cents),
        'line_items[0][price_data][product_data][name]': 'Token Relay prepaid credit',
      });
      const res = await fetch(`${cfg.apiBase}/checkout/sessions`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${cfg.secretKey}`,
          'content-type': 'application/x-www-form-urlencoded',
          'idempotency-key': req.paymentId,
        },
        body: form,
        signal: AbortSignal.timeout(15_000),
      });
      const json = (await res.json().catch(() => ({}))) as { id?: string; url?: string; error?: { message?: string } };
      if (!res.ok || !json.id) throw new ApiError(502, 'payment_provider_error', `Stripe error: ${json.error?.message ?? res.status}`);
      return { url: json.url, externalId: json.id, settled: false };
    },
    parseWebhook(rawBody, headers) {
      const sigHeader = headers['stripe-signature'];
      if (typeof sigHeader !== 'string') throw new ApiError(400, 'bad_signature', 'Missing Stripe-Signature header');
      const parts = Object.fromEntries(sigHeader.split(',').map((p) => p.split('=', 2) as [string, string]));
      const t = Number(parts.t);
      const v1s = sigHeader.split(',').filter((p) => p.startsWith('v1=')).map((p) => p.slice(3));
      if (!t || v1s.length === 0) throw new ApiError(400, 'bad_signature', 'Malformed Stripe-Signature header');
      if (Math.abs(nowS() - t) > TOLERANCE_S) throw new ApiError(400, 'bad_signature', 'Stripe signature timestamp outside tolerance');
      const expected = hmacSha256hex(cfg.webhookSecret, `${t}.${rawBody.toString('utf8')}`);
      if (!v1s.some((s) => safeEqual(s, expected))) throw new ApiError(400, 'bad_signature', 'Stripe signature mismatch');

      const event = JSON.parse(rawBody.toString('utf8')) as {
        type: string;
        data: { object: { id: string; payment_status?: string; amount_total?: number; metadata?: Record<string, string> } };
      };
      const obj = event.data.object;
      const paymentId = obj.metadata?.payment_id;
      if (!paymentId) return null;
      if (event.type === 'checkout.session.completed' || event.type === 'checkout.session.async_payment_succeeded') {
        if (obj.payment_status !== 'paid') return null;
        return { type: 'payment_succeeded', paymentId, externalId: obj.id, amountMicros: (obj.amount_total ?? 0) * 10_000 };
      }
      if (event.type === 'checkout.session.async_payment_failed' || event.type === 'checkout.session.expired') {
        return { type: 'payment_failed', paymentId, externalId: obj.id };
      }
      return null;
    },
  };
}
