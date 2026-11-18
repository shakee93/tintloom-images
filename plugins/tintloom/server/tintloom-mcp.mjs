#!/usr/bin/env node
// tintloom MCP server: image tools with an inline image card (MCP Apps).
// Zero dependencies, Node 18+.
//
//   node tintloom-mcp.mjs            stdio: bundled with the plugin, or for Claude Desktop
//   node tintloom-mcp.mjs --http     HTTP on $PORT (default 8787): self-hosted, for web apps
//
// Keys come from the plugin's settings (TINTLOOM_*_KEY), the usual provider
// variables (OPENAI_API_KEY, GEMINI_API_KEY, FAL_KEY, ARK_API_KEY), or the CLI's config file.
import { execFile } from 'node:child_process';
import { timingSafeEqual, webcrypto } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { createServer } from 'node:http';
import { createInterface } from 'node:readline';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { configPath } from '../skills/image/scripts/lib/config.mjs';
import { shrinkPng } from '../skills/image/scripts/lib/png.mjs';
import { CARD_URI, ImageStore, VERSION, handleMessage as handle, newImageId } from './core.mjs';

// Node 18 has no `crypto` global (Node 20 and Deno do), and the shared core uses it for image ids.
if (!globalThis.crypto) globalThis.crypto = webcrypto;

export { CARD_URI, ImageStore };

const CARD_HTML = readFileSync(new URL('./ui/image-card.html', import.meta.url), 'utf8');
const lookupHost = async (host) => (await lookup(host, { all: true })).map((a) => a.address);

/** The core, with this process's card file and DNS filled in. */
export const handleMessage = (msg, ctx) => handle(msg, { cardHtml: CARD_HTML, lookupHost, ...ctx });

const cleanDir = (value) => (value && !value.startsWith('${') ? value : null);

/**
 * Generated images and painted masks, by id, on disk. The app can run more than
 * one copy of this server (one for the conversation, one that draws the card),
 * so what one copy makes the other must be able to find.
 */
export class DiskImageStore {
  constructor(dir = join(tmpdir(), `tintloom-${userInfo().uid}`)) {
    this.dir = dir;
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    // Forget entries older than a week. Only the registry is removed, never the user's saved image.
    const cutoff = Date.now() - 7 * 24 * 60 * 60_000;
    for (const name of readdirSync(dir)) {
      const file = join(dir, name);
      try {
        if (statSync(file).mtimeMs < cutoff) unlinkSync(file);
      } catch {
        /* another copy removed it first */
      }
    }
  }
  /** entry: { mime, path } for a saved file, or { mime, bytes } to keep the bytes here. */
  put(entry) {
    const id = newImageId();
    if (entry.bytes) writeFileSync(join(this.dir, `${id}.bin`), entry.bytes, { mode: 0o600 });
    writeFileSync(join(this.dir, `${id}.json`), JSON.stringify({ mime: entry.mime, path: entry.path || null }), { mode: 0o600 });
    return id;
  }
  async get(rawId) {
    const id = String(rawId || '').replace(/\.[a-z0-9]+$/i, '');
    if (!/^img_[A-Za-z0-9_-]{16,40}$/.test(id)) return null;
    try {
      const meta = JSON.parse(readFileSync(join(this.dir, `${id}.json`), 'utf8'));
      const bytes = readFileSync(meta.path || join(this.dir, `${id}.bin`));
      return { bytes, mime: meta.mime, path: meta.path };
    } catch {
      return null;
    }
  }
}

/**
 * The card cannot always call back into this server, so images are also served
 * on the loopback address for it to load like any picture. Ids are unguessable.
 */
function startFileServer(store, log) {
  const state = { port: 0 };
  const server = createServer(async (req, res) => {
    const match = /^\/files\/([^/?]+)/.exec(req.url || '');
    const file = req.method === 'GET' && match ? await store.get(match[1]) : null;
    log('http', { url: (req.url || '').slice(0, 60), found: Boolean(file), referer: req.headers.referer || req.headers.origin || null });
    if (!file) {
      res.writeHead(404);
      return res.end();
    }
    res.writeHead(200, { 'Content-Type': file.mime, 'Content-Length': file.bytes.length, 'Cache-Control': 'private, max-age=86400', 'Access-Control-Allow-Origin': '*', 'Cross-Origin-Resource-Policy': 'cross-origin', 'X-Content-Type-Options': 'nosniff' });
    res.end(file.bytes);
  });
  server.on('error', () => {});
  server.listen(0, '127.0.0.1', () => {
    state.port = server.address().port;
  });
  server.unref();
  return state;
}

