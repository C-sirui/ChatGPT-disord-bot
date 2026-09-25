import type { Config } from '../config/types.ts';
import { fakePayments } from './fake.ts';
import { stripePayments } from './stripe.ts';
import type { PaymentProvider } from './types.ts';

export type { PaymentProvider, PaymentEvent } from './types.ts';

export function createPaymentProvider(cfg: Config): PaymentProvider {
  return cfg.payments.provider === 'stripe' ? stripePayments(cfg.payments.stripe) : fakePayments;
}
