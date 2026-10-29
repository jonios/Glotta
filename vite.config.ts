import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  root: fileURLToPath(new URL('./web', import.meta.url)),
  plugins: [react()],
  server: {
    port: 5173,
    // Only /api/… goes to the API: a bare "/api" prefix would also swallow pages such as /api-access.
    proxy: { '^/api/': { target: 'http://127.0.0.1:3001', changeOrigin: false } },
  },
  build: { outDir: fileURLToPath(new URL('./dist', import.meta.url)), emptyOutDir: true },
});
