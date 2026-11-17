// End-to-end tests against a local stub that imitates each provider's API.
// No real keys, no network. Run with: npm test
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { deflateSync } from 'node:zlib';
import { CARD_URI, DiskImageStore, ImageStore, createHttpServer, handleMessage, makePreview } from '../plugins/tintloom/server/tintloom-mcp.mjs';
import { outputPaths } from '../plugins/tintloom/skills/image/scripts/tintloom.mjs';
import { decodePng, encodePng, imageSize, maskFromRegions, shrinkPng } from '../plugins/tintloom/skills/image/scripts/lib/png.mjs';
import { nearestAspect, sizeForRatio, sniffMime } from '../plugins/tintloom/skills/image/scripts/lib/util.mjs';
import { buildBody, collectImages } from '../plugins/tintloom/skills/image/scripts/providers/gemini.mjs';
import { openaiSize } from '../plugins/tintloom/skills/image/scripts/providers/openai.mjs';

import { modelarkLayers } from './modelark-stub.mjs';

const run = promisify(execFile);
const CLI = fileURLToPath(new URL('../plugins/tintloom/skills/image/scripts/tintloom.mjs', import.meta.url));
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
const PNG_B64 = PNG.toString('base64');

let stub;
let base;
let dir;
const seen = [];

