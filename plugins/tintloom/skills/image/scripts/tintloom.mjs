#!/usr/bin/env node
// tintloom: generate and edit images with your own provider keys.
// Zero dependencies. Needs Node 18 or newer.
import { access, mkdir, writeFile } from 'node:fs/promises';
import { dirname, extname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { configPath, readConfig, resolveKey, resolveSetting, writeConfig } from './lib/config.mjs';
import { UserError, extForMime, http, loadImage, parseAspect, parseSize } from './lib/util.mjs';
import { getProvider, providers } from './providers/index.mjs';

const HELP = `tintloom - generate and edit images with your own provider keys

Usage:
  tintloom generate --prompt "..." [options]     Create an image
  tintloom edit --image in.png --prompt "..."    Change or combine existing images
  tintloom providers [--json]                    List providers, models and which have a key
  tintloom keys set <provider>                   Save a key (typed hidden, or piped on stdin)
  tintloom keys unset <provider>                 Remove a saved key
  tintloom config set <name> <value>             Settings: default-provider, cloud-url
  tintloom config show                           Show settings (never keys)
  tintloom cloud connect                         Use your keys from claude.ai and other web apps:
                                                 creates a hosted account, uploads the keys you have
                                                 set here (encrypted at rest) and prints a connector URL
  tintloom cloud status                          Which keys the hosted account holds
  tintloom cloud remove <provider>               Delete a key from the hosted account
  tintloom cloud delete                          Delete the hosted account and revoke its connector URL

Options for generate and edit:
  -p, --prompt <text>      What to make (required; optional with --layers)
      --provider <id>      openai, gemini, fal, modelark or cloud (default: your default, else first with a key)
  -m, --model <id>         Provider model (default: the provider's best general model)
  -i, --image <path>       Input or reference image; repeat for several
      --mask <path>        Mask for edits (openai only)
  -s, --size <WxH>         Exact pixels, for example 1536x1024
  -a, --aspect <W:H>       Shape only, for example 16:9
  -q, --quality <level>    low, medium, high, and xhigh or max on models that have them
  -n, --count <n>          How many variants (default 1, max 8)
      --background <kind>  transparent or opaque (where supported)
      --fidelity <level>   low or high: how closely an edit keeps the input (openai gpt-image-1.5)
      --layers             Split one --image into a base plus transparent PNG layers, one per element
                           (Seedream on modelark; billed per image returned, usually about 5, at most 10 kept)
  -f, --format <type>      png, jpeg or webp
  -o, --out <path>         Output file, or a folder ending in "/" (default: ./generated-images/)
      --overwrite          Replace an existing output file
      --json               Print machine-readable JSON
`;

const OPTIONS = {
  prompt: { type: 'string', short: 'p' },
  provider: { type: 'string' },
  model: { type: 'string', short: 'm' },
  image: { type: 'string', short: 'i', multiple: true },
  mask: { type: 'string' },
  size: { type: 'string', short: 's' },
  aspect: { type: 'string', short: 'a' },
  quality: { type: 'string', short: 'q' },
  count: { type: 'string', short: 'n' },
  background: { type: 'string' },
  format: { type: 'string', short: 'f' },
  fidelity: { type: 'string' },
  layers: { type: 'boolean' },
  out: { type: 'string', short: 'o' },
  overwrite: { type: 'boolean' },
  json: { type: 'boolean' },
  help: { type: 'boolean', short: 'h' },
};

// The exact command to re-run this CLI, for hints the user pastes into a terminal.
const ARGV = globalThis.process?.argv || [];
const SELF = `node "${ARGV[1] || 'tintloom.mjs'}"`;

const oneOf = (name, value, allowed) => {
  if (value !== undefined && !allowed.includes(value)) {
    throw new UserError(`Bad --${name} "${value}". Use one of: ${allowed.join(', ')}.`);
  }
  return value;
};

/** What is asked of Seedream when the split is wanted with no instructions. */
export const LAYERS_PROMPT = 'Split this image into its separate elements as layers. Give every layer a short name and description in English.';

export async function buildRequest(values, command) {
  if (values.layers && !values.prompt?.trim()) values = { ...values, prompt: LAYERS_PROMPT };
  if (!values.prompt?.trim()) throw new UserError('A prompt is required.', 'Pass --prompt "what to make".');
  const paths = values.image || [];
  // Callers that already hold image bytes (the MCP server) pass loadedImages.
  const loaded = values.loadedImages || null;
  if (command === 'edit' && !paths.length && !loaded?.length) throw new UserError('edit needs at least one --image.');
  if ((values.mask || values.loadedMask) && !paths.length && !loaded?.length) throw new UserError('A mask needs an image to edit.');
  if (values.size && values.aspect) throw new UserError('Use --size or --aspect, not both.');
  if (values.layers) {
    const given = (loaded?.length ?? paths.length) || 0;
    if (given !== 1) throw new UserError(given ? 'Splitting into layers takes exactly one image.' : 'Splitting into layers needs the image to split.', 'Pass one --image.');
    if (values.mask || values.loadedMask) throw new UserError('Layers cannot be limited to an area; the whole image is split.');
    if (values.count !== undefined && Number(values.count) !== 1) throw new UserError('--layers makes one split at a time; leave out --count.');
  }
  const n = values.count === undefined ? 1 : Number(values.count);
  if (!Number.isInteger(n) || n < 1 || n > 8) throw new UserError('--count must be a whole number from 1 to 8.');
  if (values.aspect) parseAspect(values.aspect);
  return {
    prompt: values.prompt.trim(),
    model: values.model || null,
    images: loaded || (await Promise.all(paths.map(loadImage))),
    mask: values.loadedMask || (values.mask ? await loadImage(values.mask) : null),
    fidelity: oneOf('fidelity', values.fidelity, ['low', 'high']) || null,
    size: values.size ? parseSize(values.size) : null,
    aspect: values.aspect || null,
    quality: oneOf('quality', values.quality, ['low', 'medium', 'high', 'xhigh', 'max', 'auto']) || null,
    background: oneOf('background', values.background, ['transparent', 'opaque', 'auto']) || null,
    format: oneOf('format', values.format, ['png', 'jpeg', 'jpg', 'webp']) || null,
    layers: values.layers === true,
    n,
  };
}

/** Explicit flag, then the saved default, then the first provider that has a key. */
export function pickProvider(flag, config, env) {
  const saved = resolveSetting('default-provider', config, env);
  const wanted = flag || (saved === 'auto' ? null : saved);
  if (wanted) {
    const provider = getProvider(wanted);
    if (!provider) throw new UserError(`Unknown provider "${wanted}".`, `Available: ${providers.map((p) => p.id).join(', ')}.`);
    const found = resolveKey(provider, config, env);
    if (!found) throw missingKey(provider);
    return { provider, ...found };
  }
  for (const provider of providers) {
    const found = resolveKey(provider, config, env);
    if (found) return { provider, ...found };
  }
  throw new UserError(
    'No image provider key is set.',
    `Set one in your own terminal (not in chat), for example:\n  ${SELF} keys set openai\nor export OPENAI_API_KEY. Providers: ${providers.map((p) => p.id).join(', ')}.`,
  );
}

const missingKey = (provider) =>
  new UserError(
    `No API key for ${provider.label}.`,
    `Set it in your own terminal (not in chat):\n  ${SELF} keys set ${provider.id}\nor export ${provider.envKeys.find((k) => !k.startsWith('TINTLOOM_')) || provider.envKeys[0]}.`,
  );

const slug = (text) =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'image';

const exists = (p) => access(p).then(() => true, () => false);

/** Decide file paths; never overwrite unless asked. */
export async function outputPaths(out, prompt, images, overwrite, cwd = process.cwd()) {
  const isDir = !out || out.endsWith('/') || !extname(out);
  const stamp = new Date().toISOString().replace(/[-:]/g, '').slice(0, 15);
  const paths = [];
  for (let i = 0; i < images.length; i++) {
    const ext = extForMime(images[i].mime);
    let base;
    if (isDir) base = join(resolve(cwd, out || 'generated-images'), `${slug(prompt)}-${stamp}`);
    else base = resolve(cwd, out).slice(0, -extname(out).length);
    const suffix = images.length > 1 ? `-${i + 1}` : '';
    // The file gets the extension of what the provider actually returned.
    let candidate = `${base}${suffix}.${ext}`;
    for (let v = 2; !overwrite && ((await exists(candidate)) || paths.includes(candidate)); v++) {
      candidate = `${base}${suffix}-v${v}.${ext}`;
    }
    paths.push(candidate);
  }
  return paths;
}

async function runGenerate(values, command, env) {
  const config = await readConfig(env);
  const req = await buildRequest(values, command);
  if (req.layers && values.provider && values.provider !== 'modelark') throw new UserError('Layers run on Seedream through BytePlus ModelArk only.', 'Use --provider modelark, or leave --provider out.');
  const { provider, key } = pickProvider(req.layers ? 'modelark' : values.provider, config, env);
  const ctx = { key, env, setting: (name) => resolveSetting(name, config, env) };
  const started = Date.now();
  const images = await provider.generate(req, ctx);
  if (!images.length) throw new UserError(`${provider.label} returned no image.`, 'The prompt may have been declined. Rephrase it and try again.');

  const paths = await outputPaths(values.out, req.prompt, images, values.overwrite);
  for (let i = 0; i < images.length; i++) {
    await mkdir(dirname(paths[i]), { recursive: true });
    await writeFile(paths[i], images[i].bytes);
  }
  const result = {
    ok: true,
    provider: provider.id,
    model: req.model || provider.defaultModel,
    files: paths,
    seconds: Math.round((Date.now() - started) / 100) / 10,
    ...(req.layers && { layers: images.map((img, i) => ({ file: paths[i], name: img.name || (i === 0 ? 'Base' : `Layer ${i}`), description: img.description || null, z_index: img.zIndex ?? i })), ...(images.leftOut && { left_out: images.leftOut }) }),
  };
  if (values.json) console.log(JSON.stringify(result));
  else {
    console.log(`Saved ${paths.length} image${paths.length > 1 ? 's' : ''} from ${result.provider} (${result.model}) in ${result.seconds}s:`);
    for (const [i, p] of paths.entries()) console.log(`  ${p}${req.layers ? `  (${images[i].name || (i === 0 ? 'Base' : `Layer ${i}`)})` : ''}`);
    if (images.leftOut) console.log(`${images.leftOut} further small layer${images.leftOut === 1 ? ' was' : 's were'} left out (every image the provider returned is billed).`);
  }
}

async function runProviders(values, env) {
  const config = await readConfig(env);
  const fallback = resolveSetting('default-provider', config, env);
  const rows = providers.map((p) => {
    const found = resolveKey(p, config, env);
    return {
      id: p.id,
      label: p.label,
      hasKey: Boolean(found),
      keySource: found?.source || null,
      keyEnv: p.envKeys,
      defaultModel: p.defaultModel,
      models: p.models,
      capabilities: p.capabilities,
      notes: p.notes,
      isDefault: fallback === p.id,
    };
  });
  if (values.json) return console.log(JSON.stringify({ providers: rows, defaultProvider: fallback, configFile: configPath(env) }));
  for (const r of rows) {
    console.log(`${r.hasKey ? '[key set]' : '[no key] '} ${r.id}${r.isDefault ? ' (default)' : ''} - ${r.label}`);
    console.log(`           models: ${r.models.join(', ')}  (default ${r.defaultModel})`);
    console.log(`           ${r.hasKey ? `key from ${r.keySource}` : `set with: ${SELF} keys set ${r.id}  or  export ${r.keyEnv.find((k) => !k.startsWith('TINTLOOM_')) || r.keyEnv[0]}`}`);
    console.log(`           ${r.notes}`);
  }
}

/** Read a secret without echoing it; accepts a pipe as well as a terminal. */
async function readSecret(question) {
  if (!process.stdin.isTTY) {
    let data = '';
    for await (const chunk of process.stdin) data += chunk;
    return data.trim();
  }
  process.stderr.write(question);
  return new Promise((done, fail) => {
    let value = '';
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding('utf8');
    const finish = (err) => {
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdin.removeListener('data', onData);
      process.stderr.write('\n');
      err ? fail(err) : done(value.trim());
    };
    const onData = (chunk) => {
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n') return finish();
        if (ch === '\u0003') return finish(new UserError('Cancelled.'));
        if (ch === '\u007f' || ch === '\b') value = value.slice(0, -1);
        else value += ch;
      }
    };
    process.stdin.on('data', onData);
  });
}

