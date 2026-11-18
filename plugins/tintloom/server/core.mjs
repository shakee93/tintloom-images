// The MCP protocol and image tools, with no I/O of its own beyond provider calls:
// the caller supplies the image store, the card HTML and (optionally) DNS lookup.
// Shared by the local server (tintloom-mcp.mjs) and the hosted edge function.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { isIP } from 'node:net';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { LAYERS_PROMPT, buildRequest, outputPaths, pickProvider } from '../skills/image/scripts/tintloom.mjs';
import { readConfig, resolveKey, resolveSetting } from '../skills/image/scripts/lib/config.mjs';
import { imageSize, maskFromRegions, clearUnderMask, keepOutsideMask, shrinkPng, resizeMask, onlyUnderMask, stripMetadata } from '../skills/image/scripts/lib/png.mjs';
import { UserError, extForMime, sniffMime } from '../skills/image/scripts/lib/util.mjs';
import { getProvider, providers } from '../skills/image/scripts/providers/index.mjs';

export const VERSION = '0.8.21';
const PROTOCOL = '2025-06-18';
export const MAX_INPUT_BYTES = 20 * 1024 * 1024;
// Bigger images are not sent to the model inline: chat apps cap tool results.
const MAX_INLINE_BYTES = 700 * 1024;

// Base64 characters per read; a multiple of 4 so pieces join cleanly.
const IMAGE_CHUNK = 240_000;

export const CARD_URI = 'ui://tintloom/image-card.html';
export const CARD_MIME = 'text/html;profile=mcp-app';

// ---------- uploading an image file the agent has on disk (text of the tool; its code is further down) ----------

/**
 * The tool a card can offer for dropping an image on it, once one exists. While it is null the description
 * below tells Claude to ask for a public link when the upload command cannot connect; set it to the tool's
 * name and that sentence points at the card instead. Nothing else needs to change.
 */
export const UPLOAD_DROP_ZONE_TOOL = 'generate_image';

