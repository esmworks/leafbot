import { defineProject } from 'vitest/config';

export default defineProject({ test: { name: 'names', include: ['test/**/*.test.ts'] } });
