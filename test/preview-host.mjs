#!/usr/bin/env node
// A stand-in chat host for looking at the image card without a key or a real app.
// It speaks the MCP Apps protocol to the card and runs the real server code
// against a fake provider that paints a sample picture.
//
//   npm run preview      then open http://localhost:8790  (?theme=light, ?count=3, ?error=1)
//   ?restricted=1 imitates an app that lets the card neither call tools nor load links
//   ?hosted=1 sends what the hosted service sends (no previews), with the image link blocked; ?aspect=9:16; ?maxh=600; ?w=343 for a phone-wide card
//   (the Claude desktop app's Code tab): the picture must then arrive inside the result.
//   ?layers=1 splits a sample picture into layers through a fake ModelArk (the layer view: drag, hide, download);
//   ?layers=<folder> shows a saved real split instead (a folder with manifest.json and its files, as test/layers-live.mjs writes).
//   ?noquick=1 leaves out the small copies a result carries (an app that drops image parts); ?lag=<ms>&bps=<bytes/s> slow tool answers;
//   ?replay=text|lean|bare imitates a chat reloaded (see below). ?dl=1 lets the card use ui/download-file; what it sends is saved next to the manifest, or in the temp folder, as download-N.png.
import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';
import { ImageStore, handleMessage, makePreview } from '../plugins/tintloom/server/tintloom-mcp.mjs';
import { encodePng, shrinkPng } from '../plugins/tintloom/skills/image/scripts/lib/png.mjs';

const PORT = Number(process.env.PORT || 8790);

// ---- a tiny PNG painter, so the preview has a real picture to show ----
const CRC = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const body = Buffer.concat([Buffer.from(type), data]);
  const out = Buffer.alloc(body.length + 8);
  out.writeUInt32BE(data.length, 0);
  body.copy(out, 4);
  out.writeUInt32BE(crc32(body), body.length + 4);
  return out;
};
const mix = (a, b, t) => a.map((v, i) => Math.round(v + (b[i] - v) * Math.min(1, Math.max(0, t))));

