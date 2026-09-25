import { loadConfig, redactConfig } from './config/load.ts';
import { ConfigError } from './config/validate.ts';
import { createLogger } from './lib/log.ts';
import { openDb, migrate } from './db/index.ts';
import { createMetrics } from './lib/metrics.ts';
import { Vault } from './lib/crypto.ts';
import { registerUser } from './domain/users.ts';
import { reconcile } from './domain/ledger.ts';
import type { Deps } from './deps.ts';

const USAGE = `token-relay CLI

  migrate                         apply pending database migrations
  print-config [--sources]        show effective config (secrets redacted), optionally with each value's source
  check-config                    validate config and exit non-zero on problems
  create-admin <email> <password> create an admin account
  reconcile                       verify ledger invariants and wallet balances
  gen-master-key                  print a fresh random 32-byte base64 key for TR_MASTER_KEY
`;

async function main() {
  const [cmd, ...args] = process.argv.slice(2);
  if (!cmd || cmd === 'help' || cmd === '--help') return void process.stdout.write(USAGE);
  if (cmd === 'gen-master-key') {
    const { randomBytes } = await import('node:crypto');
    return void process.stdout.write(randomBytes(32).toString('base64') + '\n');
  }

  let loaded;
  try {
    loaded = loadConfig();
  } catch (err) {
    process.stderr.write(`${err instanceof ConfigError ? err.message : (err as Error).message}\n`);
    process.exit(78);
  }
  const { config, sources } = loaded;

  if (cmd === 'check-config') return void process.stdout.write(`config OK (env=${config.env})\n`);
  if (cmd === 'print-config') {
    const out: Record<string, unknown> = { config: redactConfig(config) };
    if (args.includes('--sources')) out.sources = sources;
    return void process.stdout.write(JSON.stringify(out, null, 2) + '\n');
  }

  const log = createLogger({ level: config.log.level === 'silent' ? 'info' : config.log.level, format: config.log.format });
  const db = await openDb(config, log);
  const deps: Deps = {
    cfg: config, db, log, metrics: createMetrics(), now: () => new Date(),
    vault: new Vault(config.security.masterKeyId, config.security.masterKey, config.security.previousMasterKeys),
  };
  try {
    switch (cmd) {
      case 'migrate': {
        const applied = await migrate(db, log);
        log.info(applied.length ? 'migrations applied' : 'database up to date', { applied });
        break;
      }
      case 'create-admin': {
        const [email, password] = args;
        if (!email || !password) throw new Error('usage: create-admin <email> <password>');
        const u = await registerUser(deps, email, password, 'admin');
        log.info('admin created', { id: u.id, email: u.email });
        break;
      }
      case 'reconcile': {
        const report = await reconcile(db);
        process.stdout.write(JSON.stringify(report, null, 2) + '\n');
        if (!report.ok) process.exitCode = 1;
        break;
      }
      default:
        process.stderr.write(`unknown command: ${cmd}\n\n${USAGE}`);
        process.exitCode = 2;
    }
  } finally {
    await db.close();
  }
}

main().catch((err) => {
  process.stderr.write(`${(err as Error).message}\n`);
  process.exit(1);
});
