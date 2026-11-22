import path from 'node:path';
import { defineConfig } from 'vite';

export default defineConfig({
  root: path.resolve(import.meta.dirname, 'web'),
  base: '/dashboard/',
  build: {
    outDir: path.resolve(import.meta.dirname, '../internal/webui/dist'),
    emptyOutDir: true,
    sourcemap: false,
  },
});