/** What Claude says to the user when the sandbox blocks tintloom.com. The way to add the picture in the card comes from UPLOAD_DROP_ZONE_TOOL. */
const UPLOAD_BLOCKED = (card) =>
  `say it in one or two sentences: this sandbox blocks tintloom.com. On a paid Claude plan they can add tintloom.com to the allowed domains under Settings > Capabilities (on a Team or Enterprise plan an admin does it under Organization settings > Capabilities) and then ask again; or they can add the picture in the Tintloom card${card ? ` (call ${card} with \`add_image: true\`)` : ''}, or give you a public https link to it`;

const UPLOAD_DESCRIPTION =
  'Get a one-time address to upload an image file to Tintloom, so the file can be edited, split into layers (`layers: true`) or used as a reference. ' +
  'Use this when the user attached a file to the chat or has a local file AND you can run shell commands (a code sandbox, Claude Code, Cowork). Run the shell snippet it returns on the file; it prints JSON `{ id, width, height }`; then pass that id as `images: [{ id }]` to generate_image. ' +
  'Never type an image as base64 into `data`: a real image is far too big for a tool call. ' +
  'The address works once, for about 10 minutes, for one PNG, JPEG or WebP up to 25 MB, and uploading is free. Everything goes to tintloom.com and nowhere else, in pieces of 3.5 MB if the file is bigger. ' +
  `If the snippet fails to connect (curl exit 6, 7, 28, 35 or 56, or the output says "CONNECT tunnel failed" or "connect_rejected"), ${UPLOAD_BLOCKED(UPLOAD_DROP_ZONE_TOOL)}. Do not retry with base64.`;

const imageItem = {
  type: 'object',
  properties: {
    id: { type: 'string', description: 'Id of an image this server made earlier in the conversation, or one the user\'s file was uploaded as (see get_upload_url).' },
    path: { type: 'string', description: 'Path of a local image file (only when the server runs on the user\'s machine).' },
    url: { type: 'string', description: 'Public https URL of an image.' },
    data: { type: 'string', description: 'Base64 bytes of a small image that a tool gave you as real bytes, without a data: prefix. Not for an image the user attached to the chat or a file on disk: a real image is far too big to type here, use get_upload_url (or path) instead.' },
  },
};

const TOOLS = [
  {
    name: 'generate_image',
    title: 'Generate image',
    description:
      'Create an image from a text prompt, or edit or combine existing images when `images` is given. The result says whether the user can already see the image; follow it. Write a specific prompt: subject, setting, composition, style, lighting, and any exact text in quotes. For edits, say what changes and what must stay the same. Make one image unless the user asks for more: every image costs them money. When the user asks for several different images at once, make ONE call with `prompts` (one prompt per image), never several calls: they then appear together as one gallery. When the user asks to split or separate an image into layers, or to get its elements as separate transparent PNGs, call this with `layers: true` and that one image. When the user attached a picture to the chat or says they have their own, and you cannot send it with get_upload_url (or that failed), call this with `add_image: true`: it opens the card so they can add it, and nothing is generated or charged.',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'What to make. For edits: what to change and what to keep.' },
        prompts: {
          type: 'array', minItems: 2, maxItems: 4, items: { type: 'string' },
          description: 'Several different images in one go, one prompt each, shown together as one gallery. Use this in place of `prompt` when the user asks for more than one distinct image (for example an apple, a pear and cherries). For takes on a single prompt use `count`.',
        },
        add_image: { type: 'boolean', description: 'The user wants to bring their own picture (one they attached to the chat, or a file of theirs) to edit, split into layers, cut out and so on: opens the card so they can drop, choose or paste it. Nothing is generated or charged and no prompt is needed. Use this when get_upload_url cannot be used or fails. Wait afterwards: a message with the new image id arrives, and you then call generate_image again with that id in `images`.' },
        latest_upload: { type: 'boolean', description: 'Use the image the user most recently added to their Tintloom account (by upload on tintloom.com, in the card, or with get_upload_url) as the one to edit or split, without needing its id. Use it when the user says they uploaded an image on tintloom.com. Same as passing that image\'s id in `images`.' },
        images: { type: 'array', description: 'Images to edit or use as references: ids this server gave, or a public https link. An image the user attached to the chat cannot be passed here: use add_image first. Omit to create from text alone.', items: imageItem },
        mask: { ...imageItem, description: 'Limits an edit to part of the first image: a PNG the same size as it, transparent where the change may happen. Usually the id from the card\'s Select area tool.' },
        edit_regions: {
          type: 'array',
          description: 'Limits an edit to rectangles of the first image, without needing a mask file. Each is fractions of the image from its top-left corner, for example the top third is { "x": 0, "y": 0, "width": 1, "height": 0.33 }. Supported by provider openai.',
          items: { type: 'object', properties: { x: { type: 'number' }, y: { type: 'number' }, width: { type: 'number' }, height: { type: 'number' } }, required: ['x', 'y', 'width', 'height'] },
        },
        selection: { type: 'boolean', description: 'Edit the image the user has open in the image card, limited to the area they painted on it if any. Use it when a message says "this image" or "the selected area" without an id; leave out `images`, `mask` and `erase`.' },
        layers: { type: 'boolean', description: 'Split exactly one input image (by `images` or `selection: true`) into a base plus separate transparent PNG layers, one per element (Seedream only; runs on the whole image, so no mask or edit_regions; `prompt` is optional and may say how to split it). Billed per image returned, usually about 5.' },
        erase: { type: 'boolean', description: 'With mask or edit_regions: remove whatever is in that area and fill it in to match its surroundings. The card\'s Erase tool asks for this.' },
        fidelity: { type: 'string', enum: ['low', 'high'], description: 'For edits with openai gpt-image-1.5: high keeps faces, logos and fine detail of the inputs closer to the original.' },
        aspect: { type: 'string', description: 'Shape as W:H, for example 1:1, 16:9, 9:16, 4:5, 3:2.' },
        size: { type: 'string', description: 'Exact pixels as WIDTHxHEIGHT, for example 1536x1024. Use aspect or size, not both.' },
        quality: { type: 'string', enum: ['low', 'medium', 'high'], description: 'Leave this out unless the user asks for more quality: the default is the fast one. medium for a finished image, high for the finest detail; both are slower.' },
        count: { type: 'integer', minimum: 1, maximum: 4, description: 'Variants of this one prompt. Default 1.' },
        background: { type: 'string', enum: ['transparent', 'opaque'], description: 'transparent needs provider openai with model gpt-image-1.5.' },
        provider: { type: 'string', enum: providers.map((p) => p.id), description: 'Omit to use the user\'s default provider.' },
        model: { type: 'string', description: 'A model id from list_image_providers. Omit for the provider\'s default.' },
        out: { type: 'string', description: 'Where to save, as a file path or a folder ending in "/". Only when the server runs on the user\'s machine. Default: generated-images/ in the project.' },
      },
      required: [],
    },
    _meta: { ui: { resourceUri: CARD_URI, visibility: ['model', 'app'] }, 'ui/resourceUri': CARD_URI },
  },
  {
    name: 'list_image_providers',
    title: 'List image providers',
    description: 'List the image providers and models that can be used, what each can do, and which have a key set.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'get_upload_url',
    title: 'Upload an image file',
    description: UPLOAD_DESCRIPTION,
    inputSchema: {
      type: 'object',
      properties: {
        filename: { type: 'string', description: 'The file\'s name, for example photo.png. Optional; it only picks the content type for the command.' },
        mime: { type: 'string', enum: ['image/png', 'image/jpeg', 'image/webp'], description: 'The file\'s content type, if you know it. Optional.' },
      },
    },
  },
  {
    name: 'open_image',
    title: 'Add your own image',
    description:
      'The same as generate_image with `add_image: true`, which is the one to use. Opens the image card so the user can add their own picture: they drop a file on it, choose one, or paste one. Call this when the user attached a picture, photo or file to the chat (or says they have one) and wants it edited, split into layers, its background removed, resized and so on, and you cannot run commands to send it with get_upload_url, or that did not work. An image attached to the chat cannot reach this server any other way, and you must never pass it as base64 in `data`. Wait after calling it: a message from the user with the new image id arrives once the picture is added, and you then use that id in `images: [{ id }]`. On a local machine `images: [{ path }]` needs no upload.',
    inputSchema: { type: 'object', properties: {} },
    // Claude does not draw a card for this tool; generate_image with add_image does. Kept for apps that do, but not offered to the model.
    _meta: { ui: { resourceUri: CARD_URI, visibility: ['app'] }, 'ui/resourceUri': CARD_URI },
  },
  {
    name: 'upload_image_part',
    title: 'Send a piece of an image the user added',
    description: 'Used by the image card to send an image the user chose, in pieces. Not useful to call directly.',
    inputSchema: { type: 'object', properties: { upload: { type: 'string' }, index: { type: 'integer', minimum: 0, maximum: 199 }, data: { type: 'string', description: 'Base64.' } }, required: ['upload', 'index', 'data'] },
    _meta: { ui: { visibility: ['app'] } },
  },
  {
    name: 'finish_image_upload',
    title: 'Finish adding an image',
    description: 'Used by the image card once every piece of an image the user chose has been sent. Not useful to call directly.',
    inputSchema: { type: 'object', properties: { upload: { type: 'string' }, total: { type: 'integer', minimum: 1, maximum: 200 }, name: { type: 'string' } }, required: ['upload', 'total'] },
    _meta: { ui: { visibility: ['app'] } },
  },
  {
    name: 'get_upload_ticket',
    title: 'Get an address to send an image the user added straight to Tintloom',
    description: 'Used by the image card to send an image the user chose straight to the site instead of through the app. Not useful to call directly.',
    inputSchema: { type: 'object', properties: {} },
    _meta: { ui: { visibility: ['app'] } },
  },
  {
    name: 'finish_direct_upload',
    title: 'Open an image the card sent straight to Tintloom',
    description: 'Used by the image card after it sent an image straight to the site: makes it the open image. Not useful to call directly.',
    inputSchema: { type: 'object', properties: { id: { type: 'string', description: 'The id the site gave the upload.' }, name: { type: 'string' } }, required: ['id'] },
    _meta: { ui: { visibility: ['app'] } },
  },
  {
    name: 'save_mask',
    title: 'Save a selection mask',
    description: 'Used by the image card to store the area the user painted. Not useful to call directly.',
    inputSchema: { type: 'object', properties: { data: { type: 'string', description: 'Base64 PNG.' } }, required: ['data'] },
    _meta: { ui: { visibility: ['app'] } },
  },
  {
    name: 'save_selection',
    title: 'Remember what is open in the image card',
    description: 'Used by the image card to say which image the user has open and what they painted on it. Not useful to call directly.',
    inputSchema: {
      type: 'object',
      properties: { image: { type: 'string' }, mask: { type: 'string', description: 'Base64 PNG.' }, regions: { type: 'array', items: { type: 'object' } }, erase: { type: 'boolean' } },
      required: ['image'],
    },
    _meta: { ui: { visibility: ['app'] } },
  },
  {
    name: 'get_progress',
    title: 'Images ready so far',
    description: 'Used by the image card to show images as they finish. Not useful to call directly.',
    inputSchema: { type: 'object', properties: { key: { type: 'string' } }, required: ['key'] },
    _meta: { ui: { visibility: ['app'] } },
  },
  {
    name: 'save_layer_arrangement',
    title: 'Keep how layers were arranged',
    description: 'Used by the image card to keep what the user moved, resized, turned, flipped, reordered and hid in a layer set, so it is there after a reload (and on the dashboard). Not useful to call directly.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'The id of the set\'s base.' },
        moves: { type: 'object', description: 'Layer id to [dx, dy]: how far its middle moved, as fractions of the base.' },
        hidden: { type: 'array', items: { type: 'string' } },
        scale: { type: 'object', description: 'Layer id to a size multiplier (0.05 to 10).' },
        rotation: { type: 'object', description: 'Layer id to degrees clockwise.' },
        flipX: { type: 'array', items: { type: 'string' }, description: 'Ids of layers mirrored left to right.' },
        order: { type: 'array', items: { type: 'string' }, description: 'The layers\' ids from back to front.' },
      },
      required: ['id'],
    },
    _meta: { ui: { visibility: ['app'] } },
  },
  {
    name: 'get_layer_set',
    title: 'Load a layer set',
    description: 'Used by the image card to reopen a split-into-layers result after the chat is reloaded. Not useful to call directly.',
    inputSchema: { type: 'object', properties: { id: { type: 'string', description: 'The id of any image in the set.' } }, required: ['id'] },
    _meta: { ui: { visibility: ['app'] } },
  },
  {
    name: 'get_generated_image',
    title: 'Load a generated image',
    description: 'Used by the image card to load an image by id. Not useful to call directly.',
    inputSchema: { type: 'object', properties: { id: { type: 'string' }, offset: { type: 'integer', description: 'Where to continue from, in base64 characters.' }, edge: { type: 'integer', minimum: 64, maximum: 2048, description: 'Send a smaller copy of a PNG, its long edge at most this many pixels, with transparency kept.' } }, required: ['id'] },
    _meta: { ui: { visibility: ['app'] } },
  },
];

// ---------- how the user arranged a layer set (kept with the set; the dashboard keeps the same shape) ----------

/** Degrees turned into (-180, 180]. */
const normDeg = (r) => { const x = ((r % 360) + 360) % 360; return x > 180 ? x - 360 : x; };

/**
 * What may be kept of an arrangement from the card or the site. `ids` lists the set's images, the base first. Only known
 * ids; finite numbers; a layer's middle moved within the picture (-1..1); a scale of 0.05..10; an angle in (-180, 180];
 * an order that lists every layer once, back to front. What is left as it came is not kept, and the base has no scale,
 * angle, flip or place in the order. Arrangements from before these existed have only `moves` and `hidden` and stay so.
 * (web/lib/layer-types.ts has the same rules for the dashboard; a test holds the two together.)
 */
export function cleanArrangement(input, ids) {
  const known = new Set(ids);
  const layers = ids.slice(1);
  const asLayer = new Set(layers);
  const from = input && typeof input === 'object' ? input : {};
  const entries = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? Object.entries(v) : []);
  const num = (v) => (typeof v === 'number' || typeof v === 'string' ? Number(v) : NaN);
  const moves = {};
  for (const [id, v] of entries(from.moves)) {
    if (!known.has(id) || !Array.isArray(v)) continue;
    const [dx, dy] = [Number(v[0]), Number(v[1])];
    if (Number.isFinite(dx) && Number.isFinite(dy) && (dx || dy)) moves[id] = [Math.max(-1, Math.min(1, dx)), Math.max(-1, Math.min(1, dy))];
  }
  const hidden = Array.isArray(from.hidden) ? [...new Set(from.hidden.filter((h) => typeof h === 'string' && known.has(h)))] : [];
  const out = { moves, hidden };
  const scale = {};
  // `scales` is the name the first version of sizes (0.8.17) used; it is read as `scale` and never written.
  for (const [id, v] of [...entries(from.scales), ...entries(from.scale)]) {
    const n = num(v);
    if (!asLayer.has(id) || !Number.isFinite(n) || n <= 0) continue;
    const s = Math.round(Math.min(10, Math.max(0.05, n)) * 10000) / 10000;
    if (s !== 1) scale[id] = s;
  }
  if (Object.keys(scale).length) out.scale = scale;
  const rotation = {};
  for (const [id, v] of entries(from.rotation)) {
    const n = num(v);
    if (!asLayer.has(id) || !Number.isFinite(n)) continue;
    const r = Math.round(normDeg(n) * 100) / 100;
    if (r) rotation[id] = r;
  }
  if (Object.keys(rotation).length) out.rotation = rotation;
  if (Array.isArray(from.flipX)) {
    const flip = [...new Set(from.flipX.filter((h) => typeof h === 'string' && asLayer.has(h)))];
    if (flip.length) out.flipX = flip;
  }
  if (Array.isArray(from.order)) {
    const given = [...new Set(from.order.filter((h) => typeof h === 'string' && asLayer.has(h)))];
    const order = [...given, ...layers.filter((h) => !given.includes(h))];
    if (order.some((h, i) => h !== layers[i])) out.order = order;
  }
  return out;
}

// ---------- uploading an image file the agent has on disk ----------

/** Parts of a file bigger than this are sent one request each: a request here may hold about 4.5 MB. */
export const UPLOAD_PART_BYTES = 3_500_000;

/**
 * The shell snippet for one upload address, `base` being https://<site>/api/upload/<token>. It works in sh or bash with curl and
 * coreutils, on Linux and macOS: a file of at most 3.5 MB is one request to /done; a bigger one is split into 3.5 MB pieces,
 * each sent to /part/<n>, then /done?parts=<count> puts them together. Only the final JSON is printed; a failure prints curl's
 * message or the server's, and keeps curl's exit code. It runs in its own bash, so `set -e` cannot end the agent's shell.
 */
export function uploadSnippet(base, file = '/path/to/file') {
  const quoted = `'${String(file).replace(/'/g, `'\\''`)}'`;
  return [
    `f=${quoted} bash <<'TINTLOOM_UPLOAD'`,
    'set -e',
    `u='${base}'`,
    // The body is declared as binary: left to curl's default (a form), the hosting platform refuses a large one before it reaches us.
    'post() { r=$(curl -sS --fail-with-body -X POST -H "content-type: application/octet-stream" --data-binary "$2" "$1") || { c=$?; echo "$r" >&2; exit $c; }; }',
    'n=$(wc -c < "$f" | tr -d " ")',
    `if [ "$n" -le ${UPLOAD_PART_BYTES} ]; then post "$u/done" @"$f"`,
    // Pieces are read straight from the file and piped: no temporary files, so nothing to remove afterwards.
    'else i=0; o=0',
    `  while [ "$o" -lt "$n" ]; do tail -c +$((o+1)) "$f" | head -c ${UPLOAD_PART_BYTES} | post "$u/part/$i" @-; i=$((i+1)); o=$((o+${UPLOAD_PART_BYTES})); done`,
    '  post "$u/done?parts=$i"',
    'fi',
    'echo "$r"',
    'TINTLOOM_UPLOAD',
  ].join('\n');
}