function paint(width, height, seed = 0) {
  const raw = Buffer.alloc((width * 3 + 1) * height);
  const sun = { x: width * (0.62 + 0.1 * Math.sin(seed)), y: height * 0.42, r: height * 0.11 };
  for (let y = 0; y < height; y++) {
    const row = y * (width * 3 + 1);
    for (let x = 0; x < width; x++) {
      const v = y / height;
      let c = mix([34 + seed * 12, 40, 92], [250, 150 + seed * 10, 96], Math.pow(v / 0.62, 1.6));
      const d = Math.hypot(x - sun.x, y - sun.y);
      c = mix(c, [255, 226, 170], Math.max(0, 1 - d / (sun.r * 4)) * 0.55);
      if (d < sun.r) c = [255, 240, 205];
      const far = height * (0.6 + 0.05 * Math.sin(x / (width * 0.11) + seed) + 0.025 * Math.sin(x / (width * 0.037)));
      const near = height * (0.76 + 0.06 * Math.sin(x / (width * 0.17) + 2 + seed) + 0.02 * Math.sin(x / (width * 0.05)));
      if (y > far) c = mix([120, 84, 122], [86, 62, 104], (y - far) / (height * 0.2));
      if (y > near) c = mix([44, 40, 74], [20, 20, 40], (y - near) / (height * 0.24));
      raw[row + 1 + x * 3] = c[0];
      raw[row + 2 + x * 3] = c[1];
      raw[row + 3 + x * 3] = c[2];
    }
  }
  const head = Buffer.alloc(13);
  head.writeUInt32BE(width, 0);
  head.writeUInt32BE(height, 4);
  head.set([8, 2, 0, 0, 0], 8);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', head), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

// A sample layer set: the sample picture as the base, and three transparent layers with the boxes ModelArk reports.
function sampleLayers(width, height) {
  const layer = (x, y, w, h, shade) => {
    const rgba = Buffer.alloc(w * h * 4);
    for (let j = 0; j < h; j++) {
      for (let i = 0; i < w; i++) {
        const inside = shade === 'disc' ? Math.hypot(i - w / 2, j - h / 2) < Math.min(w, h) / 2 : shade === 'bar' ? j > h * 0.25 && j < h * 0.75 : Math.abs(i - w / 2) < (j / h) * (w / 2);
        const c = shade === 'disc' ? [255, 226, 90] : shade === 'bar' ? [240, 240, 235] : [30, 120, 80];
        if (inside) rgba.set([...c, 255], (j * w + i) * 4);
      }
    }
    return { png: encodePng(w, h, rgba), box: [x, y, x + w, y + h] };
  };
  return [
    { name: 'Sun', description: 'A low yellow sun', ...layer(Math.round(width * 0.58), Math.round(height * 0.22), Math.round(width * 0.14), Math.round(width * 0.14), 'disc') },
    { name: 'Title bar', description: 'A pale banner across the top', ...layer(Math.round(width * 0.1), Math.round(height * 0.06), Math.round(width * 0.8), Math.round(height * 0.14), 'bar') },
    { name: 'Pine tree', description: 'A dark green pine tree', ...layer(Math.round(width * 0.12), Math.round(height * 0.5), Math.round(width * 0.14), Math.round(height * 0.4), 'tree') },
  ];
}

let fakeCalls = 0;
// ---- the real server, pointed at the fake provider below ----
const ctx = {
  mode: 'stdio',
  store: new ImageStore(),
  preview: makePreview,
  projectDir: mkdtempSync(join(tmpdir(), 'tintloom-preview-')),
  env: { TINTLOOM_CONFIG: '/nonexistent', OPENAI_API_KEY: 'preview-key-000000', OPENAI_BASE_URL: `http://127.0.0.1:${PORT}/fake-openai`, TINTLOOM_MODELARK_KEY: 'preview-key-000000', MODELARK_BASE_URL: `http://127.0.0.1:${PORT}/fake-modelark` },
};
const SAMPLE = { width: 1024, height: 768 };
let saved = 0;
let manifestDir = null;
// ?link=1 also gives each saved image an address the card may load it from; by default it must fetch them by id.
const q_linked = (url) => new URL(url, 'http://x').searchParams.get('link') === '1';

const PAGE = (card) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Image card preview</title>
<style>
  :root { color-scheme: dark; --bg: #1a1a19; --text: #f5f4ef; --muted: #a3a199; --bubble: #262624; }
  :root[data-theme="light"] { color-scheme: light; --bg: #faf9f5; --text: #141413; --muted: #6b6a65; --bubble: #efeee7; }
  body { margin: 0; background: var(--bg); color: var(--text); font: 16px/1.5 ui-sans-serif, system-ui, sans-serif; }
  main { max-width: 760px; margin: 0 auto; padding: 32px 20px 80px; display: flex; flex-direction: column; gap: 22px; }
  .user { align-self: flex-end; background: var(--bubble); padding: 10px 16px; border-radius: 16px; max-width: 80%; }
  .muted { color: var(--muted); font-size: 14px; }
  .reply { font-family: ui-serif, Georgia, serif; font-size: 17px; }
  iframe { border: 0; width: 100%; height: 40px; display: block; background: transparent; color-scheme: inherit; }
  iframe.full { position: fixed; inset: 0; height: 100% !important; background: var(--bg); padding: 24px; box-sizing: border-box; z-index: 5; }
  iframe.full.phone { inset: 0 auto auto 50%; transform: translateX(-50%); height: 560px !important; padding: 0; outline: 1px solid #555; }
</style></head>
<body><main id="chat">
  <div class="user" id="ask"></div>
  <div class="muted">Thought for 4s</div>
  <iframe id="card" sandbox="allow-scripts" title="Image card"></iframe>
  <div class="reply" id="reply" hidden>Here's your image.</div>
</main>
<script>
const q = new URLSearchParams(location.search);
const theme = q.get('theme') === 'light' ? 'light' : 'dark';
const restricted = q.get('restricted') === '1';
document.documentElement.dataset.theme = theme;
const layers = q.get('layers');
const args = { prompt: 'A quiet valley at dusk, layered hills, a low warm sun, soft haze', aspect: q.get('aspect') || '3:2', count: Number(q.get('count') || 1) };
if (q.get('error')) args.provider = 'gemini';
if (layers) { delete args.prompt; delete args.aspect; delete args.count; args.layers = true; }
document.getElementById('ask').textContent = 'create an image of a quiet valley at dusk';
const frame = document.getElementById('card');
if (q.get('w')) { frame.style.width = q.get('w') + 'px'; frame.style.maxWidth = 'none'; frame.classList.add('phone'); }
frame.srcdoc = ${JSON.stringify(card).replace(/</g, '\\u003c')};
const send = (msg) => frame.contentWindow.postMessage({ jsonrpc: '2.0', ...msg }, '*');
const rpc = (method, params) => fetch('/rpc?bps=' + (q.get('bps') || 0) + '&lag=' + (q.get('lag') || 0), { method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) }).then((r) => r.json());
let mode = 'inline';
window.addEventListener('message', async (event) => {
  if (event.source !== frame.contentWindow) return;
  const msg = event.data;
  if (!msg || msg.jsonrpc !== '2.0' || !msg.method) return;
  const reply = (result) => send({ id: msg.id, result });
  switch (msg.method) {
    case 'ui/initialize':
      return reply({ protocolVersion: '2026-01-26', hostInfo: { name: 'preview-host', version: '1' }, hostCapabilities: restricted ? { message: { text: {} } } : { openLinks: {}, serverTools: {}, message: { text: {} }, ...(q.get('dl') === '1' && { downloadFile: {} }) },
        hostContext: { theme, displayMode: 'inline', availableDisplayModes: ['inline', 'fullscreen'], containerDimensions: { width: frame.clientWidth, ...(q.get('maxh') !== '0' && { maxHeight: Number(q.get('maxh') || 900) }) } } });
    case 'ui/notifications/initialized':
      send({ method: 'ui/notifications/tool-input', params: { arguments: q.get('replay') === 'bare' ? {} : args } });
      await new Promise((r) => setTimeout(r, Number(q.get('wait') || 1800)));
      let res;
      if (layers && layers !== '1') res = await fetch('/layers-result?noquick=' + (q.get('noquick') || '0') + '&link=' + (q.get('link') || '0') + '&dir=' + encodeURIComponent(layers)).then((r) => r.json());
      else if (layers) {
        const made = await rpc('prepare-layers', {});
        args.images = [{ id: made.id }];
        res = await rpc('tools/call', { name: 'generate_image', arguments: args });
      } else res = await rpc('tools/call', { name: 'generate_image', arguments: args });
      if (q.get('hosted') === '1' && res.result.structuredContent) {
        // What the hosted service sends to an app that blocks the image link: no previews, no thumbnails.
        delete res.result._meta;
        res.result.structuredContent.images.forEach((image) => { delete image.thumb; image.src = 'http://127.0.0.1:9/blocked.png'; });
      }
      // ?replay=text|lean|bare imitates a chat reloaded: the card gets only what an app might replay.
      //   text: the result's text alone (its JSON rides there). lean: structuredContent cut to ids, text without the JSON.
      //   bare: as lean, and the tool's own input is not replayed either.
      const replay = q.get('replay');
      if (replay === 'text') delete res.result.structuredContent;
      if (replay === 'lean' || replay === 'bare') {
        const sc = res.result.structuredContent || {};
        res.result = { content: [{ type: 'text', text: String(res.result.content[0].text).split('\\n')[0] }], structuredContent: { images: (sc.images || []).map((i) => ({ id: i.id, mime: i.mime, ...(i.url && { url: i.url, src: i.src }) })) } };
      }
      window.resultAt = Math.round(performance.now());
      send({ method: 'ui/notifications/tool-result', params: res.result });
      document.getElementById('reply').hidden = false;
      return;
    case 'ui/notifications/size-changed':
      window.lastSize = msg.params;
      if (mode === 'inline') frame.style.height = msg.params.height + 'px';
      return;
    case 'tools/call':
      if (restricted) return send({ id: msg.id, error: { code: -32000, message: 'IPC not available for MCP tool call' } });
      const asked = performance.now();
      const answered = await rpc('tools/call', msg.params).then((r) => (r.error ? { error: r.error } : { result: r.result }));
      (window.toolLog ||= []).push({ at: Math.round(performance.now()), took: Math.round(performance.now() - asked), tool: msg.params.name, id: String((msg.params.arguments || {}).id || '').slice(0, 12), offset: (msg.params.arguments || {}).offset || 0, edge: (msg.params.arguments || {}).edge || 0, chars: JSON.stringify(answered).length });
      return send({ id: msg.id, ...answered });
    case 'ui/message': {
      const bubble = document.createElement('div');
      bubble.className = 'user';
      if (!Array.isArray(msg.params.content)) return send({ id: msg.id, error: { code: -32602, message: 'content must be a list of content blocks' } });
      bubble.textContent = msg.params.content.map((c) => c.text).join('');
      document.getElementById('chat').appendChild(bubble);
      return reply({});
    }
    case 'ui/request-display-mode':
      mode = msg.params.mode;
      frame.classList.toggle('full', mode === 'fullscreen');
      return reply({ mode });
    case 'ui/download-file': {
      const item = (msg.params.contents || [])[0] || {};
      const blob = item.resource && item.resource.blob;
      if (!blob) return reply({ isError: true });
      await fetch('/saved?dir=' + encodeURIComponent(layers && layers !== '1' ? layers : ''), { method: 'POST', body: JSON.stringify({ name: (item.resource.uri || '').split('/').pop(), blob }) });
      return reply({});
    }
    case 'ui/open-link':
      window.open(msg.params.url, '_blank');
      return reply({});
  }
});
</script></body></html>`;

createServer(async (req, res) => {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const body = Buffer.concat(chunks).toString('utf8');
  const json = (obj) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(obj));
  };
  if (req.url.startsWith('/fake-openai/')) {
    const fields = JSON.parse(body || '{}');
    const [w, h] = /^\d+x\d+$/.test(fields.size || '') ? fields.size.split('x').map(Number) : [1024, 1024];
    const scale = 720 / Math.max(w, h);
    // Each request takes a different time and paints a different picture, so images land one by one.
    const turn = fakeCalls++;
    await new Promise((r) => setTimeout(r, 1500 + (turn % 4) * 2500));
    return json({ data: Array.from({ length: fields.n || 1 }, (_, i) => ({ b64_json: paint(Math.round(w * scale), Math.round(h * scale), turn + i).toString('base64') })) });
  }
  if (req.url.startsWith('/fake-modelark/')) {
    const fields = JSON.parse(body || '{}');
    const { width, height } = SAMPLE;
    const parts = sampleLayers(width, height);
    await new Promise((r) => setTimeout(r, 1500));
    return json({ model: fields.model, data: [
      { b64_json: paint(width, height, 1).toString('base64'), size: `${width}x${height}`, output_format: 'png', z_index: 0 },
      ...parts.map((part, i) => ({ b64_json: part.png.toString('base64'), size: `${part.box[2] - part.box[0]}x${part.box[3] - part.box[1]}`, output_format: 'png', z_index: i + 1, name: part.name, description: part.description,
        bounding_box: { absolute: part.box, normalized: [Math.round((part.box[0] / width) * 1000), Math.round((part.box[1] / height) * 1000), Math.round((part.box[2] / width) * 1000), Math.round((part.box[3] / height) * 1000)] } })),
    ] });
  }
  if (req.url.startsWith('/rpc')) {
    const call = JSON.parse(body);
    if (call.method === 'prepare-layers') return json({ id: await ctx.store.put({ bytes: paint(SAMPLE.width, SAMPLE.height, 1), mime: 'image/png' }) });
    const answer = await handleMessage(call, ctx);
    // ?lag=<ms>&bps=<bytes per second> slow every tool answer down, as a long way to the app does.
    const params = new URL(req.url, 'http://x').searchParams;
    const wait = Number(params.get('lag') || 0) + (Number(params.get('bps') || 0) ? (JSON.stringify(answer).length / Number(params.get('bps'))) * 1000 : 0);
    if (wait) await new Promise((r) => setTimeout(r, wait));
    return json(answer);
  }
  if (req.url.startsWith('/layers-result')) {
    // A saved real split: manifest.json lists the images; each is served from here with permission for the card to read it.
    const dir = new URL(req.url, 'http://x').searchParams.get('dir');
    manifestDir = dir;
    const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));
    // The saved files go into the real store, so the real get_generated_image serves them; the small copies the server
    // sends with a result (shrinkPng, as core.mjs makes them) ride along, so the card behaves as it does with a live result.
    const content = [{ type: 'text', text: 'Split into layers.' }];
    const images = [];
    let pics = 0;
    for (const [i, image] of manifest.images.entries()) {
      const bytes = readFileSync(join(dir, image.file));
      const id = await ctx.store.put({ bytes, mime: image.mime || 'image/png' });
      let small = null;
      try { small = (image.mime === 'image/png' || !image.mime) && new URL(req.url, 'http://x').searchParams.get('noquick') !== '1' ? shrinkPng(bytes, 384) : null; } catch { /* not readable */ }
      const record = { ...image, id, ...(q_linked(req.url) && { src: `http://localhost:${PORT}/layerfile?dir=${encodeURIComponent(dir)}&i=${i}` }) };
      if (small) { record.pic = pics++; content.push({ type: 'image', data: small.toString('base64'), mimeType: 'image/png' }); }
      images.push(record);
    }
    return json({ result: { structuredContent: { ...manifest, layers: true, images, pics }, content } });
  }
  if (req.url.startsWith('/layerfile')) {
    const query = new URL(req.url, 'http://x').searchParams;
    const manifest = JSON.parse(readFileSync(join(query.get('dir'), 'manifest.json'), 'utf8'));
    const image = manifest.images[Number(query.get('i'))];
    res.writeHead(200, { 'Content-Type': image.mime || 'image/png', 'Access-Control-Allow-Origin': '*' });
    return res.end(readFileSync(join(query.get('dir'), image.file)));
  }
  if (req.url.startsWith('/saved')) {
    const dir = new URL(req.url, 'http://x').searchParams.get('dir') || ctx.projectDir;
    mkdirSync(dir, { recursive: true });
    const { blob } = JSON.parse(body);
    writeFileSync(join(dir, `download-${++saved}.png`), Buffer.from(blob, 'base64'));
    return json({ ok: true });
  }
  const card = (await handleMessage({ jsonrpc: '2.0', id: 1, method: 'resources/read', params: { uri: 'ui://tintloom/image-card.html' } }, ctx)).result.contents[0].text;
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(PAGE(card));
}).listen(PORT, '127.0.0.1', () => console.log(`Image card preview: http://localhost:${PORT}`));