/**
 * Small copies of an image as data URIs, for the card. On a Mac the built-in
 * `sips` makes compact JPEGs; elsewhere a PNG is shrunk in-process, which is
 * larger for the same size, so only the preview is made that way.
 */
const THUMB_LIMIT = 9_000;
const THUMB_STEPS = [[256, 45], [256, 25], [192, 30], [128, 30], [96, 25], [64, 20]];

export async function makePreview(image, record, platform = process.platform) {
  const viaSips = async (edge, quality, limit) => {
    if (platform !== 'darwin' || !record.path) return null;
    const out = join(tmpdir(), `tintloom-preview-${record.id}-${edge}.jpg`);
    try {
      await new Promise((done, fail) => execFile('/usr/bin/sips', ['-Z', String(edge), '-s', 'format', 'jpeg', '-s', 'formatOptions', String(quality), record.path, '--out', out], { timeout: 15_000 }, (err) => (err ? fail(err) : done())));
      const bytes = readFileSync(out);
      return bytes.length < limit ? `data:image/jpeg;base64,${bytes.toString('base64')}` : null;
    } catch {
      return null;
    } finally {
      try {
        unlinkSync(out);
      } catch {
        /* nothing to remove */
      }
    }
  };
  const viaPng = (limit) => {
    for (const edge of [640, 512, 384, 256]) {
      let small = null;
      try {
        small = shrinkPng(image.bytes, edge);
      } catch {
        return null;
      }
      if (!small) return null;
      if (small.length < limit) return `data:image/png;base64,${small.toString('base64')}`;
    }
    return null;
  };
  // The preview is what the user normally sees, so it is as large as stays comfortably under apps' result limits.
  const preview = (await viaSips(1024, 68, 190_000)) || (await viaSips(768, 60, 190_000)) || viaPng(190_000);
  // The thumbnail is the one copy every app hands the card, so there must always be one: a busy picture that is over the
  // limit at the first setting is tried smaller and rougher until it fits, instead of going without.
  let thumb = null;
  for (const [edge, quality] of THUMB_STEPS) {
    thumb = await viaSips(edge, quality, THUMB_LIMIT);
    if (thumb) break;
  }
  return { preview, thumb };
}

/** Diagnostics: create ~/.config/tintloom/debug.log to have the server append what it is asked. Never logs keys or image data. */
function debugLogger(env) {
  const file = join(dirname(configPath(env)), 'debug.log');
  if (!existsSync(file)) return () => {};
  const brief = (value) =>
    JSON.stringify(value, (key, v) => (typeof v === 'string' && v.length > 120 ? `<${v.length} chars>` : v));
  return (label, value) => {
    try {
      appendFileSync(file, `${new Date().toISOString()} ${label} ${brief(value)}\n`);
    } catch {
      /* diagnostics must never break the server */
    }
  };
}

function serveStdio(env) {
  const log = debugLogger(env);
  const session = {};
  const store = new DiskImageStore();
  const files = startFileServer(store, log);
  const ctx = {
    env,
    mode: 'stdio',
    store,
    session,
    projectDir: cleanDir(env.TINTLOOM_PROJECT_DIR) || process.cwd(),
    fileUrl: (id) => (files.port ? `http://127.0.0.1:${files.port}/files/${id}` : null),
    // Exact addresses: some apps reject a wildcard port.
    cardDomains: () => (files.port ? [`http://127.0.0.1:${files.port}`, `http://localhost:${files.port}`] : []),
    preview: makePreview,
  };
  const send = (msg) => process.stdout.write(JSON.stringify(msg) + '\n');
  // The app knows which folder the user is working in; the folder this process started in can be a scratch one.
  const askRoots = () => session.roots && send({ jsonrpc: '2.0', id: 'tintloom-roots', method: 'roots/list' });
  log('start', { version: VERSION, projectDir: ctx.projectDir, cwd: process.cwd() });

  const rl = createInterface({ input: process.stdin });
  rl.on('line', async (line) => {
    if (!line.trim()) return;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
    }
    // A reply to our own roots request.
    if (msg && msg.method === undefined && msg.id === 'tintloom-roots') {
      const uri = msg.result?.roots?.find((r) => String(r.uri).startsWith('file://'))?.uri;
      log('roots', msg.result || msg.error);
      if (uri) {
        try {
          ctx.projectDir = fileURLToPath(uri);
        } catch {
          /* keep the folder we had */
        }
      }
      return;
    }
    if (msg?.method === 'initialize') log('initialize', msg.params);
    if (msg?.method === 'tools/call' || msg?.method === 'resources/read') log(msg.method, msg.params);
    const res = await handleMessage(msg, ctx);
    if (msg?.method === 'tools/call') {
      const r = res?.result;
      log('result', { tool: msg.params?.name, isError: r?.isError, content: r?.content?.map((c) => c.type), structured: r?.structuredContent && Object.keys(r.structuredContent), meta: r?._meta && Object.keys(r._meta), src: r?.structuredContent?.images?.[0]?.src, text: r?.isError ? r.content?.[0]?.text : undefined });
    }
    if (res) send(res);
    if (msg?.method === 'notifications/initialized' || msg?.method === 'notifications/roots/list_changed') askRoots();
  });
}