before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'tintloom-test-'));
  stub = createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const raw = Buffer.concat(chunks);
    const type = req.headers['content-type'] || '';
    const body = type.includes('json') && raw.length ? JSON.parse(raw.toString()) : raw.toString('latin1');
    seen.push({ method: req.method, url: req.url, headers: req.headers, body });
    const json = (obj, status = 200) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(obj));
    };
    if (req.headers.authorization === 'Bearer bad-key') return json({ error: { message: 'Incorrect API key provided: bad-key' } }, 401);
    if (req.url === '/v1/images/generations' || req.url === '/v1/images/edits') {
      const n = Number(typeof body === 'object' ? body.n : /name="n"\r\n\r\n(\d+)/.exec(body)?.[1]) || 1;
      return json({ data: Array.from({ length: n }, () => ({ b64_json: PNG_B64 })) });
    }
    if (req.url === '/gemini/interactions') {
      return json({ steps: [{ type: 'model_output', content: [{ type: 'text', text: 'here' }, { type: 'image', mime_type: 'image/png', data: PNG_B64 }] }] });
    }
    if (req.method === 'POST' && req.url.startsWith('/fal/')) {
      // A hostile answer names addresses off the queue's origin. They reach this same stub through
      // another name (localhost), so a request that should never be made would show up in `seen`.
      const other = base.replace('127.0.0.1', 'localhost');
      if (/hostile-queue/.test(body.prompt)) return json({ request_id: 'h1', status_url: `${other}/falq/r1/status`, response_url: `${other}/falq/r1` });
      if (/hostile-file/.test(body.prompt)) return json({ request_id: 'h2', status_url: `${base}/falq/r1/status`, response_url: `${base}/falq/h2` });
      return json({ request_id: 'r1', status_url: `${base}/falq/r1/status`, response_url: `${base}/falq/r1` });
    }
    if (req.method === 'POST' && req.url === '/modelark/images/generations') {
      if (/HOSTILE/.test(body.prompt)) return json({ data: [{ url: `${base.replace('127.0.0.1', 'localhost')}/file.png` }] });
      if (/URLFILE/.test(body.prompt)) return json({ data: [{ url: `${base}/file.png` }] });
      if (body.layer_decomposition) {
        const [status, answer] = modelarkLayers(body, { url: /URLS/.test(body.prompt) ? `${base}/file.png` : null });
        return json(answer, status);
      }
      return json({ data: [{ b64_json: PNG_B64, size: body.size }] });
    }
    if (req.url === '/falq/r1/status') return json({ status: 'COMPLETED' });
    if (req.url === '/falq/r1') return json({ images: [{ url: `${base}/file.png` }] });
    if (req.url === '/falq/h2') return json({ images: [{ url: `${base.replace('127.0.0.1', 'localhost')}/file.png` }] });
    if (req.url === '/cloud/accounts') return json({ token: 'tok_cloud_0123456789abcdef0123456789abcdef', connector_url: 'x' }, 201);
    if (req.url.startsWith('/cloud/keys/')) return json({ ok: true });
    if (req.url === '/cloud/account') return json({ providers: [{ provider: 'openai', has_key: true }, { provider: 'gemini', has_key: false }] });
    if (req.url === '/file.png') {
      res.writeHead(200, { 'Content-Type': 'image/png' });
      return res.end(PNG);
    }
    json({ error: 'unexpected ' + req.url }, 404);
  });
  await new Promise((r) => stub.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${stub.address().port}`;
});

after(() => stub.close());

const env = (extra = {}) => ({
  PATH: process.env.PATH,
  TINTLOOM_CONFIG: join(dir, `config-${Math.random().toString(36).slice(2)}.json`),
  OPENAI_BASE_URL: `${base}/v1`,
  GEMINI_BASE_URL: `${base}/gemini`,
  FAL_QUEUE_URL: `${base}/fal`,
  MODELARK_BASE_URL: `${base}/modelark`,
  ...extra,
});

const cli = async (args, e) => {
  try {
    const { stdout } = await run('node', [CLI, ...args], { env: e, cwd: dir });
    return { code: 0, out: stdout, json: args.includes('--json') ? JSON.parse(stdout) : null };
  } catch (err) {
    return { code: err.code, out: err.stdout + err.stderr, json: args.includes('--json') && err.stdout ? JSON.parse(err.stdout) : null };
  }
};

test('size helpers', () => {
  assert.equal(nearestAspect(1.75, ['1:1', '16:9', '4:3']), '16:9');
  const s = sizeForRatio(16 / 9);
  assert.equal(s.width % 16, 0);
  assert.equal(s.height % 16, 0);
  assert.equal(openaiSize({ size: null, aspect: null }, 'gpt-image-2'), 'auto');
  assert.equal(openaiSize({ size: null, aspect: '16:9' }, 'gpt-image-1.5'), '1536x1024');
  assert.equal(openaiSize({ size: { width: 2048, height: 1152 }, aspect: null }, 'gpt-image-2'), '2048x1152');
  assert.equal(sniffMime(PNG), 'image/png');
});

test('gemini request and response shapes', () => {
  const body = buildBody({ prompt: 'a cat', images: [], size: { width: 2048, height: 1152 }, aspect: null, format: null }, 'm');
  assert.deepEqual(body.response_format, { type: 'image', aspect_ratio: '16:9', image_size: '2K' });
  assert.equal(collectImages({ steps: [{ content: [{ type: 'image', data: PNG_B64 }] }] }).length, 1);
});

test('no key: clear error, exit 2, never a stack trace', async () => {
  const r = await cli(['generate', '-p', 'a cat', '--json'], env());
  assert.equal(r.code, 2);
  assert.equal(r.json.ok, false);
  assert.match(r.json.hint, /keys set openai/);
});

test('openai: generate, count, and no overwrite', async () => {
  const e = env({ OPENAI_API_KEY: 'sk-test-123456' });
  const r = await cli(['generate', '-p', 'A red fox', '-a', '16:9', '-q', 'low', '-n', '2', '-o', 'out/fox.png', '--json'], e);
  assert.equal(r.code, 0, r.out);
  assert.equal(r.json.files.length, 2);
  assert.match(r.json.files[0], /out\/fox-1\.png$/);
  assert.deepEqual(await readFile(r.json.files[0]), PNG);
  const sent = seen.findLast((s) => s.url === '/v1/images/generations');
  assert.equal(sent.headers.authorization, 'Bearer sk-test-123456');
  assert.equal(sent.body.model, 'gpt-image-2');
  assert.equal(sent.body.quality, 'low');
  assert.match(sent.body.size, /^\d+x\d+$/);
  const again = await cli(['generate', '-p', 'A red fox', '-n', '2', '-o', 'out/fox.png', '--json'], e);
  assert.match(again.json.files[0], /fox-1-v2\.png$/);
});

test('openai: edit sends the image as multipart', async () => {
  await writeFile(join(dir, 'in.png'), PNG);
  const r = await cli(['edit', '-i', 'in.png', '-p', 'make it blue', '--json'], env({ OPENAI_API_KEY: 'sk-test-123456' }));
  assert.equal(r.code, 0, r.out);
  const sent = seen.findLast((s) => s.url === '/v1/images/edits');
  assert.match(sent.headers['content-type'], /multipart\/form-data/);
  assert.match(sent.body, /name="image"; filename="in\.png"/);
  assert.match(r.json.files[0], /generated-images\/make-it-blue-/);
});

test('openai: transparent background is refused on gpt-image-2 with a way forward', async () => {
  const r = await cli(['generate', '-p', 'logo', '--background', 'transparent', '--json'], env({ OPENAI_API_KEY: 'sk-test-123456' }));
  assert.equal(r.code, 2);
  assert.match(r.json.hint, /gpt-image-1\.5/);
});

test('openai: transparent background is sent to the GPT Image 2.5 and 2.6 models that have it', async () => {
  for (const model of ['gpt-image-2.6-flare', 'gpt-image-2.6-sunburst', 'gpt-image-2.5-sunburst']) {
    const r = await cli(['generate', '-p', 'logo', '--model', model, '--background', 'transparent', '--json'], env({ OPENAI_API_KEY: 'sk-test-123456' }));
    assert.equal(r.code, 0, r.out);
    const sent = seen.findLast((s) => s.url === '/v1/images/generations');
    assert.equal(sent.body.model, model);
    assert.equal(sent.body.background, 'transparent');
  }
});

test('a rejected key is reported without leaking it', async () => {
  const r = await cli(['generate', '-p', 'a cat', '--json'], env({ OPENAI_API_KEY: 'bad-key' }));
  assert.equal(r.code, 2);
  assert.match(r.json.error, /HTTP 401/);
  assert.doesNotMatch(r.out, /bad-key/);
});

test('gemini and fal: full flows', async () => {
  const g = await cli(['generate', '--provider', 'gemini', '-p', 'a cat', '-a', '1:1', '--json'], env({ GEMINI_API_KEY: 'g-test-123456' }));
  assert.equal(g.code, 0, g.out);
  assert.equal(seen.findLast((s) => s.url === '/gemini/interactions').headers['x-goog-api-key'], 'g-test-123456');
  const f = await cli(['generate', '--provider', 'fal', '-p', 'a cat', '--json'], env({ FAL_KEY: 'f-test-123456' }));
  assert.equal(f.code, 0, f.out);
  const sent = seen.findLast((s) => s.url.startsWith('/fal/'));
  assert.equal(sent.url, '/fal/fal-ai/bytedance/seedream/v4/text-to-image');
  assert.equal(sent.headers.authorization, 'Key f-test-123456');
  assert.deepEqual(await readFile(f.json.files[0]), PNG);
});

test('modelark: one image per request, no watermark, sizes from the aspect, edits send the input images', async () => {
  const e = env({ TINTLOOM_MODELARK_KEY: 'm-test-123456' });
  const wide = await cli(['generate', '--provider', 'modelark', '-p', 'a cat', '-a', '16:9', '-n', '2', '--json'], e);
  assert.equal(wide.code, 0, wide.out);
  const sent = seen.filter((s) => s.url === '/modelark/images/generations');
  assert.equal(sent.length, 2, 'two images are two requests');
  const body = sent.at(-1).body;
  assert.equal(sent.at(-1).headers.authorization, 'Bearer m-test-123456');
  assert.deepEqual([body.model, body.watermark, body.response_format, body.output_format], ['dola-seedream-5-0-flash-260915', false, 'b64_json', undefined]);
  assert.equal(body.sequential_image_generation, undefined);
  const [w, h] = body.size.split('x').map(Number);
  assert.ok(Math.abs(w / h - 16 / 9) < 0.02 && w * h >= 921600 && w * h <= 4624220, body.size);
  assert.deepEqual(await readFile(wide.json.files[0]), PNG);
  const tall = await cli(['generate', '--provider', 'modelark', '-p', 'a cat', '-a', '9:16', '--json'], e);
  const [tw, th] = seen.findLast((s) => s.url === '/modelark/images/generations').body.size.split('x').map(Number);
  assert.ok(th > tw, 'tall stays tall');
  assert.equal(tall.code, 0);
  const input = join(dir, 'in.png');
  await writeFile(input, PNG);
  const edit = await cli(['edit', '--provider', 'modelark', '-i', input, '-p', 'make it blue', '--json'], e);
  assert.equal(edit.code, 0, edit.out);
  const editBody = seen.findLast((s) => s.url === '/modelark/images/generations').body;
  assert.deepEqual(editBody.image, [`data:image/png;base64,${PNG_B64}`]);
  assert.equal(editBody.size, '2048x2048', 'a 1x1 input keeps its shape');
  // What it cannot do is refused before anything is sent.
  const before = seen.length;
  const clear = await cli(['generate', '--provider', 'modelark', '-p', 'a cat', '--background', 'transparent', '--json'], e);
  assert.equal(clear.code, 2);
  assert.equal(seen.length, before);
  // A rejected key is reported without being printed.
  const bad = await cli(['generate', '--provider', 'modelark', '-p', 'a cat', '--json'], env({ ARK_API_KEY: 'bad-key' }));
  assert.equal(bad.code, 2);
  assert.doesNotMatch(bad.out, /bad-key/);
});

test('modelark: an image address must be https on ModelArk\'s own hosts; the stand-in only on its own origin', async () => {
  const e = env({ TINTLOOM_MODELARK_KEY: 'm-test-123456' });
  const before = seen.filter((s) => String(s.headers.host || '').startsWith('localhost')).length;
  const hostile = await cli(['generate', '--provider', 'modelark', '-p', 'HOSTILE', '--json'], e);
  assert.equal(hostile.code, 2, hostile.out);
  assert.match(hostile.json.error, /not one of its own/);
  assert.equal(seen.filter((s) => s.headers.host?.startsWith('localhost')).length, before, 'nothing was asked of the other host');
  const fine = await cli(['generate', '--provider', 'modelark', '-p', 'URLFILE', '--json'], e);
  assert.equal(fine.code, 0, fine.out);
  const { modelarkUrl } = await import('../plugins/tintloom/skills/image/scripts/providers/modelark.mjs');
  for (const good of ['https://ark-content-generation-ap-southeast-1.tos-ap-southeast-1.volces.com/a.png', 'https://x.bytepluses.com/a.png', 'https://x.byteplus.com/a.png']) assert.equal(modelarkUrl(good), good);
  for (const bad of ['http://x.volces.com/a.png', 'https://x.volces.com:8443/a.png', 'https://volces.com.evil.example/a.png', 'https://evilvolces.com/a.png', 'https://u@x.volces.com/a.png', 'https://169.254.169.254/x', 'nope']) assert.equal(modelarkUrl(bad), null, bad);
  assert.equal(modelarkUrl('http://127.0.0.1:9/f', { MODELARK_BASE_URL: 'http://127.0.0.1:9/m' }), 'http://127.0.0.1:9/f');
  assert.equal(modelarkUrl('http://localhost:9/f', { MODELARK_BASE_URL: 'http://127.0.0.1:9/m' }), null);
});

test('fal: addresses in fal\'s answer that are not fal\'s own are not followed, and never get the key', async () => {
  const offOrigin = () => seen.filter((s) => String(s.headers.host || '').startsWith('localhost'));
  const before = offOrigin().length;
  for (const prompt of ['hostile-queue', 'hostile-file']) {
    const r = await cli(['generate', '--provider', 'fal', '-p', prompt, '--json'], env({ FAL_KEY: 'f-test-123456' }));
    assert.equal(r.code, 2, r.out);
    assert.match(r.json.error, /not one of its own/);
  }
  assert.equal(offOrigin().length, before, 'nothing was asked of the other host');
  // The rule itself, without a stand-in: fal's queue host for the addresses that carry the key, fal's file hosts for images.
  const { falUrl } = await import('../plugins/tintloom/skills/image/scripts/providers/fal.mjs');
  assert.equal(falUrl('https://queue.fal.run/fal-ai/x/requests/1/status', 'queue'), 'https://queue.fal.run/fal-ai/x/requests/1/status');
  for (const bad of ['http://queue.fal.run/x', 'https://queue.fal.run:8443/x', 'https://evil.example/x', 'https://queue.fal.run.evil.example/x', 'https://user@queue.fal.run/x', 'https://v3.fal.media/x', 'not a url']) {
    assert.equal(falUrl(bad, 'queue'), null, bad);
  }
  for (const good of ['https://fal.media/files/a.png', 'https://v3.fal.media/files/a.png', 'https://storage.fal.run/a.png', 'https://cdn.fal.ai/a.png']) assert.equal(falUrl(good, 'file'), good);
  for (const bad of ['https://evil.example/a.png', 'https://notfal.media/a.png', 'https://fal.media.evil.example/a.png', 'http://fal.media/a.png', 'https://169.254.169.254/latest']) {
    assert.equal(falUrl(bad, 'file'), null, bad);
  }
  // A stand-in is trusted on its own origin only.
  assert.equal(falUrl('http://127.0.0.1:9/falq/1', 'queue', { FAL_QUEUE_URL: 'http://127.0.0.1:9/fal' }), 'http://127.0.0.1:9/falq/1');
  assert.equal(falUrl('http://localhost:9/falq/1', 'queue', { FAL_QUEUE_URL: 'http://127.0.0.1:9/fal' }), null);
});

test('keys set: saved 0600, used, listed, never printed', async () => {
  const e = env();
  const child = run('node', [CLI, 'keys', 'set', 'openai'], { env: e });
  child.child.stdin.end('sk-saved-abcdef\n');
  const { stdout } = await child;
  assert.doesNotMatch(stdout, /sk-saved/);
  assert.equal((await stat(e.TINTLOOM_CONFIG)).mode & 0o777, 0o600);
  const list = await cli(['providers', '--json'], e);
  assert.equal(list.json.providers.find((p) => p.id === 'openai').hasKey, true);
  assert.doesNotMatch(list.out, /sk-saved/);
  const show = await cli(['config', 'show'], e);
  assert.doesNotMatch(show.out, /sk-saved/);
  const r = await cli(['generate', '-p', 'a cat', '--json'], e);
  assert.equal(r.code, 0, r.out);
  assert.equal(seen.findLast((s) => s.url === '/v1/images/generations').headers.authorization, 'Bearer sk-saved-abcdef');
});

test('output paths follow the returned file type', async () => {
  const [p] = await outputPaths('pic.png', 'x', [{ mime: 'image/jpeg' }], false, dir);
  assert.match(p, /pic\.jpg$/);
});

test('MCP: get_upload_url on the local server says to pass the path; where it cannot work it is not listed', async () => {
  const names = async (ctx) => (await handleMessage({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, ctx)).result.tools.map((t) => t.name);
  const local = { env: env(), mode: 'stdio', store: new ImageStore(), projectDir: dir };
  const tool = (await handleMessage({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, local)).result.tools.find((t) => t.name === 'get_upload_url');
  assert.match(tool.description, /pass the file's path in `images: \[\{ path \}\]`/);
  assert.deepEqual(tool.inputSchema.properties, {});
  const said = await handleMessage({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'get_upload_url', arguments: {} } }, local);
  assert.equal(said.result.isError, undefined);
  assert.match(said.result.content[0].text, /[Pp]ass the file's path in `images: \[\{ path \}\]`/);
  // A server that neither reads local files nor issues upload addresses (the local --http server, the old edge function) does not offer it, and refuses it if called.
  const remote = { env: env(), mode: 'http', store: new ImageStore(), projectDir: dir };
  assert.equal((await names(remote)).includes('get_upload_url'), false);
  const refused = await handleMessage({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'get_upload_url', arguments: {} } }, remote);
  assert.equal(refused.result.isError, true);
  // A host that issues addresses lists it with the full description and answers with its commands.
  const host = { ...remote, uploads: { ticket: async () => ({ putUrl: 'https://files.example/put?token=a', doneUrl: 'https://tintloom.example/api/upload/t/done', expiresInSeconds: 600, maxBytes: 25 * 1024 * 1024 }) } };
  const listed = (await handleMessage({ jsonrpc: '2.0', id: 5, method: 'tools/list' }, host)).result.tools.find((t) => t.name === 'get_upload_url');
  assert.match(listed.description, /one-time address/);
  const got = await handleMessage({ jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'get_upload_url', arguments: { mime: 'image/webp' } } }, host);
  assert.equal(got.result.structuredContent.command, "curl -sS --fail-with-body -X PUT --data-binary @/path/to/file -H 'content-type: image/webp' 'https://files.example/put?token=a' && echo && curl -sS --fail-with-body -X POST 'https://tintloom.example/api/upload/t/done'");
});

test('MCP: handshake, tools, and a notification gets no reply', async () => {
  const ctx = { env: env(), mode: 'stdio', store: new ImageStore(), projectDir: dir };
  const init = await handleMessage({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } }, ctx);
  assert.equal(init.result.serverInfo.name, 'tintloom');
  assert.equal(await handleMessage({ jsonrpc: '2.0', method: 'notifications/initialized' }, ctx), null);
  const tools = await handleMessage({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, ctx);
  assert.deepEqual(tools.result.tools.map((t) => t.name), ['generate_image', 'list_image_providers', 'get_upload_url', 'save_mask', 'save_selection', 'get_progress', 'get_layer_set', 'get_generated_image']);
  assert.equal(tools.result.tools[0]._meta.ui.resourceUri, CARD_URI);
  assert.deepEqual(tools.result.tools[4]._meta.ui.visibility, ['app']);
  const card = await handleMessage({ jsonrpc: '2.0', id: 4, method: 'resources/read', params: { uri: CARD_URI } }, ctx);
  assert.equal(card.result.contents[0].mimeType, 'text/html;profile=mcp-app');
  assert.match(card.result.contents[0].text, /ui\/initialize/);
  const missing = await handleMessage({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'generate_image', arguments: { prompt: 'a cat' } } }, ctx);
  assert.equal(missing.result.isError, true);
  assert.match(missing.result.content[0].text, /server environment/);
});

test('MCP over HTTP: token, generate, edit from base64, and the file link', async () => {
  const server = createHttpServer({ ...env({ OPENAI_API_KEY: 'sk-test-123456' }), TINTLOOM_SERVER_TOKEN: 'secret-token' });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const root = `http://127.0.0.1:${server.address().port}`;
  const post = (path, body, headers = {}) => fetch(root + path, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
  try {
    assert.equal((await post('/mcp', { jsonrpc: '2.0', id: 1, method: 'ping' })).status, 401);
    assert.equal((await post('/mcp/wrong', { jsonrpc: '2.0', id: 1, method: 'ping' })).status, 401);
    assert.equal((await post('/mcp', { jsonrpc: '2.0', method: 'notifications/initialized' }, { Authorization: 'Bearer secret-token' })).status, 202);

    const call = (args) => post('/mcp/secret-token', { jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'generate_image', arguments: args } }).then((r) => r.json());
    const made = await call({ prompt: 'a cat', aspect: '1:1' });
    assert.equal(made.result.isError, undefined, JSON.stringify(made));
    assert.equal(made.result.content[1].type, 'image');
    assert.equal(seen.findLast((s) => s.url === '/v1/images/generations').body.output_format, 'png');
    // Several different images in one call: one request each, and the card can ask which are ready.
    const { progressKey } = await import('../plugins/tintloom/server/core.mjs');
    const trio = { prompts: ['an apple', 'a pear', 'cherries'] };
    const three = await call(trio);
    assert.equal(three.result.structuredContent.images.length, 3, JSON.stringify(three).slice(0, 300));
    assert.deepEqual(three.result.structuredContent.images.map((i) => i.prompt), trio.prompts);
    // Each image names the copy of itself carried in the result, which the card shows at once.
    // Each image names its copy by its place among the image parts, which holds even when an app adds parts of its own.
    const pictures = three.result.content.filter((c) => c.type === 'image');
    assert.equal(three.result.structuredContent.pics, pictures.length);
    assert.deepEqual(three.result.structuredContent.images.map((i) => i.pic), [0, 1, 2]);
    const state = await post('/mcp/secret-token', { jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'get_progress', arguments: { key: progressKey(trio) } } }).then((r) => r.json());
    assert.equal(state.result.structuredContent.total, 3);
    assert.deepEqual(state.result.structuredContent.images.map((i) => i.index).sort(), [0, 1, 2]);
    const [image] = made.result.structuredContent.images;
    const loaded = await post('/mcp/secret-token', { jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'get_generated_image', arguments: { id: image.id } } }).then((r) => r.json());
    assert.equal(loaded.result.structuredContent.chunk, PNG_B64);
    assert.equal(loaded.result.structuredContent.total, PNG_B64.length);
    assert.match(made.result.structuredContent.note, /pass its id/);
    const link = image.url;
    const file = await fetch(link);
    assert.equal(file.status, 200);
    assert.deepEqual(Buffer.from(await file.arrayBuffer()), PNG);
    assert.equal((await fetch(`${root}/files/nope.png`)).status, 404);

    const edited = await call({ prompt: 'make it blue', images: [{ id: image.id }] });
    assert.equal(edited.result.isError, undefined, JSON.stringify(edited));
    assert.equal(seen.at(-1).url, '/v1/images/edits');

    assert.equal((await call({ prompt: 'x', images: [{ path: '/etc/hosts' }] })).result.isError, true);
    const blocked = await call({ prompt: 'x', images: [{ url: 'http://127.0.0.1/secret.png' }] });
    assert.equal(blocked.result.isError, true);
  } finally {
    server.close();
  }
});

