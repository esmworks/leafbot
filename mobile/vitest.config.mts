import { fileURLToPath, URL } from 'node:url';
import { defineProject } from 'vitest/config';

// Only the pure logic is tested here; screens need React Native and run in the simulator.
export default defineProject({
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  test: { name: 'native', include: ['src/lib/**/*.test.ts'] },
});
