/**
 * Creates .env from .env.example when it does not exist, then fills the three secret values if they are
 * empty. It never overwrites a value you already set and never touches an existing file's other lines.
 */
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(__dirname, '..');
const envPath = path.join(root, '.env');
const examplePath = path.join(root, '.env.example');

if (!fs.existsSync(envPath)) {
  fs.copyFileSync(examplePath, envPath);
  console.log('Created .env from .env.example');
}

let text = fs.readFileSync(envPath, 'utf8');
const generators: Record<string, () => string> = {
  JWT_ACCESS_SECRET: () => randomBytes(48).toString('base64url'),
  PII_ENCRYPTION_KEY: () => randomBytes(32).toString('base64'),
  PII_HASH_KEY: () => randomBytes(32).toString('base64'),
};
const filled: string[] = [];
for (const [key, make] of Object.entries(generators)) {
  const re = new RegExp(`^${key}=(.*)$`, 'm');
  const m = re.exec(text);
  if (m && m[1].trim() !== '') continue; // already set: keep it
  if (m) text = text.replace(re, () => `${key}=${make()}`);
  else text += `${text.endsWith('\n') ? '' : '\n'}${key}=${make()}\n`;
  filled.push(key);
}
fs.writeFileSync(envPath, text);
console.log(filled.length ? `Generated: ${filled.join(', ')}` : 'Secrets already present; nothing changed.');
console.log('Keep .env private. Losing PII_ENCRYPTION_KEY or PII_HASH_KEY makes stored mobile numbers and emails unreadable.');
