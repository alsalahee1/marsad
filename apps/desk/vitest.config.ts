import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';
import { sharedSource } from './vite.config.js';

export default defineConfig({
  plugins: [react()],
  resolve: { alias: { '@marsad/shared': sharedSource } },
  test: {
    include: ['test/**/*.test.{ts,tsx}'],
    environment: 'jsdom',
    setupFiles: ['test/setup.ts'],
    restoreMocks: true,
  },
});
