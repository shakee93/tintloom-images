// Keys and settings. Keys live outside the plugin folder (plugin caches are
// replaced on update) in a 0600 file, and environment variables always win.
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export function configPath(env = process.env) {
  if (env.TINTLOOM_CONFIG) return env.TINTLOOM_CONFIG;
  const base = env.XDG_CONFIG_HOME || join(homedir(), '.config');
  return join(base, 'tintloom', 'config.json');
}

export async function readConfig(env = process.env) {
  try {
    const parsed = JSON.parse(await readFile(configPath(env), 'utf8'));
    return { keys: {}, settings: {}, ...parsed };
  } catch {
    return { keys: {}, settings: {} };
  }
}

export async function writeConfig(config, env = process.env) {
  const file = configPath(env);
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  await writeFile(file, JSON.stringify(config, null, 2) + '\n', { mode: 0o600 });
  await chmod(file, 0o600);
  return file;
}

/**
 * Where a provider's key comes from, in order:
 * 1. its environment variables (for example OPENAI_API_KEY)
 * 2. the config file written by `tintloom keys set`
 * Returns { key, source } or null. Never log `key`.
 */
export function resolveKey(provider, config, env = process.env) {
  for (const name of provider.envKeys) {
    const value = (env[name] || '').trim();
    // An unset plugin option can arrive as "" or as a literal "${user_config...}".
    if (value && !value.startsWith('${')) return { key: value, source: `env ${name}` };
  }
  const stored = config.keys?.[provider.id];
  if (stored) return { key: stored, source: 'config file' };
  return null;
}

/** A non-secret setting: environment first, then the config file. */
export function resolveSetting(name, config, env = process.env) {
  const envName = 'TINTLOOM_' + name.toUpperCase().replace(/[^A-Z0-9]+/g, '_');
  const value = (env[envName] || '').trim();
  return (value && !value.startsWith('${') ? value : null) || config.settings?.[name] || null;
}
