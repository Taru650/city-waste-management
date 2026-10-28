import next from 'eslint-config-next';

const config = [
  { ignores: ['.next/**', 'node_modules/**', 'playwright-report/**', 'test-results/**', 'next-env.d.ts', 'scripts/**', 'e2e/**/*.d.mts'] },
  ...next,
];

export default config;
