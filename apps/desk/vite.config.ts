import { fileURLToPath } from 'node:url';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

/**
 * The shared package is consumed from source, so neither `pnpm dev` nor `pnpm build` depends on
 * a prior `tsc -b` of packages/shared. tsconfig `paths` mirrors this alias for the type checker.
 */
export const sharedSource = fileURLToPath(
  new URL('../../packages/shared/src/index.ts', import.meta.url),
);

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: { alias: { '@marsad/shared': sharedSource } },
  server: {
    host: 'localhost',
    port: 5173,
    // The engine's CORS allow-list and the session cookie are bound to this exact origin.
    // Failing beats silently moving to 5174 and getting 401s that look like a bug.
    strictPort: true,
  },
  preview: { host: 'localhost', port: 4173, strictPort: true },
  build: { target: 'es2022', sourcemap: false },
});
