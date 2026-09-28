import { execFile } from 'child_process';
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { promisify } from 'util';
import { DATA_DIR } from './paths';

const run = promisify(execFile);
const SERVICE = 'agent-canvas';
const FILE = join(DATA_DIR, 'secrets.json');

/**
 * Secrets (e.g. the SMTP password) go to the macOS Keychain; elsewhere to a
 * user-only file. Never into settings.json or workflow files.
 */
export async function setSecret(name: string, value: string): Promise<void> {
  if (process.platform === 'darwin') {
    // -U updates an existing item.
    await run('security', ['add-generic-password', '-U', '-s', SERVICE, '-a', name, '-w', value]);
    return;
  }
  const all = existsSync(FILE) ? JSON.parse(readFileSync(FILE, 'utf8')) : {};
  all[name] = value;
  writeFileSync(FILE, JSON.stringify(all), { mode: 0o600 });
  chmodSync(FILE, 0o600);
}

export async function getSecret(name: string): Promise<string | null> {
  if (process.platform === 'darwin') {
    try {
      const { stdout } = await run('security', ['find-generic-password', '-s', SERVICE, '-a', name, '-w']);
      return stdout.replace(/\n$/, '');
    } catch {
      return null;
    }
  }
  if (!existsSync(FILE)) return null;
  return JSON.parse(readFileSync(FILE, 'utf8'))[name] ?? null;
}