test('MCP stdio mode: saves into the project, edits by path, ignores blank plugin settings', async () => {
  const blank = { TINTLOOM_OPENAI_KEY: '', TINTLOOM_GEMINI_KEY: '${user_config.gemini_api_key}', TINTLOOM_DEFAULT_PROVIDER: 'auto', TINTLOOM_HOST: 'plugin' };
  const none = { env: env(blank), mode: 'stdio', store: new ImageStore(), projectDir: dir };
  const call = (ctx, args) => handleMessage({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'generate_image', arguments: args } }, ctx);
  const missing = await call(none, { prompt: 'a cat' });
  assert.equal(missing.result.isError, true);
  assert.match(missing.result.content[0].text, /\/plugin/);

  const ctx = { ...none, env: env({ ...blank, TINTLOOM_OPENAI_KEY: 'sk-plugin-123456' }) };
  const made = await call(ctx, { prompt: 'a cat', out: 'assets/cat.png' });
  assert.equal(made.result.isError, undefined, JSON.stringify(made));
  const [image] = made.result.structuredContent.images;
  assert.equal(image.path, join(dir, 'assets/cat.png'));
  assert.deepEqual(await readFile(image.path), PNG);
  assert.equal(seen.at(-1).headers.authorization, 'Bearer sk-plugin-123456');
  const edited = await call(ctx, { prompt: 'make it blue', images: [{ path: 'assets/cat.png' }] });
  assert.equal(edited.result.isError, undefined, JSON.stringify(edited));
  assert.equal(seen.at(-1).url, '/v1/images/edits');
});

