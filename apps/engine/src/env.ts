import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Load the first `.env` found: the current directory, then the repository root (two levels
 * above apps/engine). Values already in the environment win over the file.
 */
export function loadDotenv(): string | null {
  const candidates = [
    path.resolve(process.cwd(), '.env'),
    fileURLToPath(new URL('../../../.env', import.meta.url)),
  ];
  for (const file of candidates) {
    if (existsSync(file)) {
      process.loadEnvFile(file);
      return file;
    }
  }
  return null;
}
