import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const API_TARGET = process.env.VITE_API_TARGET ?? 'http://127.0.0.1:3000';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // Listen on all interfaces so phones on the LAN can reach the dev server.
    host: true,
    strictPort: true,
    proxy: {
      '/api': API_TARGET,
      '/health': API_TARGET,
      '/socket.io': { target: API_TARGET, ws: true },
    },
  },
});