test('masks: regions and painted selections limit an edit', async () => {
  const source = encodePng(64, 32, Buffer.alloc(64 * 32 * 4, 200));
  assert.deepEqual(imageSize(source), { width: 64, height: 32 });
  const mask = maskFromRegions(source, [{ x: 0, y: 0, width: 0.5, height: 1 }]);
  assert.deepEqual(imageSize(mask), { width: 64, height: 32 });
  assert.throws(() => maskFromRegions(source, [{ x: 2, y: 2, width: 0.1, height: 0.1 }]), /does not cover/);

  await writeFile(join(dir, 'wide.png'), source);
  const ctx = { env: env({ OPENAI_API_KEY: 'sk-test-123456' }), mode: 'stdio', store: new ImageStore(), projectDir: dir };
  const call = (name, args) => handleMessage({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }, ctx);

  const byRegion = await call('generate_image', { prompt: 'add a moon', images: [{ path: 'wide.png' }], edit_regions: [{ x: 0.5, y: 0, width: 0.5, height: 0.5 }], model: 'gpt-image-1.5', fidelity: 'high' });
  assert.equal(byRegion.result.isError, undefined, JSON.stringify(byRegion));
  // A change to one part: the provider gets the image and a guide to where, not a mask (it cannot see under one).
  assert.doesNotMatch(seen.at(-1).body, /name="mask"/);
  assert.match(seen.at(-1).body, /filename="where\.png"/);
  assert.match(seen.at(-1).body, /only a guide to where/);
  assert.match(seen.at(-1).body, /name="input_fidelity"\r\n\r\nhigh/);
  // An erase still sends the mask, over an image with that area blanked.
  const gone = await call('generate_image', { prompt: 'remove it', images: [{ path: 'wide.png' }], edit_regions: [{ x: 0.5, y: 0, width: 0.5, height: 0.5 }], erase: true });
  assert.equal(gone.result.isError, undefined, JSON.stringify(gone));
  assert.match(seen.at(-1).body, /name="mask"; filename="mask\.png"/);

  // The card says which image is open and what was painted; the message then needs no ids.
  const open = await ctx.store.put({ bytes: source, mime: 'image/png' });
  assert.equal((await call('save_selection', { image: open, mask: mask.toString('base64') })).result.structuredContent.saved, true);
  const chosen = await call('generate_image', { prompt: 'make it blue', selection: true });
  assert.equal(chosen.result.isError, undefined, JSON.stringify(chosen).slice(0, 300));
  assert.match(seen.at(-1).body, /filename="where\.png"/);
  // An app that does not know `selection` yet: a call right after the card spoke, naming no image, still gets it.
  await call('save_selection', { image: open, regions: [{ x: 0, y: 0, width: 0.5, height: 1 }], erase: true });
  const implied = await call('generate_image', { prompt: 'fill it in' });
  assert.equal(implied.result.isError, undefined, JSON.stringify(implied).slice(0, 300));
  assert.equal(seen.at(-1).url, '/v1/images/edits');
  assert.match(seen.at(-1).body, /name="mask"; filename="mask\.png"/);
  // Used once: the next plain request is a new image again.
  await call('generate_image', { prompt: 'a new picture' });
  assert.equal(seen.at(-1).url, '/v1/images/generations');

  const saved = await call('save_mask', { data: mask.toString('base64') });
  const painted = await call('generate_image', { prompt: 'add a moon', images: [{ path: 'wide.png' }], mask: { id: saved.result.structuredContent.id } });
  assert.equal(painted.result.isError, undefined, JSON.stringify(painted));
  assert.doesNotMatch(seen.at(-1).body, /input_fidelity/);

  const wrongSize = await call('save_mask', { data: PNG_B64 });
  const mismatch = await call('generate_image', { prompt: 'x', images: [{ path: 'wide.png' }], mask: { id: wrongSize.result.structuredContent.id } });
  assert.match(mismatch.result.content[0].text, /same shape/);
  // A mask painted on a smaller copy of the image (same shape) is stretched to fit, not refused.
  const full = imageSize(await readFile(join(dir, 'wide.png')));
  const half = { width: full.width / 2, height: full.height / 2 };
  const halfPx = Buffer.alloc(half.width * half.height * 4, 255);
  halfPx[3] = 0;
  const small = await call('save_mask', { data: encodePng(half.width, half.height, halfPx).toString('base64') });
  const stretched = await call('generate_image', { prompt: 'add a moon', images: [{ path: 'wide.png' }], mask: { id: small.result.structuredContent.id } });
  assert.equal(stretched.result.isError, undefined, JSON.stringify(stretched).slice(0, 300));
  assert.equal((await call('generate_image', { prompt: 'x', edit_regions: [{ x: 0, y: 0, width: 1, height: 1 }] })).result.isError, true);
});