/** The snippet and notes Claude is given for one upload address. `t` comes from the host: { uploadUrl, expiresInSeconds, maxBytes }. */
function uploadAnswer(t, args) {
  const name = String(args?.filename || '').replace(/[^\w.\- ]/g, '').slice(0, 80);
  const command = uploadSnippet(t.uploadUrl, name ? `/path/to/${name}` : '/path/to/file');
  const mb = Math.round(t.maxBytes / 1024 / 1024);
  const text = [
    'Run this on the image file (replace the path in `f=`). It sends the file to tintloom.com, in pieces if it is bigger than 3.5 MB, and prints only JSON { "id": "img_...", "width": ..., "height": ... }:',
    '',
    command,
    '',
    'Then call generate_image with `images: [{ id }]` and the prompt (also with `layers: true` to split it into layers). The id works like the id of an image Tintloom made, and uploading costs nothing.',
    `The address works once and expires in ${Math.round(t.expiresInSeconds / 60)} minutes; the file must be a PNG, JPEG or WebP of at most ${mb} MB. Very large images are shrunk to 8192 pixels on the long side and photo metadata (location, camera) is removed.`,
    `If it fails with curl exit 6, 7, 28, 35 or 56, or the output says "CONNECT tunnel failed" or "connect_rejected", ${UPLOAD_BLOCKED(UPLOAD_DROP_ZONE_TOOL)}. Any other answer is a message to pass on; ask for a new address if this one was used or expired. Never type the image as base64.`,
  ].join('\n');
  return { content: [{ type: 'text', text }], structuredContent: { command, upload_url: t.uploadUrl, expires_in_seconds: t.expiresInSeconds, max_bytes: t.maxBytes } };
}

async function getUploadUrl(args, ctx) {
  if (ctx.uploads?.ticket) return uploadAnswer(await ctx.uploads.ticket({ filename: args?.filename, mime: args?.mime }), args);
  if (ctx.mode === 'stdio') {
    return { content: [{ type: 'text', text: 'No upload is needed here: this server runs on the user\'s machine and reads files directly. Pass the file\'s path in `images: [{ path }]` (an absolute path, or one relative to the project) to generate_image.' }] };
  }
  throw new UserError('Uploading is not available here. Pass an image id, a public https URL or small base64 data.');
}

/** The card's two tools for sending an image straight to the site: only a host that issues upload addresses has a site to send it to. */
const DIRECT_UPLOAD_TOOLS = ['get_upload_ticket', 'finish_direct_upload'];

/** Listed only where it can work: a host that issues upload addresses, or the local server that can read paths. */
const toolsFor = (ctx) =>
  TOOLS.filter((t) => (t.name !== 'get_upload_url' || ctx.uploads?.ticket || ctx.mode === 'stdio') && (!DIRECT_UPLOAD_TOOLS.includes(t.name) || ctx.uploads?.ticket)).map((t) =>
    t.name === 'get_upload_url' && !ctx.uploads?.ticket
      ? { ...t, description: 'Answers how to give this server an image file: it runs on the user\'s machine and reads files directly, so pass the file\'s path in `images: [{ path }]` to generate_image. No upload is needed.', inputSchema: { type: 'object', properties: {} } }
      : t);

// ---------- which images of a running call are ready ----------

/** How many images a call makes: one per prompt, or `count` takes on one prompt. */
export function progressTotal(args) {
  const list = Array.isArray(args.prompts) ? args.prompts.filter((p) => typeof p === 'string' && p.trim()).slice(0, 4) : [];
  return list.length > 1 ? list.length : Math.min(Math.max(Math.floor(Number(args.count)) || 1, 1), 4);
}

/** Names a call by what it asks for. The card works out the same name from the same arguments. */
export function progressKey(args) {
  const list = Array.isArray(args.prompts) ? args.prompts.filter((p) => typeof p === 'string' && p.trim()).slice(0, 4) : [];
  const text = (list.length > 1 ? list : [String(args.prompt || '')]).join('\u0001') + '|' + progressTotal(args);
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 0x01000193) >>> 0;
  return 'p' + hash.toString(16) + text.length.toString(16);
}

/** Display-size copies made for `get_generated_image` with `edge`, so the pieces of one copy are not made again for each piece. */
const viewCache = new Map();

// ---------- an image the user adds in the card (open_image) ----------

/** The pieces of images being added, when the host does not keep them elsewhere (ctx.cardUploads). Kept briefly, and few. */
const memoryUploadParts = new Map();
const uploadParts = {
  async put(upload, index, data) {
    memoryUploadParts.set(`${upload}:${index}`, data);
    while (memoryUploadParts.size > 400) memoryUploadParts.delete(memoryUploadParts.keys().next().value);
  },
  async get(upload, index) {
    return memoryUploadParts.get(`${upload}:${index}`) ?? null;
  },
  async clear(upload, total) {
    for (let i = 0; i < total; i++) memoryUploadParts.delete(`${upload}:${i}`);
  },
};

export const UPLOAD_TYPES = ['image/png', 'image/jpeg', 'image/webp'];

/**
 * What a host without its own rules does with an image the user added: check what it is from its bytes, take its metadata
 * out (PNG and JPEG; a WebP is kept as it is, which is the one thing this does not clean), and keep it like a generated
 * image. A host that sells the service replaces this (ctx.cardUploads.accept) with limits and a proper re-encode.
 */
async function acceptUpload(bytes, ctx) {
  if (bytes.length > MAX_INPUT_BYTES) throw new UserError('That image is larger than 20 MB.');
  const mime = sniffMime(bytes);
  if (!UPLOAD_TYPES.includes(mime)) throw new UserError('That file is not a PNG, JPEG or WebP image.', 'Choose a PNG, JPEG or WebP picture.');
  const size = imageSize(bytes);
  if (!size || !size.width || !size.height || size.width * size.height > 100_000_000) throw new UserError('That image cannot be read, or is too large to use.');
  const clean = stripMetadata(bytes);
  const id = await ctx.store.put({ bytes: clean, mime });
  return { id, mime, width: size.width, height: size.height, bytes: clean.length };
}

