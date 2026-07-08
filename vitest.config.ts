import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.ts'],
    // AGENTS.md rule 4 / DESIGN.md "No-cloud guard": undici MockAgent +
    // disableNetConnect() installed as the global dispatcher before every test file.
    setupFiles: ['./test/net-guard.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts', 'src/index.ts'],
    },
  },
  css: { postcss: { plugins: [] } },
});