const sameToken = (a, b) => {
  const [x, y] = [Buffer.from(a || ''), Buffer.from(b || '')];
  return x.length === y.length && timingSafeEqual(x, y);
};

export function createHttpServer(env = process.env) {
  const token = env.TINTLOOM_SERVER_TOKEN || '';
  const store = new ImageStore();
  return createServer(async (req, res) => {
    // Browser-based apps connect from their own origin. Access is by the token, never by cookies.
    const cors = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': req.headers['access-control-request-headers'] || 'content-type, authorization, mcp-protocol-version, mcp-session-id',
      'Access-Control-Expose-Headers': 'mcp-session-id',
      'Access-Control-Max-Age': '600',
    };
    const send = (status, body, headers = {}) => {
      res.writeHead(status, { 'Cache-Control': 'no-store', ...cors, ...headers });
      res.end(body);
    };
    if (req.method === 'OPTIONS') return send(204, '');
    const json = (status, body) => send(status, JSON.stringify(body), { 'Content-Type': 'application/json' });
    try {
      const url = new URL(req.url, 'http://localhost');
      const baseUrl = (env.TINTLOOM_PUBLIC_URL || `${req.headers['x-forwarded-proto'] || 'http'}://${req.headers.host}`).replace(/\/+$/, '');

      if (req.method === 'GET' && url.pathname === '/health') return json(200, { ok: true, version: VERSION });

      // Generated files: the unguessable id is the access control.
      if (req.method === 'GET' && url.pathname.startsWith('/files/')) {
        const file = await store.get(url.pathname.slice('/files/'.length));
        return file ? send(200, file.bytes, { 'Content-Type': file.mime, 'X-Content-Type-Options': 'nosniff' }) : json(404, { error: 'Not found or expired' });
      }

      // The MCP endpoint is /mcp, or /mcp/<token> for apps that cannot send a header.
      const match = /^\/mcp(?:\/([^/]+))?$/.exec(url.pathname);
      if (!match) return json(404, { error: 'Not found' });
      if (token) {
        const given = match[1] || (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
        if (!sameToken(given, token)) return json(401, { error: 'Unauthorized' });
      }
      if (req.method !== 'POST') return send(405, '', { Allow: 'POST' });

      const chunks = [];
      let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > 64 * 1024 * 1024) return json(413, { error: 'Request too large' });
        chunks.push(chunk);
      }
      let body;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        return json(400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
      }
      const ctx = { env, mode: 'http', store, baseUrl, projectDir: process.cwd(), cardDomains: [new URL(baseUrl).origin] };
      const batch = Array.isArray(body);
      const answers = (await Promise.all((batch ? body : [body]).map((m) => handleMessage(m, ctx)))).filter(Boolean);
      if (!answers.length) return send(202, '');
      return json(200, batch ? answers : answers[0]);
    } catch (e) {
      console.error(e);
      return json(500, { error: 'Server error' });
    }
  });
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  const env = process.env;
  if (process.argv.includes('--http')) {
    const port = Number(env.PORT || 8787);
    const host = env.HOST || '127.0.0.1';
    createHttpServer(env).listen(port, host, () => {
      console.error(`tintloom MCP server on http://${host}:${port}/mcp`);
      if (!env.TINTLOOM_SERVER_TOKEN) console.error('Warning: TINTLOOM_SERVER_TOKEN is not set. Anyone who can reach this server can spend your provider credit.');
    });
  } else {
    serveStdio(env);
  }
}