/** The answer for an image the user added: it becomes the card's open image, and the card gets what it needs to show it. */
async function uploadedCard(made, ctx) {
  // The picture is now the card's open image, so `selection: true` works at once.
  await (ctx.progress || memoryProgress).set('selection', { image: made.id, mask: null, regions: null, erase: false, at: Date.now(), used: false }).catch(() => {});
  const ext = extForMime(made.mime);
  const record = { id: made.id, mime: made.mime, bytes: made.bytes, width: made.width, height: made.height, uploaded: true, ...(ctx.mode === 'http' && ctx.baseUrl && { url: `${ctx.baseUrl}/files/${made.id}.${ext}`, src: `${ctx.baseUrl}/files/${made.id}.${ext}` }), ...(ctx.mode !== 'http' && ctx.fileUrl && { src: ctx.fileUrl(made.id) }) };
  const cardData = { provider: 'upload', providerLabel: 'Your image', model: 'upload', prompt: '', edited: false, uploaded: true, images: [record] };
  return {
    content: [{ type: 'text', text: `The user added their image. Its id is ${made.id} (${made.width}x${made.height}). Use \`images: [{ id: "${made.id}" }]\` to edit it or split it into layers, or \`selection: true\`.\ntintloom-card:${JSON.stringify(cardData)}` }],
    structuredContent: { ...cardData, id: made.id },
  };
}

const progressLog = new Map();
const memoryProgress = {
  async set(key, value) {
    progressLog.set(key, value);
    if (progressLog.size > 50) progressLog.delete(progressLog.keys().next().value);
  },
  async get(key) {
    return progressLog.get(key) || null;
  },
};

// ---------- generated images, by id ----------

export function newImageId() {
  const bytes = crypto.getRandomValues(new Uint8Array(15));
  return 'img_' + Buffer.from(bytes).toString('base64url');
}

/** Keeps what was generated so the card (and later edits) can ask for it by id. */
export class ImageStore {
  constructor(max = 60, ttlMs = 2 * 60 * 60_000) {
    Object.assign(this, { max, ttlMs, items: new Map() });
  }
  /** entry: { mime, bytes } held in memory, or { mime, path } on disk. */
  put(entry) {
    const id = newImageId();
    this.items.set(id, { ...entry, expires: Date.now() + this.ttlMs });
    while (this.items.size > this.max) this.items.delete(this.items.keys().next().value);
    return id;
  }
  async get(id) {
    const key = String(id || '').replace(/\.[a-z0-9]+$/i, '');
    const item = this.items.get(key);
    if (!item) return null;
    if (item.expires < Date.now()) {
      this.items.delete(key);
      return null;
    }
    const bytes = item.bytes || (await readFile(item.path).catch(() => null));
    return bytes ? { bytes, mime: item.mime, path: item.path || null } : null;
  }
}

// ---------- input images ----------

const PRIVATE_V4 = [/^0\./, /^10\./, /^127\./, /^169\.254\./, /^172\.(1[6-9]|2\d|3[01])\./, /^192\.168\./, /^192\.0\.0\./, /^198\.1[89]\./, /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./, /^(22[4-9]|2[3-5]\d)\./];
const isPrivate = (ip) => (isIP(ip) === 4 ? PRIVATE_V4.some((r) => r.test(ip)) : /^(::1?$|f[cd]|fe[89ab]|fec|::ffff:|64:ff9b:)/i.test(ip));

/** A link to one of our own stored images (tintloom.com/files/<id>.png): its id, else null. */
const ownImageId = (raw) => {
  try {
    const url = new URL(raw);
    const m = /^\/files\/(img_[A-Za-z0-9_-]+)(?:\.png)?$/.exec(url.pathname);
    return m && /(^|\.)tintloom\.com$/.test(url.hostname) ? m[1] : null;
  } catch {
    return null;
  }
};

/**
 * Fetch a user-supplied image URL without letting it reach private networks. Redirects are followed by hand,
 * at most five, and every hop is checked the same way as the first, so a public address cannot send us inside.
 */
