/**
 * Side-effect module: loads memeEngine_be/.env (if present) into process.env before anything
 * reads configuration. Must be the first import in main.ts. Existing environment variables win.
 */
import * as fs from 'fs';
import * as path from 'path';

function parseEnvFallback(content: string): Record<string, string> {
  const result: Record<string, string> = {};
  const lines = content.split(/\r?\n/);
  for (let line of lines) {
    line = line.trim();
    if (!line || line.startsWith('#')) continue;
    if (line.startsWith('export ')) line = line.slice(7).trim();
    const eqIdx = line.indexOf('=');
    if (eqIdx === -1) continue;
    const key = line.slice(0, eqIdx).trim();
    let val = line.slice(eqIdx + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    } else {
      const hashIdx = val.indexOf(' #');
      if (hashIdx !== -1) val = val.slice(0, hashIdx).trim();
    }
    result[key] = val;
  }
  return result;
}

const envPath = path.resolve(__dirname, '..', '..', '.env');
if (fs.existsSync(envPath)) {
  const before = { ...process.env };
  try {
    if (typeof (process as any).loadEnvFile === 'function') {
      (process as any).loadEnvFile(envPath);
    } else {
      const parsed = parseEnvFallback(fs.readFileSync(envPath, 'utf8'));
      for (const [k, v] of Object.entries(parsed)) {
        if (process.env[k] === undefined) {
          process.env[k] = v;
        }
      }
    }
    for (const [k, v] of Object.entries(before)) process.env[k] = v; // explicit env beats .env
  } catch (err: any) {
    console.warn(`Could not load ${envPath}: ${err?.message || err}`);
  }
}

