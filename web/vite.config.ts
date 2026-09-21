import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The API server defaults to port 3001. If that port is already taken by
// another project on your machine, start the server with PORT=xxxx and export
// the same value as QUIZ_API_PORT before running Vite.
const API_PORT = process.env.QUIZ_API_PORT ?? '3001';

export default defineConfig({
  plugins: [react()],
  server: {
    // 5173 is the intended port. If another project already holds it, Vite
    // falls back to the next free port instead of refusing to start; the
    // actual URL is printed on boot.
    port: 5173,
    strictPort: false,
    proxy: {
      '/api': {
        target: `http://127.0.0.1:${API_PORT}`,
        changeOrigin: true,
      },
    },
  },
});