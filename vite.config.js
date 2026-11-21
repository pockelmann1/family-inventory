import { defineConfig } from 'vite';

// Served from https://pockelmann1.github.io/family-inventory/
export default defineConfig({
  base: process.env.SITE_BASE || '/family-inventory/',
  build: { sourcemap: false },
});
