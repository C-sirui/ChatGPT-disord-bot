import { loadConfig } from './config/load.ts';
import { ConfigError } from './config/validate.ts';
import { createApp } from './app.ts';
import { createLogger } from './lib/log.ts';

async function main() {
  let loaded;
  try {
    loaded = loadConfig();
  } catch (err) {
    process.stderr.write(`${err instanceof ConfigError ? err.message : (err as Error).stack}\n`);
    process.exit(78); // EX_CONFIG
  }
  const log = createLogger({ level: loaded.config.log.level, format: loaded.config.log.format });
  const app = await createApp(loaded, { logger: log });

  if (loaded.config.env === 'development') {
    const base = loaded.config.server.publicBaseUrl;
    log.info('dev quickstart', {
      tryIt: `curl -s ${app.url}/v1/chat/completions -H 'authorization: Bearer trk_dev_buyer_0000000000000000000000000000000' -H 'content-type: application/json' -d '{"model":"mock-fast","messages":[{"role":"user","content":"hello"}]}'`,
      debug: `${app.url}/debug/requests`,
      editorBaseUrl: `${base}/v1`,
    });
  }

  let stopping = false;
  const stop = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    log.info('signal received', { signal });
    await app.close().catch((err) => log.error('shutdown error', { err }));
    process.exit(0);
  };
  process.on('SIGTERM', () => void stop('SIGTERM'));
  process.on('SIGINT', () => void stop('SIGINT'));
  process.on('unhandledRejection', (err) => log.error('unhandledRejection', { err }));
  process.on('uncaughtException', (err) => {
    log.error('uncaughtException', { err });
    void stop('uncaughtException');
  });
}

void main();