async function fetchPublicImage(raw, allowPrivate, lookupHost) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new UserError(`Not a valid image URL: ${raw}`);
  }
  const first = url.hostname;
  let res = null;
  for (let hop = 0; hop <= 5; hop++) {
    if (!allowPrivate) {
      if (url.protocol !== 'https:' || url.port || url.username || url.password) throw new UserError('Image URLs must be plain https addresses.');
      const addresses = lookupHost ? await lookupHost(url.hostname).catch(() => []) : [];
      if (isIP(url.hostname) || !addresses.length || addresses.some(isPrivate)) throw new UserError(`Image URL is not reachable from here: ${url.hostname}`);
    }
    res = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(30_000) }).catch(() => null);
    const next = res && res.status >= 300 && res.status < 400 && res.headers.get('location');
    if (!next) break;
    await res.body?.cancel().catch(() => {});
    try {
      url = new URL(next, url);
    } catch {
      throw new UserError(`Could not fetch the image at ${first}.`);
    }
    res = null;
  }
  if (!res?.ok) throw new UserError(`Could not fetch the image at ${first}.`, 'The link may need a sign-in or may not point straight at an image file.');
  // Stop reading as soon as the file is larger than we accept, however large the server says it is.
  if (Number(res.headers.get('content-length') || 0) > MAX_INPUT_BYTES) throw new UserError('That image is larger than 20 MB.');
  const chunks = [];
  let size = 0;
  for await (const chunk of res.body) {
    size += chunk.length;
    if (size > MAX_INPUT_BYTES) throw new UserError('That image is larger than 20 MB.');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function loadInputs(items = [], ctx) {
  const out = [];
  for (const [i, item] of items.entries()) {
    let bytes = null;
    if (item?.id) {
      bytes = (await ctx.store.get(item.id))?.bytes;
      if (!bytes) throw new UserError(`Image ${item.id} is no longer available.`, 'Ask the user to attach or point to the image again.');
    } else if (item?.path) {
      if (ctx.mode !== 'stdio') throw new UserError('This server cannot read local files. Pass an image id, a public URL or base64 data.');
      const file = isAbsolute(item.path) ? item.path : resolve(ctx.projectDir, item.path);
      bytes = await readFile(file).catch(() => {
        throw new UserError(`Input image not found: ${item.path}`);
      });
    } else if (item?.url) {
      // A link to an image we already hold is read from the store: no round trip, and it works for the owner's private images.
      const own = ownImageId(item.url);
      bytes = (own && (await ctx.store.get(own).catch(() => null))?.bytes) || (await fetchPublicImage(item.url, ctx.env.TINTLOOM_ALLOW_PRIVATE_URLS === '1', ctx.lookupHost));
    }
    else if (item?.data) bytes = Buffer.from(item.data, 'base64');
    if (!bytes) throw new UserError(`images[${i}] needs an id, path, url or data.`);
    if (bytes.length > MAX_INPUT_BYTES) throw new UserError(`images[${i}] is larger than 20 MB.`);
    const mime = sniffMime(bytes);
    if (!mime) throw new UserError(`images[${i}] is not a PNG, JPEG, WebP or GIF image.`);
    out.push({ path: `input-${i + 1}.${extForMime(mime)}`, bytes, mime });
  }
  return out;
}

// ---------- tools ----------

async function listProviders(env) {
  const config = await readConfig(env);
  const rows = providers.map((p) => ({
    id: p.id,
    label: p.label,
    available: Boolean(resolveKey(p, config, env)),
    defaultModel: p.defaultModel,
    models: p.models,
    capabilities: p.capabilities,
    notes: p.notes,
  }));
  return { providers: rows, defaultProvider: resolveSetting('default-provider', config, env) };
}

/**
 * What the card said the user has open: the image, and the area painted on it. It applies when the
 * call asks for it (`selection: true`), and also to a call made right after the card spoke that names
 * no other image, so an app working from an older description of this tool still edits the right thing.
 */
async function withSelection(args, ctx) {
  const notes = ctx.progress || memoryProgress;
  const sel = await notes.get('selection').catch(() => null);
  const age = sel?.image ? Date.now() - sel.at : Infinity;
  const own = args.mask || args.edit_regions?.length || Array.isArray(args.prompts);
  const sameImage = !args.images?.length || (args.images.length === 1 && args.images[0]?.id === sel?.image);
  const asked = args.selection === true && age < 30 * 60_000;
  const implied = !own && sel && !sel.used && age < 3 * 60_000 && sameImage;
  if (args.selection === true && !asked) throw new UserError('No image is open in the image card right now.', 'Pass the image id in `images` instead.');
  if (!asked && !implied) return args;
  await notes.set('selection', { ...sel, used: true }).catch(() => {});
  // Splitting into layers always works on the whole image: the area painted in the card is not applied to it.
  const area = !own && !args.layers;
  return { ...args, images: [{ id: sel.image }], ...(area && sel.mask && { mask: { id: sel.mask } }), ...(area && sel.regions && { edit_regions: sel.regions }), ...(area && sel.erase && { erase: true }) };
}

// ---------- splitting an image into layers ----------

/** Layer names the card shows: the model's own, else Base for the first and Layer N after it. */
const layerName = (img, i) => (img.name && String(img.name).trim()) || (i === 0 ? 'Base' : `Layer ${i}`);

/**
 * `layers: true`: one image in, a base plus transparent layers out, from Seedream on ModelArk whatever
 * `model`, `quality` or `provider` say. One request, so it has no progress and no parallel runs. Everything that
 * can be refused is refused before a host's meter takes anything; after that the meter is settled exactly once,
 * with the number of images kept (none, if anything goes wrong).
 */
async function splitIntoLayers(args, ctx, config) {
  const { env, mode, store } = ctx;
  if (args.mask || args.edit_regions?.length || args.erase) throw new UserError('Splitting into layers works on the whole image, so it cannot be limited to an area.', 'Leave out `mask`, `edit_regions` and `erase`.');
  if (Array.isArray(args.prompts) && args.prompts.length) throw new UserError('Splitting into layers takes one image at a time, so `prompts` cannot be used with it.');
  if (args.count !== undefined && Number(args.count) !== 1) throw new UserError('Splitting into layers makes one split at a time, so `count` cannot be used with it.');
  const given = Array.isArray(args.images) ? args.images.length : 0;
  if (given === 0) throw new UserError('Splitting into layers needs the image to split.', 'Pass it in `images` (an id, url or data), or set `selection: true` for the image open in the card.');
  if (given > 1) throw new UserError(`Splitting into layers takes exactly one image, and ${given} were given.`, 'Pass just the one to split.');
  const inputs = await loadInputs(args.images, ctx);
  const provider = getProvider('modelark');
  const found = resolveKey(provider, config, env);
  if (!found) {
    throw new UserError(env.TINTLOOM_HOST === 'cloud' ? 'Splitting into layers is not available on this service right now. Nothing was charged.' : 'Splitting into layers runs on Seedream, which needs a BytePlus ModelArk key.');
  }
  const model = provider.defaultModel;
  const userPrompt = typeof args.prompt === 'string' && args.prompt.trim() ? args.prompt.trim() : '';
  const req = await buildRequest({ prompt: userPrompt || LAYERS_PROMPT, layers: true, format: 'png', loadedImages: inputs }, 'edit');
  const started = Date.now();
  const charge = ctx.meter ? await ctx.meter.reserve({ provider: provider.id, model, quality: 'medium', edit: true, images: 1, layers: true, prompts: userPrompt ? [userPrompt] : [] }) : null;
  const out = args.out || (env.TINTLOOM_OUT_DIR ? `${env.TINTLOOM_OUT_DIR.replace(/\/+$/, '')}/` : null);
  let made;
  const records = [];
  try {
    made = await provider.generate(req, { key: found.key, env, shrink: ctx.shrink, setting: (name) => resolveSetting(name, config, env) });
    if (!made.length) throw new UserError(`${provider.label} returned no layers.`, 'Try again.');
    const paths = mode === 'http' ? [] : await outputPaths(out, 'layers', made, false, ctx.projectDir);
    for (const [i, img] of made.entries()) {
      const extra = { name: layerName(img, i), ...(img.description && { description: img.description }), layer: img.zIndex ?? i, ...(img.boundingBox && { box: img.boundingBox }), ...(img.size && { size: img.size }), transparent: i > 0 && img.mime === 'image/png' };
      if (mode === 'http') {
        const id = await store.put({ bytes: img.bytes, mime: img.mime });
        const url = `${ctx.baseUrl}/files/${id}.${extForMime(img.mime)}`;
        records.push({ id, mime: img.mime, bytes: img.bytes.length, url, src: url, ...(ctx.viewUrl && { view: ctx.viewUrl(id) }), ...extra });
      } else {
        await mkdir(dirname(paths[i]), { recursive: true });
        await writeFile(paths[i], img.bytes);
        const inside = relative(ctx.projectDir, paths[i]);
        const shown = inside && !inside.startsWith('..') && !isAbsolute(inside) ? inside : paths[i];
        const id = await store.put({ path: paths[i], mime: img.mime });
        records.push({ id, mime: img.mime, bytes: img.bytes.length, path: paths[i], shown, ...(ctx.fileUrl && { src: ctx.fileUrl(id) }), ...extra });
      }
    }
  } catch (e) {
    // Nothing is handed over, so nothing is charged.
    await charge?.settle(0, [], { errors: [e] }).catch(() => {});
    throw e;
  }
  const credits = charge ? await charge.settle(records.length, records.map((r) => r.id)).catch(() => null) : null;
  const leftOut = made.leftOut || 0;
  // The picture that was split, kept so a card that cannot draw the layer view still has the real picture to show
  // (never the bare base, which is only the background). An image given by id is already kept.
  let original = args.images[0]?.id || null;
  if (!original) {
    original = await Promise.resolve().then(() => store.put(mode === 'http' || !args.images[0]?.path ? { bytes: inputs[0].bytes, mime: inputs[0].mime } : { path: isAbsolute(args.images[0].path) ? args.images[0].path : resolve(ctx.projectDir, args.images[0].path), mime: inputs[0].mime })).catch(() => null);
  }
  const where = records.map((r) => `- id ${r.id}: ${r.name}${r.description ? ` (${r.description.slice(0, 80)})` : ''}${r.path ? ` ${r.path}` : ''}`).join('\n');
  const ui = ctx.session?.ui;
  const seen =
    ui === false
      ? 'This app does not draw the image card, so the user has NOT seen the layers yet. Show them: if you have a tool that displays or sends a file to the user, use it on the saved files; otherwise give their paths.'
      : `The user already sees all ${records.length} layers in a card, base first, each labelled with its name; reply in one short line and do not describe them.`;
  const note = `${seen} Each has an id: pass it in \`images\` to edit that layer${mode === 'stdio' ? ' (or its path)' : ''}; the user can download any of them from the card.${leftOut ? ` ${leftOut} further small layer${leftOut === 1 ? ' was' : 's were'} left out.` : ''}`;
  const cardData = { provider: provider.id, providerLabel: provider.label, model, prompt: req.prompt, seconds: Math.round((Date.now() - started) / 100) / 10, edited: true, layers: true, images: records, ...(original && { original: { id: original, mime: inputs[0].mime } }), ...(leftOut && { leftOut }), ...(credits && credits.left <= 10 && { credits }) };
  // Everything the layer view needs is also kept by id. An app that replays a result after a reload may pass the card
  // less than the live result had; the card then asks for the set back with get_layer_set.
  const { credits: _spent, ...kept } = cardData;
  const notes = ctx.progress || memoryProgress;
  await Promise.all(records.map((r) => notes.set(`layerset-${r.id}`, kept).catch(() => {})));
  const content = [{ type: 'text', text: `Split the image into ${records.length} layers (base first) with ${provider.id} (${model}).\n${where}\n${note}${credits && credits.left <= 10 ? `\nThe user has ${credits.left} image credit${credits.left === 1 ? '' : 's'} left; mention it in a few words.` : ''}\ntintloom-card:${JSON.stringify(cardData)}` }];
  // The model's own look: small copies only, ten layers would otherwise be a very large answer.
  const blocks = {};
  let budget = 900 * 1024;
  for (const [i, img] of made.entries()) {
    const small = img.mime === 'image/png' ? shrinkPng(img.bytes, 384) : null;
    const seenCopy = small || (img.bytes.length <= 120 * 1024 ? img.bytes : null);
    if (!seenCopy || seenCopy.length > budget) continue;
    budget -= seenCopy.length;
    blocks[records[i].id] = Object.keys(blocks).length;
    content.push({ type: 'image', data: seenCopy.toString('base64'), mimeType: small ? 'image/png' : img.mime });
  }
  const previews = {};
  const thumbs = {};
  if (ctx.preview) {
    for (const [i, record] of records.entries()) {
      const shownCopy = await ctx.preview(made[i], record).catch(() => null);
      if (shownCopy?.preview) previews[record.id] = shownCopy.preview;
      if (shownCopy?.thumb) thumbs[record.id] = shownCopy.thumb;
    }
  }
  return {
    ...(Object.keys(previews).length && { _meta: { 'tintloom/previews': previews } }),
    content,
    structuredContent: { ...cardData, images: records.map((r) => ({ ...r, ...(thumbs[r.id] && { thumb: thumbs[r.id] }), ...(blocks[r.id] !== undefined && { pic: blocks[r.id] }) })), pics: Object.keys(blocks).length, note },
  };
}

/** The card in its "add your image" state: nothing is made, reserved or charged. Same answer for generate_image with add_image and for open_image. */
function openAddImage(ctx) {
  const where = ctx.mode === 'stdio' ? ' On this machine you can also pass `images: [{ path }]` for a file on disk.' : '';
  // On the hosted service the card also offers a page on the site for when the file cannot be added in the card itself.
  const page = ctx.mode === 'http' && ctx.baseUrl ? `${ctx.baseUrl}/upload` : null;
  const elsewhere = page ? ' If the user says they uploaded it on tintloom.com instead, call generate_image with `latest_upload: true` (their newest upload) or with the id they give in `images`.' : '';
  return {
    content: [{ type: 'text', text: `The user is adding their image in the card (drop, choose or paste). Wait: a message with the new image id will arrive, then use that id in \`images: [{ id }]\` for what they asked.${where}${elsewhere} Do not describe the card or ask for the file in chat.` }],
    structuredContent: { upload: 'open', types: UPLOAD_TYPES, ...(page && { uploadPage: page }) },
  };
}

async function generateImage(args0, ctx) {
  if (args0.add_image === true) return openAddImage(ctx);
  // `latest_upload` is turned into the id of the account's newest upload by a host that keeps them (the hosted service does,
  // before this runs); here it means there was none to use.
  if (args0.latest_upload === true && !args0.images?.length) throw new UserError('There is no uploaded image to use yet.', 'Call generate_image with add_image: true so the user can add one, or pass the image\'s id in `images`.');
  const args = await withSelection(args0, ctx);
  const { env, mode, store } = ctx;
  const config = await readConfig(env);
  if (args.layers === true) return splitIntoLayers(args, ctx, config);
  const inputs = await loadInputs(args.images, ctx);
  let mask = null;
  if (args.mask || args.edit_regions?.length) {
    if (!inputs.length) throw new UserError('A mask or edit_regions needs an image to edit in `images`.');
    if (args.mask) {
      const [loaded] = await loadInputs([args.mask], ctx);
      const [want, got] = [imageSize(inputs[0].bytes), imageSize(loaded.bytes)];
      if (want && got && (want.width !== got.width || want.height !== got.height)) {
        // The card paints on whatever copy of the image the app showed it, which may be smaller
        // than the saved one. Same shape, different size: stretch the mask to fit.
        const sameShape = Math.abs(got.width / got.height - want.width / want.height) < 0.02;
        const fitted = sameShape ? resizeMask(loaded.bytes, want.width, want.height) : null;
        if (!fitted) throw new UserError(`The mask is ${got.width}x${got.height} but the image is ${want.width}x${want.height}. They must have the same shape.`);
        loaded.bytes = fitted;
        loaded.mime = 'image/png';
      }
      mask = { ...loaded, path: 'mask.png' };
    } else {
      mask = { path: 'mask.png', mime: 'image/png', bytes: maskFromRegions(inputs[0].bytes, args.edit_regions) };
    }
  }
  // What the provider is shown. For an erase, the area is blanked first so it cannot redraw what was there.
  const original = inputs[0];
  if (mask && args.erase) {
    const cleared = clearUnderMask(original.bytes, mask.bytes);
    if (cleared) inputs[0] = { ...original, bytes: cleared, mime: 'image/png' };
  }
  // For a change to one part, the provider is not given the mask: it cannot see what is under one,
  // and draws a new shape there. It gets the whole image plus a guide showing only the selected part,
  // and only the selected part of its answer is kept (see keepOutsideMask below).
  let guided = false;
  if (mask && !args.erase) {
    const guide = onlyUnderMask(original.bytes, mask.bytes);
    if (guide) {
      inputs.splice(1, 0, { path: 'where.png', mime: 'image/png', bytes: guide });
      guided = true;
    }
  }
  const wanted = Array.isArray(args.prompts) ? args.prompts.filter((p) => typeof p === 'string' && p.trim()).slice(0, 4) : [];
  const prompts = wanted.length ? wanted : [args.prompt];
  // One request per image, so each can be shown the moment it is ready.
  const total = progressTotal(args);
  const count = '1';
  const reqs = [];
  for (const prompt of prompts.length > 1 ? prompts : Array(total).fill(prompts[0])) {
    reqs.push(
      await buildRequest(
        {
          prompt: !mask
            ? prompt
            : args.erase
              ? `${prompt ? prompt + ' ' : ''}The blank area of the image is where something was removed: fill it in so it continues its surroundings naturally. Add no new object there.`
              : guided
                ? `${prompt}\nThe first image is the picture to edit. The second image is only a guide to where: it shows, in place, the one part of the picture this request is about, with the rest blacked out. Make the change to what is in that part, keeping those objects' shape, size, position and detail unless the request says otherwise. Return the first image with that change and nothing else altered: same lighting, colours and background everywhere, including around the changed object.`
                : `${prompt}\nThe mask is a rough brush selection that marks where this change applies. It is not a shape to draw. Keep what is already inside it and change only what the request asks.`,
          loadedMask: guided ? null : mask,
          fidelity: args.fidelity,
          model: args.model,
          size: args.size,
          aspect: args.aspect,
          quality: args.quality || ctx.defaults?.quality,
          background: args.background,
          count,
          // Always PNG: lossless, and the only format masked edits can be put back together from.
          format: 'png',
          loadedImages: inputs,
        },
        inputs.length ? 'edit' : 'generate',
      ),
    );
  }
  const req = reqs[0];
  const { provider, key } = pickProvider(args.provider, config, env);
  const started = Date.now();
  const model = req.model || provider.defaultModel;
  // A host that sells credits takes them before the provider is called and gives back what failed.
  const charge = ctx.meter ? await ctx.meter.reserve({ provider: provider.id, model, quality: req.quality, edit: inputs.length > 0, images: reqs.length, prompts: reqs.map((r) => r.prompt) }) : null;
  const out = args.out || (env.TINTLOOM_OUT_DIR ? `${env.TINTLOOM_OUT_DIR.replace(/\/+$/, '')}/` : null);
  // While the call runs, the card asks which images are ready (get_progress) and shows them as they land.
  const progress = total > 1 ? ctx.progress || memoryProgress : null;
  const progressId = progressKey(args);
  const run = newImageId();
  const ready = new Array(reqs.length).fill(null);
  const report = () => progress?.set(progressId, { run, total: reqs.length, images: ready.flatMap((r, index) => (r ? [{ ...r.record, index }] : [])) }).catch(() => {});
  await report();
  let saving = Promise.resolve(); // files are named one at a time, so two never pick the same name
  const finish = async (r, index) => {
    const [img] = await provider.generate(r, { key, env, shrink: ctx.shrink, setting: (name) => resolveSetting(name, config, env) });
    if (!img) throw new UserError(`${provider.label} returned no image.`, 'The prompt may have been declined. Rephrase it and try again.');
    // Providers treat a mask as a hint and redraw the whole picture. Put back everything outside it.
    const kept = mask ? keepOutsideMask(original.bytes, img.bytes, mask.bytes) : null;
    if (kept) {
      img.bytes = kept;
      img.mime = 'image/png';
    }
    const label = prompts.length > 1 ? { prompt: r.prompt } : {};
    let record;
    if (mode === 'http') {
      const id = await store.put({ bytes: img.bytes, mime: img.mime });
      const url = `${ctx.baseUrl}/files/${id}.${extForMime(img.mime)}`;
      record = { id, mime: img.mime, bytes: img.bytes.length, url, src: url, ...label };
    } else {
      record = await (saving = saving.catch(() => {}).then(async () => {
        const [path] = await outputPaths(out, r.prompt, [img], false, ctx.projectDir);
        await mkdir(dirname(path), { recursive: true });
        await writeFile(path, img.bytes);
        // The card shows a short path when the file is inside the project.
        const inside = relative(ctx.projectDir, path);
        const shown = inside && !inside.startsWith('..') && !isAbsolute(inside) ? inside : path;
        const id = await store.put({ path, mime: img.mime });
        // `src` is an address the card can load the picture from without calling back into this server.
        return { id, mime: img.mime, bytes: img.bytes.length, path, shown, ...(ctx.fileUrl && { src: ctx.fileUrl(id) }), ...label };
      }));
    }
    ready[index] = { img, record };
    await report();
  };
  // The images run side by side; one that fails does not lose the others.
  const runs = await Promise.allSettled(reqs.map(finish));
  const failed = runs.filter((r) => r.status === 'rejected');
  const credits = charge ? await charge.settle(runs.length - failed.length, ready.filter(Boolean).map((r) => r.record.id), { errors: failed.map((f) => f.reason) }).catch(() => null) : null;
  if (failed.length === runs.length) throw failed[0].reason;
  const images = ready.filter(Boolean).map((r) => r.img);
  const records = ready.filter(Boolean).map((r) => r.record);

  const where = records.map((r) => `- id ${r.id}: ${r.path || r.url}${r.prompt ? ` (${r.prompt.slice(0, 80)})` : ''}`).join('\n') + (failed.length ? `\n${failed.length} of the ${runs.length} prompts failed: ${failed.map((f) => f.reason?.message || 'error').join('; ')}` : '');
  const note = shownNote(ctx) + ' To edit an image, pass its id' + (mode === 'stdio' ? ' or path' : '') + ' in `images`.';
  // The card's data also rides in the text, for apps that hand the card only the text.
  const cardData = { provider: provider.id, providerLabel: provider.label, model, prompt: req.prompt, seconds: Math.round((Date.now() - started) / 100) / 10, edited: inputs.length > 0, images: records, ...(credits && credits.left <= 10 && { credits }) };
  const content = [
    { type: 'text', text: `Made ${records.length} image${records.length > 1 ? 's' : ''} with ${provider.id} (${model}).\n${where}\n${note}${credits && credits.left <= 10 ? `\nThe user has ${credits.left} image credit${credits.left === 1 ? '' : 's'} left; mention it in a few words.` : ''}\ntintloom-card:${JSON.stringify(cardData)}` },
  ];
  const blocks = {};
  for (const [i, img] of images.entries()) {
    // The model's own look at the result: the image itself when small, else a reduced copy.
    let seen = img.bytes.length <= MAX_INLINE_BYTES ? img.bytes : null;
    for (const edge of [1024, 768, 512]) {
      if (seen) break;
      const small = img.mime === 'image/png' ? shrinkPng(img.bytes, edge) : null;
      if (small && small.length <= MAX_INLINE_BYTES) seen = small;
    }
    if (seen) {
      // The card also shows this copy at once, before (or instead of) fetching the full image.
      // Counted among the image parts only: some apps add parts of their own between ours.
      blocks[records[i].id] = Object.keys(blocks).length;
      content.push({ type: 'image', data: seen.toString('base64'), mimeType: img.mime });
    }
  }
  // The card cannot always fetch the picture itself, so small copies travel with the result:
  // a preview in _meta (apps keep that from the model) and a tiny thumbnail in the card data,
  // which every app delivers but the model also reads, so it is kept very small.
  const previews = {};
  const thumbs = {};
  if (ctx.preview) {
    for (const [i, record] of records.entries()) {
      const made = await ctx.preview(images[i], record).catch(() => null);
      if (made?.preview) previews[record.id] = made.preview;
      if (made?.thumb) thumbs[record.id] = made.thumb;
    }
  }
  return {
    ...(Object.keys(previews).length && { _meta: { 'tintloom/previews': previews } }),
    content,
    // For the image card.
    structuredContent: { ...cardData, images: records.map((r) => ({ ...r, ...(thumbs[r.id] && { thumb: thumbs[r.id] }), ...(blocks[r.id] !== undefined && { pic: blocks[r.id] }) })), pics: Object.keys(blocks).length, note },
  };
}

/** Whether the app draws the image card is known only from what it said at initialize. */
function shownNote(ctx) {
  const ui = ctx.session?.ui;
  if (ui === true) return 'The user already sees the image in a card with an editor (Select, Comment, Remove BG, Erase, Resize, Variations); reply in one short line and do not describe the image.';
  if (ui === false) {
    return 'This app does not draw the image card, so the user has NOT seen the image yet. Show it to them: if you have a tool that displays or sends a file to the user, use it on the saved file; otherwise give its path.';
  }
  return 'Apps that draw the image card already show the user the image. Reply in one short line and do not describe the image. Add no links or paths unless the user says they cannot see it.';
}

function keyHint(env) {
  if (env.TINTLOOM_HOST === 'cloud') {
    return 'That provider is not available on this service. Leave out `provider` and `model` to use the default.';
  }
  if (env.TINTLOOM_HOST === 'plugin') {
    return 'Tell the user to add a provider key: run /plugin, open tintloom, choose Configure, paste a key (OpenAI, Gemini, fal, BytePlus ModelArk or Black Forest Labs), then restart the session. Do not ask for the key in chat.';
  }
  return 'Set a provider key in the server environment: OPENAI_API_KEY, GEMINI_API_KEY, FAL_KEY, ARK_API_KEY or BFL_API_KEY.';
}

async function callTool(name, args = {}, ctx) {
  try {
    if (name === 'generate_image') return await generateImage(args, ctx);
    if (name === 'get_upload_url') return await getUploadUrl(args, ctx);
    if (name === 'list_image_providers') return { content: [{ type: 'text', text: JSON.stringify(await listProviders(ctx.env), null, 2) }] };
    if (name === 'save_mask') {
      const bytes = Buffer.from(String(args.data || ''), 'base64');
      if (sniffMime(bytes) !== 'image/png' || bytes.length > MAX_INPUT_BYTES) throw new UserError('The selection could not be saved.');
      return { content: [{ type: 'text', text: 'saved' }], structuredContent: { id: await ctx.store.put({ bytes, mime: 'image/png' }) } };
    }
    if (name === 'save_selection') {
      let mask = null;
      if (args.mask) {
        const bytes = Buffer.from(String(args.mask), 'base64');
        if (sniffMime(bytes) !== 'image/png' || bytes.length > MAX_INPUT_BYTES) throw new UserError('The selection could not be saved.');
        mask = await ctx.store.put({ bytes, mime: 'image/png' });
      }
      const regions = !mask && Array.isArray(args.regions) && args.regions.length ? args.regions.slice(0, 20) : null;
      await (ctx.progress || memoryProgress).set('selection', { image: String(args.image || ''), mask, regions, erase: args.erase === true, at: Date.now(), used: false });
      return { content: [{ type: 'text', text: 'saved' }], structuredContent: { saved: true } };
    }
    if (name === 'get_progress') {
      const state = await (ctx.progress || memoryProgress).get(String(args.key || '')).catch(() => null);
      return { content: [{ type: 'text', text: 'progress' }], structuredContent: state || { images: [] } };
    }
    if (name === 'open_image') return openAddImage(ctx);
    if (name === 'upload_image_part') {
      const upload = String(args.upload || '');
      const index = Math.floor(Number(args.index));
      if (!/^[a-z0-9]{16,32}$/.test(upload) || !(index >= 0 && index < 200) || typeof args.data !== 'string' || !args.data || args.data.length > 400_000) throw new UserError('That piece of the image could not be saved.');
      await (ctx.cardUploads?.put || uploadParts.put)(upload, index, args.data);
      return { content: [{ type: 'text', text: 'saved' }], structuredContent: { saved: true } };
    }
    if (name === 'finish_image_upload') {
      const upload = String(args.upload || '');
      const total = Math.floor(Number(args.total));
      if (!/^[a-z0-9]{16,32}$/.test(upload) || !(total >= 1 && total <= 200)) throw new UserError('That image could not be added.');
      const parts = ctx.cardUploads || uploadParts;
      const pieces = [];
      for (let i = 0; i < total; i++) {
        const piece = await parts.get(upload, i);
        if (typeof piece !== 'string') throw new UserError(`Piece ${i + 1} of ${total} did not arrive.`, 'Add the image again.');
        pieces.push(piece);
      }
      await (parts.clear || uploadParts.clear)(upload, total).catch(() => {});
      const made = await (ctx.cardUploads?.accept || ((bytes) => acceptUpload(bytes, ctx)))(Buffer.from(pieces.join(''), 'base64'));
      return uploadedCard(made, ctx);
    }
    if (name === 'get_upload_ticket') {
      if (!ctx.uploads?.ticket) throw new UserError('Sending an image straight to Tintloom is not available here.');
      const t = await ctx.uploads.ticket({});
      // The address is the one credential, and it is given only to the card that asked, here.
      return { content: [{ type: 'text', text: 'ticket' }], structuredContent: { upload_url: t.uploadUrl, expires_in_seconds: t.expiresInSeconds, max_bytes: t.maxBytes, part_bytes: UPLOAD_PART_BYTES } };
    }
    if (name === 'finish_direct_upload') {
      if (!ctx.uploads?.ticket) throw new UserError('Sending an image straight to Tintloom is not available here.');
      const id = String(args.id || '');
      if (!/^img_[A-Za-z0-9_-]{8,40}$/.test(id)) throw new UserError('That image could not be added.');
      const stored = await ctx.store.get(id).catch(() => null);
      const size = stored && imageSize(stored.bytes);
      if (!stored || !size) throw new UserError('That image could not be added.', 'Add the image again.');
      // The site already checked and cleaned it (the same finishing step as get_upload_url); this only opens it in the card.
      return uploadedCard({ id, mime: stored.mime, width: size.width, height: size.height, bytes: stored.bytes.length }, ctx);
    }
    if (name === 'get_layer_set') {
      const notes = ctx.progress || memoryProgress;
      const set = await notes.get(`layerset-${String(args.id || '')}`).catch(() => null);
      // What the user moved and hid, kept under the base's id (the dashboard reads and writes the same note).
      // Read through the cleaning, so an arrangement kept in an older shape (0.8.17's `scales`) comes back in the one shape.
      const kept = set?.images?.[0]?.id ? await notes.get(`layerarr-${set.images[0].id}`).catch(() => null) : null;
      const arrangement = kept ? cleanArrangement(kept, set.images.map((i) => i.id)) : null;
      return { content: [{ type: 'text', text: set ? 'layer set' : 'no layer set' }], structuredContent: { set: set || null, arrangement: arrangement || null } };
    }
    if (name === 'save_layer_arrangement') {
      const notes = ctx.progress || memoryProgress;
      const id = String(args.id || '');
      const set = await notes.get(`layerset-${id}`).catch(() => null);
      if (!set?.images?.length || set.images[0].id !== id) throw new UserError('That layer set is not available.');
      await notes.set(`layerarr-${id}`, cleanArrangement(args, set.images.map((i) => i.id)));
      return { content: [{ type: 'text', text: 'saved' }], structuredContent: { saved: true } };
    }
    if (name === 'get_generated_image') {
      const image = await ctx.store.get(args.id);
      if (!image) throw new UserError('That image is no longer available.');
      // The card reads large images in pieces; apps cap the size of one message.
      // `edge` asks for a display-size copy (the layer view draws from these and fetches the full image only to download it).
      const edge = Math.floor(Number(args.edge)) || 0;
      let bytes = image.bytes;
      let mime = image.mime;
      if (edge >= 64 && image.mime === 'image/png') {
        const key = `${args.id}|${Math.min(edge, 2048)}`;
        let small = viewCache.get(key);
        if (!small) {
          small = shrinkPng(image.bytes, Math.min(edge, 2048));
          // A copy no smaller than the image (or one that cannot be made) is the image itself.
          small = small && small.length < image.bytes.length ? small : image.bytes;
          viewCache.set(key, small);
          if (viewCache.size > 12) viewCache.delete(viewCache.keys().next().value);
        }
        bytes = small;
      }
      const all = bytes.toString('base64');
      const offset = Math.max(0, Number(args.offset) || 0);
      const chunk = all.slice(offset, offset + IMAGE_CHUNK);
      return { content: [{ type: 'text', text: `image part ${offset}-${offset + chunk.length} of ${all.length}` }], structuredContent: { chunk, total: all.length, mime } };
    }
    return { isError: true, content: [{ type: 'text', text: `Unknown tool: ${name}` }] };
  } catch (e) {
    // A host that keeps a failure log is told first, with the error as it was thrown (it ignores one its meter already recorded).
    try { await ctx.onFailure?.(e, name, args); } catch { /* logging must never change the answer */ }
    // Raised by a host's meter: out of credits (the card shows a top-up button), or a request it will not run.
    if (e?.billing) return { isError: true, content: [{ type: 'text', text: e.message }], structuredContent: { billing: e.billing } };
    if (e?.declined) return { isError: true, content: [{ type: 'text', text: e.message }] };
    if (!(e instanceof UserError)) console.error(e);
    const message = e instanceof UserError ? e.message : 'The image server hit an unexpected error.';
    // CLI hints name a terminal command; here the fix is the plugin's settings or the server's environment.
    const hint = /\bkey\b/i.test(message) ? keyHint(ctx.env) : e.hint;
    return { isError: true, content: [{ type: 'text', text: hint ? `${message}\n${hint}` : message }] };
  }
}

/** How the app should frame the card, and which addresses it may load pictures from. */
function cardMeta(ctx) {
  const domains = typeof ctx.cardDomains === 'function' ? ctx.cardDomains() : ctx.cardDomains;
  return { ui: { prefersBorder: false, permissions: { clipboardWrite: {} }, ...(domains?.length && { csp: { resourceDomains: domains, connectDomains: domains } }) } };
}

// ---------- MCP (JSON-RPC 2.0) ----------

export async function handleMessage(msg, ctx) {
  const reply = (result) => ({ jsonrpc: '2.0', id: msg.id, result });
  const fail = (code, message) => ({ jsonrpc: '2.0', id: msg?.id ?? null, error: { code, message } });
  if (!msg || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') return fail(-32600, 'Invalid request');
  if (msg.id === undefined) return null; // a notification: nothing to answer
  switch (msg.method) {
    case 'initialize': {
      // Apps that can draw the card say so here (MCP Apps extension).
      const ui = Boolean(msg.params?.capabilities?.extensions?.['io.modelcontextprotocol/ui']);
      if (ctx.session) {
        ctx.session.ui = ui;
        ctx.session.roots = Boolean(msg.params?.capabilities?.roots);
      }
      if (ctx.env.TINTLOOM_DEBUG_LOG) await writeFile(ctx.env.TINTLOOM_DEBUG_LOG, JSON.stringify({ clientInfo: msg.params?.clientInfo, capabilities: msg.params?.capabilities }, null, 2)).catch(() => {});
      return reply({
        protocolVersion: msg.params?.protocolVersion || PROTOCOL,
        capabilities: { tools: {}, resources: {} },
        serverInfo: { name: 'tintloom', title: 'Tintloom', version: VERSION, websiteUrl: 'https://tintloom.com', icons: [{ src: 'https://tintloom.com/icon-512.png', mimeType: 'image/png', sizes: ['512x512'] }] },
        instructions: [
          'Image generation and editing. Use generate_image whenever the user asks to create, draw, render or edit an image. Each result says whether the user can already see the image.',
          'Editing: every result lists an id per image. When the user asks to change an image, in a chat message or through the image card, call generate_image again with `images: [{ id }]` of the image they mean (the latest one unless they say otherwise) and a prompt that says what changes and what stays. Never start over from text when an image exists.',
          'Messages from the image card say "this image" or "the selected area" and give no id: call generate_image with `selection: true` and leave out `images`, `mask` and `erase`. The server knows which image is open and what the user painted, and whether it is an erase. For a selected area, write the change as the prompt and name the object it is about if you can tell ("make the kite red"); it keeps its shape and position.',
          'One part only, without the card: add `mask` or `edit_regions`; everything outside is kept exactly. Name the object inside the area in the prompt ("make the kite red", not "make it red"). To remove something: the same, plus `erase: true`.',
          'Remove the background: provider openai, model gpt-image-1.5, background transparent, fidelity high. New shape: `aspect`, with a prompt to keep the scene and extend it. Variations: `count`. Several different images at once: `prompts`, one prompt each, shown as one gallery.',
          'The user\'s own picture: an image attached to the chat cannot be read here. If you can run commands, get_upload_url sends it; otherwise (or if that fails) call generate_image with `add_image: true` so the user can add it in the card, wait for their message with the new image id, then use it in `images`. Never pass an attached image as base64.',
          'Make one image per request unless asked for more: each image costs the user money.',
          ...(ctx.instructions || []),
        ].join('\n'),
      });
    }
    case 'ping':
      return reply({});
    case 'tools/list':
      return reply({ tools: toolsFor(ctx) });
    case 'tools/call':
      return reply(await callTool(msg.params?.name, msg.params?.arguments, ctx));
    case 'resources/list':
      return reply({ resources: [{ uri: CARD_URI, name: 'Image card', mimeType: CARD_MIME, _meta: cardMeta(ctx) }] });
    case 'resources/templates/list':
      return reply({ resourceTemplates: [] });
    case 'resources/read':
      if (msg.params?.uri !== CARD_URI) return fail(-32002, `Resource not found: ${msg.params?.uri}`);
      return reply({ contents: [{ uri: CARD_URI, mimeType: CARD_MIME, text: ctx.cardHtml, _meta: cardMeta(ctx) }] });
    default:
      return fail(-32601, `Method not found: ${msg.method}`);
  }
}

