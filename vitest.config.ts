import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Several tests spawn real git subprocesses (temp-repo setup, the git
    // safety check, the full e2e run). Under parallel load these can exceed
    // vitest's 5s default and flake on timeout; give them headroom.
    testTimeout: 20000,
    hookTimeout: 20000,
  },
});
