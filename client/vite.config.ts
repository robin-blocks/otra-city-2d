import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://localhost:3456',
      '/quick-start': 'http://localhost:3456',
      '/developer': 'http://localhost:3456',
      '/ws': {
        target: 'ws://localhost:3456',
        ws: true,
      },
    },
  },
  resolve: {
    preserveSymlinks: true,
  },
});
