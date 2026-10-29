import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    testTimeout: 120_000,
    hookTimeout: 180_000,
    pool: 'forks',
    env: { NODE_ENV: 'test', UPLOAD_DIR: './.data/test-uploads' },
  },
});