test('cloud connect: creates an account once, uploads local keys, prints the connector URL', async () => {
  const e = env({ TINTLOOM_CLOUD_API: `${base}/cloud`, OPENAI_API_KEY: 'sk-local-123456' });
  const first = await cli(['cloud', 'connect'], e);
  assert.equal(first.code, 0, first.out);
  assert.match(first.out, /Uploaded keys for: OpenAI/);
  assert.match(first.out, /\/cloud\/u\/tok_cloud_/);
  assert.doesNotMatch(first.out, /sk-local/);
  const put = seen.findLast((s) => s.url === '/cloud/keys/openai');
  assert.equal(put.method, 'PUT');
  assert.equal(put.body.key, 'sk-local-123456');
  assert.equal(put.headers.authorization, 'Bearer tok_cloud_0123456789abcdef0123456789abcdef');
  const before = seen.filter((s) => s.url === '/cloud/accounts').length;
  await cli(['cloud', 'connect'], e);
  assert.equal(seen.filter((s) => s.url === '/cloud/accounts').length, before);
  const status = await cli(['cloud', 'status'], e);
  assert.match(status.out, /\[key set\] openai/);
  assert.doesNotMatch((await cli(['config', 'show'], e)).out, /tok_cloud/);
});

test('two copies of the local server share images: one makes it, the other serves it to the card', async () => {
  const shared = join(dir, 'shared-store');
  const e = env({ OPENAI_API_KEY: 'sk-test-123456' });
  const session = { env: e, mode: 'stdio', store: new DiskImageStore(shared), projectDir: dir };
  const cardHost = { env: e, mode: 'stdio', store: new DiskImageStore(shared), projectDir: dir };
  const call = (ctx, name, args) => handleMessage({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }, ctx);
  const made = await call(session, 'generate_image', { prompt: 'a cat' });
  const { id } = made.result.structuredContent.images[0];
  const shown = await call(cardHost, 'get_generated_image', { id });
  assert.equal(shown.result.structuredContent.chunk, PNG_B64);
  // and the other way: a mask painted in the card is usable by the session's copy
  const mask = await call(cardHost, 'save_mask', { data: PNG_B64 });
  const edited = await call(session, 'generate_image', { prompt: 'x', images: [{ id }], mask: { id: mask.result.structuredContent.id } });
  assert.equal(edited.result.isError, undefined, JSON.stringify(edited));
  assert.equal((await call(cardHost, 'get_generated_image', { id: 'img_../../etc/passwd000000' })).result.isError, true);
});

test('previews: a PNG is decoded, shrunk and re-encoded without any tools', async () => {
  const w = 96, h = 64;
  const rgba = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) rgba.set([x * 2, y * 3, 120, 255], (y * w + x) * 4);
  const png = encodePng(w, h, rgba);
  const back = decodePng(png);
  assert.equal(back.width, w);
  assert.deepEqual(back.rgba, rgba);
  const small = shrinkPng(png, 32);
  assert.deepEqual(imageSize(small), { width: 32, height: 21 });
  assert.equal(shrinkPng(Buffer.from('not a png at all, just some text bytes here'), 32), null);
  // off the Mac the card still gets a preview, but no model-visible thumbnail
  const made = await makePreview({ bytes: png }, { id: 'img_test', path: null }, 'linux');
  assert.match(made.preview, /^data:image\/png;base64,/);
  assert.equal(made.thumb, null);
});

test('browser-based apps can connect: preflight is answered and replies carry CORS headers', async () => {
  const server = createHttpServer({ ...env(), TINTLOOM_SERVER_TOKEN: 'secret-token' });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const root = `http://127.0.0.1:${server.address().port}`;
  try {
    const pre = await fetch(`${root}/mcp/secret-token`, { method: 'OPTIONS', headers: { Origin: 'http://localhost:8080', 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type,mcp-protocol-version' } });
    assert.equal(pre.status, 204);
    assert.equal(pre.headers.get('access-control-allow-origin'), '*');
    assert.match(pre.headers.get('access-control-allow-headers'), /mcp-protocol-version/);
    const res = await fetch(`${root}/mcp/secret-token`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }) });
    assert.equal(res.headers.get('access-control-allow-origin'), '*');
    assert.equal((await fetch(`${root}/mcp/wrong`, { method: 'POST', body: '{}' })).status, 401);
  } finally {
    server.close();
  }
});

