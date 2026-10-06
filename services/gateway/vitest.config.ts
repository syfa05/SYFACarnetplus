import { defineConfig } from 'vitest/config';

// PGlite (PostgreSQL en WebAssembly) démarre en quelques secondes par test.
export default defineConfig({ test: { testTimeout: 60_000, hookTimeout: 60_000 } });