async function runKeys(positionals, env) {
  const [action, id] = positionals;
  const provider = getProvider(id);
  if (!['set', 'unset'].includes(action) || !provider) {
    throw new UserError('Usage: tintloom keys set <provider>  |  tintloom keys unset <provider>', `Providers: ${providers.map((p) => p.id).join(', ')}.`);
  }
  const config = await readConfig(env);
  if (action === 'unset') {
    delete config.keys[provider.id];
    await writeConfig(config, env);
    return console.log(`Removed the saved ${provider.label} key.`);
  }
  const key = await readSecret(`${provider.label} API key (input hidden): `);
  if (!key) throw new UserError('No key entered; nothing saved.');
  config.keys[provider.id] = key;
  const file = await writeConfig(config, env);
  console.log(`Saved the ${provider.label} key to ${file} (readable only by you).`);
}

// The hosted service (supabase/functions/mcp). Self-hosters point this at their own.
const CLOUD_API = 'https://zxwxmttjvovbsldvvgdx.supabase.co/functions/v1/mcp';

async function runCloud(positionals, env) {
  const [action, id] = positionals;
  const api = (env.TINTLOOM_CLOUD_API || CLOUD_API).replace(/\/+$/, '');
  const config = await readConfig(env);
  const saved = config.cloud?.api === api ? config.cloud : null;
  const call = (path, init = {}, token = saved?.token) =>
    http(`${api}${path}`, { ...init, headers: { 'Content-Type': 'application/json', ...(token && { Authorization: `Bearer ${token}` }) }, secrets: [token], label: 'Hosted service request', timeoutMs: 30_000 });
  const needAccount = () => {
    if (!saved) throw new UserError('No hosted account yet.', `Run: ${SELF} cloud connect`);
  };

  if (action === 'connect') {
    let token = saved?.token;
    if (!token) {
      token = (await call('/accounts', { method: 'POST' }, null)).token;
      config.cloud = { api, token };
      await writeConfig(config, env);
    }
    const sent = [];
    for (const provider of providers) {
      if (provider.id === 'cloud') continue;
      const found = resolveKey(provider, config, env);
      if (!found) continue;
      await call(`/keys/${provider.id}`, { method: 'PUT', body: JSON.stringify({ key: found.key }), secrets: [token, found.key] }, token);
      sent.push(provider.label);
    }
    console.log(sent.length ? `Uploaded keys for: ${sent.join(', ')}.` : `No provider keys are set on this machine yet. Set one with \`${SELF} keys set openai\`, then run this again.`);
    console.log('\nConnector URL (treat it like a password; anyone with it can spend your provider credit):');
    console.log(`  ${api}/u/${token}`);
    console.log('\nIn claude.ai: Settings > Connectors > Add custom connector, and paste that URL.');
    return;
  }
  if (action === 'status') {
    needAccount();
    const { providers: rows } = await call('/account');
    for (const row of rows) console.log(`${row.has_key ? '[key set]' : '[no key] '} ${row.provider}`);
    return;
  }
  if (action === 'remove' && getProvider(id)) {
    needAccount();
    await call(`/keys/${id}`, { method: 'DELETE' });
    return console.log(`Removed the ${id} key from the hosted account.`);
  }
  if (action === 'delete') {
    needAccount();
    await call('/account', { method: 'DELETE' });
    delete config.cloud;
    await writeConfig(config, env);
    return console.log('Deleted the hosted account. Its connector URL no longer works; run `cloud connect` for a new one.');
  }
  throw new UserError('Usage: tintloom cloud connect | status | remove <provider> | delete');
}