test('masked edits are strict: outside the mask stays, erase blanks the area first', async () => {
  const { encodePng, decodePng, clearUnderMask, keepOutsideMask } = await import('../plugins/tintloom/skills/image/scripts/lib/png.mjs');
  const solid = (r, g, b, a = 255) => { const px = Buffer.alloc(40 * 40 * 4); for (let i = 0; i < px.length; i += 4) px.set([r, g, b, a], i); return px; };
  const original = encodePng(40, 40, solid(255, 0, 0));
  const result = encodePng(40, 40, solid(0, 0, 255));
  const maskPx = solid(0, 0, 0);
  for (let y = 10; y < 30; y++) for (let x = 10; x < 30; x++) maskPx[(y * 40 + x) * 4 + 3] = 0;
  const mask = encodePng(40, 40, maskPx);
  const at = (img, x, y) => [...img.rgba.subarray((y * 40 + x) * 4, (y * 40 + x) * 4 + 4)];
  const kept = decodePng(keepOutsideMask(original, result, mask, 2));
  assert.deepEqual(at(kept, 1, 1), [255, 0, 0, 255]);
  assert.deepEqual(at(kept, 20, 20), [0, 0, 255, 255]);
  const cleared = decodePng(clearUnderMask(original, mask));
  assert.deepEqual(at(cleared, 20, 20), [0, 0, 0, 0]);
  assert.deepEqual(at(cleared, 1, 1), [255, 0, 0, 255]);
  assert.equal(keepOutsideMask(original, encodePng(20, 20, Buffer.alloc(1600)), mask), null);
});

// ---- Splitting an image into layers (Seedream on ModelArk, layer_decomposition) ----
const BIG = encodePng(600, 600, Buffer.alloc(600 * 600 * 4, 180));
const layerRequests = () => seen.filter((s) => s.url === '/modelark/images/generations' && s.body.layer_decomposition);

test('layers (CLI): body shape, z_index order, names, files', async () => {
  const e = env({ TINTLOOM_MODELARK_KEY: 'm-test-123456' });
  const input = join(dir, 'layers-in.png');
  await writeFile(input, BIG);
  const r = await cli(['edit', '--provider', 'modelark', '-i', input, '--layers', '-o', 'layers-out/', '--json'], e);
  assert.equal(r.code, 0, r.out);
  const sent = layerRequests().at(-1);
  assert.equal(sent.headers.authorization, 'Bearer m-test-123456');
  const body = sent.body;
  assert.deepEqual([body.layer_decomposition, body.size, body.response_format, body.watermark, body.output_format], [true, '2K', 'b64_json', false, 'png']);
  assert.equal(typeof body.image, 'string', 'one input image, as a string');
  assert.match(body.image, /^data:image\/png;base64,/);
  assert.equal('background' in body || 'sequential_image_generation' in body || 'layer_decomposition_options' in body, false);
  assert.equal(body.model, 'dola-seedream-5-0-flash-260915');
  // The stand-in answers in reverse; the files come out base first, in z_index order, each named.
  assert.deepEqual(r.json.layers.map((l) => [l.z_index, l.name]), [[0, 'Base'], [1, 'Layer 1 name'], [2, 'Layer 2 name'], [3, 'Layer 3 name']]);
  assert.equal(r.json.layers[2].description, 'Element number 2');
  assert.equal(r.json.files.length, 4);
  assert.equal(r.json.left_out, undefined);
  for (const f of r.json.files) assert.deepEqual(await readFile(f), PNG);
  assert.match(r.json.files[0], /-1\.png$/);
  // With only the flag the provider is forced to modelark, whatever the default is.
  const forced = await cli(['edit', '-i', input, '--layers', '--json'], env({ TINTLOOM_MODELARK_KEY: 'm-test-123456', OPENAI_API_KEY: 'sk-test-123456', TINTLOOM_DEFAULT_PROVIDER: 'openai' }));
  assert.equal(forced.code, 0, forced.out);
  assert.equal(forced.json.provider, 'modelark');
  const help = await cli(['--help'], e);
  assert.match(help.out, /--layers/);
});

test('layers (CLI): over 10 images keeps the base and the 9 largest layers, in z_index order, and says so', async () => {
  const e = env({ TINTLOOM_MODELARK_KEY: 'm-test-123456' });
  const input = join(dir, 'layers-in.png');
  await writeFile(input, BIG);
  const r = await cli(['edit', '--provider', 'modelark', '-i', input, '--layers', '-p', 'LAYERS14', '-o', 'layers-many/', '--json'], e);
  assert.equal(r.code, 0, r.out);
  // 14 images came back (base + layers 1..13). The largest 9 layers are 5..13; 1..4 are the small ones left out.
  assert.deepEqual(r.json.layers.map((l) => l.z_index), [0, 5, 6, 7, 8, 9, 10, 11, 12, 13]);
  assert.equal(r.json.files.length, 10);
  assert.equal(r.json.left_out, 4);
  const text = await cli(['edit', '--provider', 'modelark', '-i', input, '--layers', '-p', 'LAYERS14', '-o', 'layers-many2/'], e);
  assert.match(text.out, /4 further small layers were left out/);
  // Exactly 10 returned: nothing left out.
  const ten = await cli(['edit', '--provider', 'modelark', '-i', input, '--layers', '-p', 'LAYERS10', '-o', 'layers-ten/', '--json'], e);
  assert.equal(ten.json.files.length, 10);
  assert.equal(ten.json.left_out, undefined);
});

test('layers (CLI): an address in the answer is followed only on the stand-in\'s own origin', async () => {
  const input = join(dir, 'layers-in.png');
  await writeFile(input, BIG);
  const r = await cli(['edit', '--provider', 'modelark', '-i', input, '--layers', '-p', 'URLS', '-o', 'layers-url/', '--json'], env({ TINTLOOM_MODELARK_KEY: 'm-test-123456' }));
  assert.equal(r.code, 0, r.out);
  assert.equal(r.json.files.length, 4);
  assert.deepEqual(await readFile(r.json.files[1]), PNG);
});

test('layers (CLI): what cannot be split is refused before any request', async () => {
  const e = env({ TINTLOOM_MODELARK_KEY: 'm-test-123456' });
  const input = join(dir, 'layers-in.png');
  const tiny = join(dir, 'layers-tiny.png');
  const second = join(dir, 'layers-in-2.png');
  await writeFile(input, BIG);
  await writeFile(second, BIG);
  await writeFile(tiny, PNG);
  const attempts = [
    [['edit', '--provider', 'modelark', '--layers'], /image/],
    [['edit', '-i', input, '-i', second, '--provider', 'modelark', '--layers'], /exactly one image/],
    [['edit', '-i', input, '--mask', second, '--provider', 'modelark', '--layers'], /whole image/],
    [['edit', '-i', input, '-n', '2', '--provider', 'modelark', '--layers'], /one split at a time/],
    [['edit', '-i', input, '--provider', 'openai', '--layers'], /ModelArk only/],
    [['edit', '-i', tiny, '--provider', 'modelark', '--layers'], /512x512 to 6000x6000/],
  ];
  const before = seen.length;
  for (const [args, message] of attempts) {
    const r = await cli([...args, '--json'], e);
    assert.equal(r.code, 2, args.join(' '));
    assert.match(r.json.error, message);
  }
  assert.equal(seen.length, before, 'nothing was sent');
  const noKey = await cli(['edit', '-i', input, '--layers', '--json'], env());
  assert.equal(noKey.code, 2);
  assert.match(noKey.json.error, /ModelArk/);
  // The provider's own refusal is shown, without the key.
  const refused = await cli(['edit', '--provider', 'modelark', '-i', input, '--layers', '--json'], env({ TINTLOOM_MODELARK_KEY: 'bad-key' }));
  assert.equal(refused.code, 2);
  assert.doesNotMatch(refused.out, /bad-key/);
});

