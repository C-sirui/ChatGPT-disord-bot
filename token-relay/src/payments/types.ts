export interface CheckoutRequest {
  paymentId: string;
  userId: string;
  email: string;
  amountMicros: number;
}

export interface CheckoutResult {
  /** Where to send the buyer to pay; absent when the provider settles instantly (fake). */
  url?: string;
  externalId: string;
  /** True when payment is already confirmed (dev fake provider). */
  settled: boolean;
}

export interface PaymentEvent {
  type: 'payment_succeeded' | 'payment_failed';
  paymentId: string;
  externalId: string;
  amountMicros?: number;
}

export interface PaymentProvider {
  readonly id: 'fake' | 'stripe';
  createCheckout(req: CheckoutRequest): Promise<CheckoutResult>;
  /** Verifies and parses a webhook. Returns null for events we ignore. Throws on bad signature. */
  parseWebhook(rawBody: Buffer, headers: Record<string, string | string[] | undefined>): PaymentEvent | null;
}