const SETTINGS = ['default-provider', 'cloud-url'];

async function runConfig(positionals, env) {
  const [action, name, value] = positionals;
  const config = await readConfig(env);
  if (action === 'show') {
    return console.log(JSON.stringify({ file: configPath(env), settings: config.settings, savedKeysFor: Object.keys(config.keys), hostedAccount: Boolean(config.cloud?.token) }, null, 2));
  }
  if (action !== 'set' || !SETTINGS.includes(name) || !value) {
    throw new UserError(`Usage: tintloom config set <${SETTINGS.join('|')}> <value>  |  tintloom config show`);
  }
  if (name === 'default-provider' && !getProvider(value)) throw new UserError(`Unknown provider "${value}".`);
  if (name === 'cloud-url' && !/^https?:\/\//.test(value)) throw new UserError('cloud-url must start with http:// or https://');
  config.settings[name] = value;
  await writeConfig(config, env);
  console.log(`Set ${name} to ${value}.`);
}

export async function main(argv = process.argv.slice(2), env = process.env) {
  let parsed;
  try {
    parsed = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true });
  } catch (e) {
    throw new UserError(e.message, 'Run `tintloom --help` for the options.');
  }
  const { values, positionals } = parsed;
  const [command, ...rest] = positionals;
  if (values.help || !command || command === 'help') return console.log(HELP);
  if (command === 'generate' || command === 'edit') return runGenerate(values, command, env);
  if (command === 'providers') return runProviders(values, env);
  if (command === 'keys') return runKeys(rest, env);
  if (command === 'config') return runConfig(rest, env);
  if (command === 'cloud') return runCloud(rest, env);
  throw new UserError(`Unknown command "${command}".`, 'Run `tintloom --help`.');
}

if (ARGV[1] && import.meta.url === pathToFileURL(ARGV[1]).href) {
  main().catch((e) => {
    const json = process.argv.includes('--json');
    if (e instanceof UserError) {
      if (json) console.log(JSON.stringify({ ok: false, error: e.message, hint: e.hint || null }));
      else console.error(`Error: ${e.message}${e.hint ? `\n${e.hint}` : ''}`);
      process.exit(2);
    }
    console.error(e);
    process.exit(1);
  });
}