test('layers (MCP): routes to Seedream whatever model/provider say, returns named layers with ids, and refuses the rest', async () => {
  const ctx = { env: env({ TINTLOOM_MODELARK_KEY: 'm-test-123456', OPENAI_API_KEY: 'sk-test-123456' }), mode: 'stdio', store: new ImageStore(), projectDir: dir, session: { ui: true } };
  const call = (name, args, c = ctx) => handleMessage({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }, c);
  const tools = await handleMessage({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, ctx);
  const tool = tools.result.tools[0];
  assert.equal(tool.inputSchema.properties.layers.type, 'boolean');
  assert.match(tool.description, /split or separate an image into layers/);
  const card = await handleMessage({ jsonrpc: '2.0', id: 9, method: 'resources/read', params: { uri: CARD_URI } }, ctx);
  assert.match(card.result.contents[0].text, /id="ldl-image"/, 'the card carries the layer view');
  await writeFile(join(dir, 'scene.png'), BIG);
  const made = await call('generate_image', { images: [{ path: 'scene.png' }], layers: true, provider: 'openai', model: 'gpt-image-1.5', quality: 'high', out: 'layers-mcp/' });
  assert.equal(made.result.isError, undefined, JSON.stringify(made));
  const sent = layerRequests().at(-1);
  assert.equal(sent.body.model, 'dola-seedream-5-0-flash-260915');
  assert.equal(sent.body.size, '2K');
  const images = made.result.structuredContent.images;
  assert.deepEqual(images.map((i) => i.name), ['Base', 'Layer 1 name', 'Layer 2 name', 'Layer 3 name']);
  assert.deepEqual(images.map((i) => i.transparent), [false, true, true, true]);
  assert.deepEqual(images.map((i) => i.layer), [0, 1, 2, 3]);
  assert.equal(made.result.structuredContent.layers, true);
  assert.equal(new Set(images.map((i) => i.id)).size, 4);
  const text = made.result.content[0].text;
  assert.match(text, /Split the image into 4 layers/);
  assert.match(text, /Layer 2 name \(Element number 2\)/);
  assert.match(made.result.structuredContent.note, /sees all 4 layers/);
  assert.match(made.result.structuredContent.note, /pass it in `images` to edit that layer/);
  assert.equal(made.result.content.filter((c) => c.type === 'image').length, 4);
  // Each layer is an ordinary image with an id: it can be edited next.
  const next = await call('generate_image', { prompt: 'make it blue', images: [{ id: images[1].id }] });
  assert.equal(next.result.isError, undefined, JSON.stringify(next));
  // Without the card the model is told the user has not seen them.
  const plain = await call('generate_image', { images: [{ path: 'scene.png' }], layers: true, out: 'layers-mcp2/' }, { ...ctx, session: { ui: false } });
  assert.match(plain.result.content[0].text, /has NOT seen the layers/);
  // The area painted in the card is not applied: the whole image is split, from the open image alone.
  const openId = await ctx.store.put({ bytes: BIG, mime: 'image/png' });
  await call('save_selection', { image: openId, mask: PNG_B64 });
  const before = layerRequests().length;
  const picked = await call('generate_image', { layers: true, selection: true, out: 'layers-mcp3/' });
  assert.equal(picked.result.isError, undefined, JSON.stringify(picked));
  assert.equal(layerRequests().length, before + 1);
  assert.equal(typeof layerRequests().at(-1).body.image, 'string');
  // Refusals, each with a message for the user, and nothing sent.
  const sentBefore = seen.length;
  const refusals = [
    [{ layers: true }, /needs the image to split/],
    [{ layers: true, images: [{ path: 'scene.png' }, { path: 'scene.png' }] }, /exactly one image, and 2 were given/],
    [{ layers: true, images: [{ path: 'scene.png' }], mask: { path: 'scene.png' } }, /whole image/],
    [{ layers: true, images: [{ path: 'scene.png' }], edit_regions: [{ x: 0, y: 0, width: 1, height: 1 }] }, /whole image/],
    [{ layers: true, images: [{ path: 'scene.png' }], erase: true }, /whole image/],
    [{ layers: true, prompts: ['a', 'b'], images: [{ path: 'scene.png' }] }, /one image at a time/],
    [{ layers: true, count: 3, images: [{ path: 'scene.png' }] }, /one split at a time/],
  ];
  for (const [args, message] of refusals) {
    const r = await call('generate_image', args);
    assert.equal(r.result.isError, true, JSON.stringify(args));
    assert.match(r.result.content[0].text, message, JSON.stringify(args));
  }
  assert.equal(seen.length, sentBefore, 'nothing was sent to any provider');
  // No ModelArk key: a clear message, not a call to another provider.
  const noKey = await call('generate_image', { images: [{ path: 'scene.png' }], layers: true }, { ...ctx, env: env({ OPENAI_API_KEY: 'sk-test-123456', TINTLOOM_HOST: 'plugin' }) });
  assert.equal(noKey.result.isError, true);
  assert.match(noKey.result.content[0].text, /BytePlus ModelArk key/);
  assert.equal(seen.length, sentBefore);
  const cloud = await call('generate_image', { images: [{ path: 'scene.png' }], layers: true }, { ...ctx, env: env({ OPENAI_API_KEY: 'sk-test-123456', TINTLOOM_HOST: 'cloud' }) });
  assert.match(cloud.result.content[0].text, /not available on this service/);
});

// ---- Display-size copies for the layer view ----
const CRC = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crcOf = (buf) => { let c = 0xffffffff; for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
const pngChunk = (type, data) => {
  const body = Buffer.concat([Buffer.from(type), data]);
  const out = Buffer.alloc(body.length + 8);
  out.writeUInt32BE(data.length, 0);
  body.copy(out, 4);
  out.writeUInt32BE(crcOf(body), body.length + 4);
  return out;
};
/** An 8-bit palette PNG (what ModelArk's base layer is), 4 colours, one of them half transparent. */
function paletteImage(width, height) {
  const head = Buffer.alloc(13);
  head.writeUInt32BE(width, 0);
  head.writeUInt32BE(height, 4);
  head.set([8, 3, 0, 0, 0], 8);
  const rows = Buffer.alloc((width + 1) * height);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) rows[y * (width + 1) + 1 + x] = (x < width / 2 ? 0 : 1) + (y < height / 2 ? 0 : 2);
  const plte = Buffer.from([255, 0, 0, 0, 255, 0, 0, 0, 255, 255, 255, 0]);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), pngChunk('IHDR', head), pngChunk('PLTE', plte), pngChunk('tRNS', Buffer.from([255, 255, 255, 128])), pngChunk('IDAT', deflateSync(rows)), pngChunk('IEND', Buffer.alloc(0))]);
}

