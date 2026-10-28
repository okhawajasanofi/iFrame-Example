import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/unit/**/*.test.ts', 'tests/api/**/*.test.ts'],
    fileParallelism: false, // the API tests bind fixed ports
    testTimeout: 20000,
    hookTimeout: 30000,
  },
});
