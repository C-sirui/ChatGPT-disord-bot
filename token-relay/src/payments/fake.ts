import type { PaymentProvider } from './types.ts';

/** Development-only provider: every checkout succeeds immediately. Refused in production by config validation. */
export const fakePayments: PaymentProvider = {
  id: 'fake',
  async createCheckout(req) {
    return { externalId: `fake_${req.paymentId}`, settled: true };
  },
  parseWebhook() {
    return null;
  },
};
