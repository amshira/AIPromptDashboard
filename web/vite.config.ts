import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// In dev the API lives on the Fastify server; in production Fastify serves this build itself.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    proxy: { '/api': process.env.API_URL ?? 'http://127.0.0.1:9010', '/healthz': process.env.API_URL ?? 'http://127.0.0.1:9010' },
  },
  build: { outDir: 'dist', sourcemap: false, chunkSizeWarningLimit: 900 },
});
