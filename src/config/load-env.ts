/**
 * Side-effect module: loads memeEngine_be/.env (if present) into process.env before anything
 * reads configuration. Must be the first import in main.ts. Existing environment variables win.
 */
import * as fs from 'fs';
import * as path from 'path';

const envPath = path.resolve(__dirname, '..', '..', '.env');
if (fs.existsSync(envPath)) {
  const before = { ...process.env };
  try {
    (process as unknown as { loadEnvFile(p: string): void }).loadEnvFile(envPath);
    for (const [k, v] of Object.entries(before)) process.env[k] = v; // explicit env beats .env
  } catch (err: any) {
    console.warn(`Could not load ${envPath}: ${err?.message || err}`);
  }
}
