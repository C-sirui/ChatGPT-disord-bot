import type { Deps } from '../deps.ts';
import type { Logger } from '../lib/log.ts';
import { registerUser } from '../domain/users.ts';
import { createApiKey } from '../domain/apikeys.ts';
import { createCredential } from '../domain/credentials.ts';
import { creditTopup } from '../domain/wallet.ts';
import { usdToMicros } from '../domain/money.ts';

/** Stable, well-known dev credentials. Config validation forbids dev.seed in production. */
export const DEV_SEED = {
  password: 'devpass',
  admin: 'admin@relay.dev',
  buyer: 'buyer@relay.dev',
  seller: 'seller@relay.dev',
  buyerKey: 'trk_dev_buyer_0000000000000000000000000000000',
};

export async function seedDev(d: Deps, log: Logger): Promise<void> {
  const existing = await d.db.one('SELECT id FROM users WHERE email = $1', [DEV_SEED.buyer]);
  if (existing) {
    log.info('dev seed already present', { buyerKey: DEV_SEED.buyerKey });
    return;
  }
  const admin = await registerUser(d, DEV_SEED.admin, DEV_SEED.password, 'admin');
  const buyer = await registerUser(d, DEV_SEED.buyer, DEV_SEED.password);
  const seller = await registerUser(d, DEV_SEED.seller, DEV_SEED.password);
  await createApiKey(d, buyer.id, 'dev', DEV_SEED.buyerKey);
  await creditTopup(d, buyer.id, 'seed', usdToMicros(25), 'dev seed credit');
  if (d.cfg.providers.mock?.enabled) {
    await createCredential(d, seller.id, { provider: 'mock', label: 'dev mock key', apiKey: 'mock-secret-dev-seller', hourlyTokenLimit: 1_000_000, maxConcurrency: 16 });
  }
  log.info('dev seed created', {
    admin: admin.email, buyer: buyer.email, seller: seller.email, password: DEV_SEED.password, buyerKey: DEV_SEED.buyerKey,
  });
}
