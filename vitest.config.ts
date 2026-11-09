import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['samples/**/*.test.ts'],
    environment: 'node',
  },
});
