import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: ['shared', 'client', 'server', 'app', 'desktop', 'computer', 'mobile', 'names', 'account'],
  },
});
