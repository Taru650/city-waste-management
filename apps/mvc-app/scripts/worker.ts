/**
 * The background worker: sends notifications, processes videos, enforces SLA deadlines, closes unrated complaints and
 * tidies up. `npm run dev` starts it next to the website; in production run `npm run worker` as its own process.
 */
import { closeDb } from '../src/db/connection';
import { createRunner } from '../src/jobs/registry';

async function main() {
  const runner = createRunner();
  await runner.ensurePeriodic();
  runner.start();
  console.log('[worker] started');

  let stopping = false;
  const stop = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    console.log(`[worker] ${signal} received, finishing current jobs...`);
    await runner.stop();
    await closeDb();
    console.log('[worker] stopped');
    process.exit(0);
  };
  process.on('SIGINT', () => void stop('SIGINT'));
  process.on('SIGTERM', () => void stop('SIGTERM'));
}

main().catch((err) => {
  console.error('[worker] could not start:', err instanceof Error ? err.message : err);
  console.error('[worker] Is MySQL running and is the database migrated? Try: npm run doctor');
  process.exit(1);
});