test('png: a palette image (with its transparency) can be read and shrunk, so a layer set\'s base gets a small copy', () => {
  const palette = paletteImage(64, 32);
  const read = decodePng(palette);
  assert.deepEqual([read.width, read.height], [64, 32]);
  assert.deepEqual([...read.rgba.subarray(0, 4)], [255, 0, 0, 255], 'top left: palette entry 0');
  assert.deepEqual([...read.rgba.subarray((0 * 64 + 40) * 4, (0 * 64 + 40) * 4 + 4)], [0, 255, 0, 255], 'top right: entry 1');
  assert.deepEqual([...read.rgba.subarray((20 * 64 + 40) * 4, (20 * 64 + 40) * 4 + 4)], [255, 255, 0, 128], 'bottom right: entry 3, half transparent');
  const small = shrinkPng(palette, 16);
  assert.deepEqual(imageSize(small), { width: 16, height: 8 });
  // Colours are weighted by alpha: shrinking a transparent edge does not darken it.
  const edge = encodePng(2, 2, Buffer.from([200, 100, 50, 255, 0, 0, 0, 0, 200, 100, 50, 255, 0, 0, 0, 0]));
  assert.deepEqual([...decodePng(shrinkPng(edge, 1)).rgba], [200, 100, 50, 127]);
});

test('get_generated_image: `edge` sends a smaller copy of a PNG, transparency kept; without it the full image; the pieces agree', async () => {
  const w = 200, h = 150;
  const noise = Buffer.alloc(w * h * 4);
  for (let i = 0; i < noise.length; i += 4) noise.set([(i * 7) & 255, (i * 13) & 255, (i * 31) & 255, i % 8 ? 255 : 0], i);
  const full = encodePng(w, h, noise);
  const store = new ImageStore();
  const ctx = { env: env(), mode: 'stdio', store, projectDir: dir };
  const id = await store.put({ bytes: full, mime: 'image/png' });
  const get = (args) => handleMessage({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'get_generated_image', arguments: { id, ...args } } }, ctx).then((r) => r.result.structuredContent);
  const whole = await get({});
  assert.equal(Buffer.from(whole.chunk, 'base64').equals(full), true);
  const small = await get({ edge: 100 });
  const smallBytes = Buffer.from(small.chunk, 'base64');
  assert.equal(small.mime, 'image/png');
  assert.deepEqual(imageSize(smallBytes), { width: 100, height: 75 });
  assert.ok(smallBytes.length < full.length * 0.6, `${smallBytes.length} against ${full.length}`);
  assert.ok(decodePng(smallBytes).rgba.some((v, i) => i % 4 === 3 && v < 255), 'still has transparent pixels');
  // Pieces of one copy join into that copy (the copy is made once, not differently for each piece).
  assert.equal(small.total, small.chunk.length);
  // A copy that would not be smaller is the image itself; a JPEG is never shrunk.
  assert.equal(Buffer.from((await get({ edge: 2000 })).chunk, 'base64').equals(full), true);
  const jpeg = await store.put({ bytes: Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4, 5, 6]), mime: 'image/jpeg' });
  const sent = await handleMessage({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'get_generated_image', arguments: { id: jpeg, edge: 100 } } }, ctx);
  assert.equal(sent.result.structuredContent.mime, 'image/jpeg');
});

test('card: layers load from display-size copies behind a loader, and a failed layer can be retried', async () => {
  const card = (await handleMessage({ jsonrpc: '2.0', id: 4, method: 'resources/read', params: { uri: CARD_URI } }, { env: env(), mode: 'stdio', store: new ImageStore(), projectDir: dir, cardHtml: await readFile(new URL('../plugins/tintloom/server/ui/image-card.html', import.meta.url), 'utf8') })).result.contents[0].text;
  assert.match(card, /Loading the layers/);
  assert.match(card, /fetchImage\(item\.image\.id, 1024\)/, 'the stage asks for the 1024px copy');
  assert.match(card, /class = 'retry'|className = 'retry'/);
  assert.match(card, /\.lbox img \{[^}]*opacity: 0/, 'a picture is invisible until it is ready');
});

// ---- A reloaded chat: everything the layer view needs is in what is replayed, and is also kept by id ----
const layerViewNeeds = (set) => {
  assert.equal(set.layers, true);
  assert.ok(set.images.length >= 2);
  for (const [i, image] of set.images.entries()) {
    assert.ok(image.id && image.mime, 'an id and a type');
    assert.equal(typeof image.name, 'string');
    assert.equal(image.layer, i);
    assert.match(String(image.size), /^\d+x\d+$/, 'the size of each (the base\'s is the coordinate system of the boxes)');
    if (i > 0) assert.ok(Array.isArray(image.box.absolute) && Array.isArray(image.box.normalized), 'where each layer goes');
  }
  assert.ok(set.original?.id, 'the picture that was split, for a card that cannot draw layers');
};

test('layers: the text of the result alone carries the whole layer set, and get_layer_set gives it back by the id of any of its images', async () => {
  const ctx = { env: env({ TINTLOOM_MODELARK_KEY: 'm-test-123456' }), mode: 'stdio', store: new ImageStore(), projectDir: dir, session: { ui: true } };
  const call = (name, args) => handleMessage({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }, ctx);
  await writeFile(join(dir, 'replay.png'), BIG);
  const made = await call('generate_image', { images: [{ path: 'replay.png' }], layers: true, out: 'layers-replay/' });
  assert.equal(made.result.isError, undefined, JSON.stringify(made));
  // What an app may replay is the text alone: its JSON is the whole set.
  const text = made.result.content[0].text;
  const replayed = JSON.parse(text.slice(text.lastIndexOf('tintloom-card:') + 'tintloom-card:'.length));
  layerViewNeeds(replayed);
  layerViewNeeds(made.result.structuredContent);
  assert.match(text, /^Split the image into 4 layers/, 'the opening words the card recognises a split by');
  // What an app may replay instead is ids alone: the server keeps the set, under every id in it.
  for (const image of replayed.images) {
    const back = await call('get_layer_set', { id: image.id });
    layerViewNeeds(back.result.structuredContent.set);
    assert.deepEqual(back.result.structuredContent.set.images.map((i) => i.name), replayed.images.map((i) => i.name));
    assert.equal(back.result.structuredContent.set.credits, undefined, 'a balance from the day of the split is not replayed');
  }
  assert.equal((await call('get_layer_set', { id: 'img_nothing_here_000000000' })).result.structuredContent.set, null);
  // An image the user gave as data is kept too, so there is an original to show.
  const fromData = await call('generate_image', { images: [{ data: BIG.toString('base64') }], layers: true, out: 'layers-replay2/' });
  layerViewNeeds(fromData.result.structuredContent);
  assert.deepEqual(await readFile(join(dir, 'replay.png')), BIG);
  assert.equal((await ctx.store.get(fromData.result.structuredContent.original.id)).bytes.equals(BIG), true);
});

test('card: a reloaded split is recognised, asked for by id, and never shown as the bare base', async () => {
  const card = await readFile(new URL('../plugins/tintloom/server/ui/image-card.html', import.meta.url), 'utf8');
  assert.match(card, /get_layer_set/);
  assert.match(card, /\^Split the image into/);
  assert.match(card, /richness/, 'the fuller of structuredContent and the text JSON is used');
  assert.match(card, /original \? \[original, \.\.\.layers\]/, 'without places for the layers, the original picture comes first');
});
