import { defineConfig } from 'vitest/config';
import path from 'node:path';
import DemoDataFirst from './tests/sequencer';

export default defineConfig({
  resolve: { alias: { '@': path.resolve(__dirname, 'src') } },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts', 'src/**/*.test.ts'],
    globalSetup: ['tests/global-setup.ts'],
    setupFiles: ['tests/setup-env.ts'],
    // One MySQL test database: files run one after another, never in parallel.
    fileParallelism: false,
    sequence: { sequencer: DemoDataFirst },
    testTimeout: 30_000,
    hookTimeout: 120_000,
  },
});
