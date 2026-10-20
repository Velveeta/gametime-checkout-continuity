import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/upstash/**/*.test.ts'],
    testTimeout: 60_000,
    hookTimeout: 30_000,
  },
});
