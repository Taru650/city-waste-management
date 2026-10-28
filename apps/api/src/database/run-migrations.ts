import { createDataSource } from './data-source';

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is required');
  const ds = await createDataSource(url).initialize();
  const applied = await ds.runMigrations({ transaction: 'each' });
  process.stdout.write(`Applied ${applied.length} migration(s)\n`);
  await ds.destroy();
}

main().catch((err) => {
  process.stderr.write(`${err}\n`);
  process.exit(1);
});
