// BytePlus ModelArk: ByteDance's own Seedream models, called directly (no reseller).
// Docs, read 17 November 2026:
//   https://docs.byteplus.com/en/docs/modelark/image-generation-api   (request, response, sizes, limits)
//   https://docs.byteplus.com/en/docs/modelark/model-pricing          (price per image)
import { imageSize } from '../lib/png.mjs';
import { UserError, download, fromBase64, http, ratioOf, sizeForRatio } from '../lib/util.mjs';

const ENDPOINT = 'https://ark.ap-southeast.bytepluses.com/api/v3/images/generations';

// Short names for the Seedream models. Any full ModelArk model id also works. Each model has to be activated
// on the account in the ModelArk console before it can be called (an unactivated one answers HTTP 404).
const ALIASES = {
  seedream: 'dola-seedream-5-0-flash-260915', // Seedream 5.0 flash: $0.018 an image at any size, input images free
  'seedream-5-flash': 'dola-seedream-5-0-flash-260915',
  'seedream-5.5': 'dola-seedream-5-5-261028', // $0.02 an image up to about 1.5K, $0.035 up to 2K, $0.008 per input image
  'seedream-4.5': 'seedream-4-5-251128',
  'seedream-4': 'seedream-4-0-250828',
};

/** Reference images one request may carry. Seedream 5.5, 5.0 pro and 5.0 flash take 10; the older models 14. */
const MAX_REFERENCES = 10;

// Pixels ModelArk takes for the 5.x models: between 921,600 and 4,624,220, with a ratio between 1:16 and 16:1.
// Seedream 5.5 prices an image up to 2,601,123 pixels (1536x1536 x 1.05^2) at the lower rate, so it is kept under
// that; the flash and 4.x models have one price at any size, so they get about 2048x2048 worth of pixels.
const MIN_PIXELS = 1280 * 720;
const tiered = (model) => model.includes('seedream-5-5');

/** The size to ask for: the ratio asked for, at about 1.5K (5.5) or 2K (others), as "WIDTHxHEIGHT". */
export function sizeFor(req, model = '') {
  const target = tiered(model) ? 1536 * 1536 : 2048 * 2048;
  // An edit with no shape asked for keeps the first input image's shape.
  const first = req.images?.[0] && imageSize(req.images[0].bytes);
  const ratio = ratioOf(req) ?? (first ? first.width / first.height : null);
  if (ratio === null) return tiered(model) ? '1536x1536' : '2048x2048';
  const r = Math.min(16, Math.max(1 / 16, ratio));
  let { width, height } = sizeForRatio(r, target);
  // Snapping to multiples of 16 can leave a thin strip under the minimum; grow it until it fits.
  while (width * height < MIN_PIXELS) [width, height] = [Math.round(width * 1.05), Math.round(height * 1.05)];
  return `${width}x${height}`;
}

/** Most images a layers request hands back: the base plus 9 layers. ModelArk may return more (flash: base + up to 16) and bills all of them. */
export const MAX_LAYER_IMAGES = 10;

/**
 * The request body for one image. Always one image (sequential generation is left at its default, off) and no watermark.
 * Layers (`layer_decomposition`): one input image, a resolution tier for `size` (a WxH is refused), and no `background`
 * (refused). `output_format` then only applies to the base image: layers are always PNG with an alpha channel.
 */
export function buildBody(req, model) {
  if (req.layers) {
    return {
      model, prompt: req.prompt, image: `data:${String(req.images[0].mime).toLowerCase()};base64,${req.images[0].bytes.toString('base64')}`,
      layer_decomposition: true, size: '2K', response_format: 'b64_json', output_format: 'png', watermark: false,
    };
  }
  const body = { model, prompt: req.prompt, size: sizeFor(req, model), response_format: 'b64_json', watermark: false };
  if (req.images.length) body.image = req.images.map((i) => `data:${String(i.mime).toLowerCase()};base64,${i.bytes.toString('base64')}`);
  // output_format is a 5.x parameter; the 4.x models always answer in jpeg.
  if (model.includes('seedream-5') && (req.format === 'png' || req.format === 'jpeg' || req.format === 'jpg')) body.output_format = req.format === 'png' ? 'png' : 'jpeg';
  return body;
}

/**
 * Where an image URL in an answer may be fetched from. We ask for base64, so this is a fallback: only
 * https on ModelArk's own storage and API hosts, no port, no credentials. A local stand-in set with
 * MODELARK_BASE_URL is also trusted, on its own origin only. Returns the address, or null.
 */
export function modelarkUrl(raw, env = {}) {
  let url;
  try {
    url = new URL(String(raw));
  } catch {
    return null;
  }
  let standIn = null;
  try {
    standIn = env.MODELARK_BASE_URL ? new URL(env.MODELARK_BASE_URL).origin : null;
  } catch {
    /* not a URL: no stand-in */
  }
  if (standIn && url.origin === standIn) return url.href;
  if (url.protocol !== 'https:' || url.port || url.username || url.password) return null;
  return /(^|\.)(volces\.com|bytepluses\.com|byteplus\.com|byteplusapi\.com)$/.test(url.hostname.toLowerCase()) ? url.href : null;
}

/** Area of a layer's bounding box in pixels of the base image; `absolute` is [left, top, right, bottom], `normalized` the same on a 0-1000 scale. 0 when not given. */
export function boxArea(box) {
  const a = box?.absolute;
  const n = box?.normalized;
  const [l, t, r, b] = Array.isArray(a) && a.length === 4 ? a : Array.isArray(n) && n.length === 4 ? n : [0, 0, 0, 0];
  return Math.max(0, Number(r) - Number(l)) * Math.max(0, Number(b) - Number(t)) || 0;
}

/**
 * Which of the answer's images to keep: at most MAX_LAYER_IMAGES. The base (lowest z_index) always stays, then the
 * layers with the largest bounding boxes; the result is in z_index order, base first. Returns { kept, leftOut }.
 */
export function pickLayers(items) {
  const sorted = items.map((item, at) => ({ item, at, z: Number.isFinite(Number(item.z_index)) ? Number(item.z_index) : at })).sort((a, b) => a.z - b.z || a.at - b.at);
  if (sorted.length <= MAX_LAYER_IMAGES) return { kept: sorted.map((x) => x.item), leftOut: 0 };
  const [base, ...layers] = sorted;
  const chosen = new Set([...layers].sort((a, b) => boxArea(b.item.bounding_box) - boxArea(a.item.bounding_box) || a.z - b.z).slice(0, MAX_LAYER_IMAGES - 1));
  return { kept: [base, ...layers.filter((l) => chosen.has(l))].map((x) => x.item), leftOut: sorted.length - MAX_LAYER_IMAGES };
}

export default {
  id: 'modelark',
  label: 'BytePlus ModelArk (Seedream)',
  envKeys: ['TINTLOOM_MODELARK_KEY', 'ARK_API_KEY'],
  defaultModel: 'seedream',
  models: ['seedream', 'seedream-5-flash', 'seedream-4.5', 'seedream-4', '<any ModelArk model id>'],
  notes: 'ByteDance\'s own Seedream. Edits and blends up to 10 reference images, and splits one image into transparent layers (layers: true). Key from the BytePlus ModelArk console.',
  capabilities: { edit: true, mask: false, transparent: false, multiple: true, layers: true },

  /** Splits one image into a base and transparent layers. One request, billed per image returned. */
  async layers(req, ctx) {
    if (req.images.length !== 1) throw new UserError('Splitting into layers takes exactly one image.');
    if (req.mask) throw new UserError('Layers cannot be limited to an area; the whole image is split.');
    const [input] = req.images;
    if (!['image/png', 'image/jpeg'].includes(String(input.mime).toLowerCase())) throw new UserError('Splitting into layers needs a PNG or JPEG image.', 'Convert the image to PNG or JPEG first.');
    const dims = imageSize(input.bytes);
    // ModelArk's limits for this mode: 262,144 to 36,000,000 pixels, a ratio between 1:16 and 16:1, up to 30 MB.
    if (input.bytes.length > 30 * 1024 * 1024) throw new UserError('Splitting into layers takes an image up to 30 MB.');
    if (dims && (dims.width * dims.height < 262_144 || dims.width * dims.height > 36_000_000)) throw new UserError(`Splitting into layers needs an image of 512x512 to 6000x6000 pixels; this one is ${dims.width}x${dims.height}.`);
    if (dims && Math.max(dims.width / dims.height, dims.height / dims.width) > 16) throw new UserError('Splitting into layers needs an image no more than 16 times wider than tall (or the reverse).');
    const model = ALIASES[req.model] || req.model || ALIASES[this.defaultModel];
    if (!model.includes('seedream-5')) throw new UserError('Splitting into layers needs Seedream 5.x.');
    const base = ctx.env.MODELARK_BASE_URL ? `${ctx.env.MODELARK_BASE_URL.replace(/\/+$/, '')}/images/generations` : ENDPOINT;
    const json = await http(base, {
      method: 'POST',
      headers: { Authorization: `Bearer ${ctx.key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(buildBody(req, model)),
      secrets: [ctx.key],
      label: 'ModelArk layers request',
    });
    if (json?.error) throw new UserError(`ModelArk could not split the image: ${json.error.message || json.error.code || 'unknown error'}`);
    const items = Array.isArray(json?.data) ? json.data : [];
    if (items.some((d) => !d || d.error)) throw new UserError('ModelArk could not make every layer, so it returned none.', 'Try again.');
    const usable = items.filter((d) => d.b64_json || d.url);
    if (!usable.length) throw new UserError('ModelArk returned no layers.', 'The image may have been declined, or it has nothing to separate.');
    const { kept, leftOut } = pickLayers(usable);
    const out = [];
    for (const item of kept) {
      let image;
      if (item.b64_json) image = fromBase64(item.b64_json, item.output_format === 'jpeg' ? 'image/jpeg' : 'image/png');
      else {
        const url = modelarkUrl(item.url, ctx.env);
        if (!url) throw new UserError('ModelArk answered with an address that is not one of its own, so it was not followed.');
        image = await download(url);
      }
      out.push({ ...image, name: typeof item.name === 'string' ? item.name.slice(0, 80) : null, description: typeof item.description === 'string' ? item.description.slice(0, 300) : null, zIndex: Number.isFinite(Number(item.z_index)) ? Number(item.z_index) : out.length, boundingBox: item.bounding_box || null, size: typeof item.size === 'string' ? item.size : null });
    }
    // How many the answer held in all (all of them are billed): the caller says so when some were left out.
    return Object.assign(out, { leftOut, returned: usable.length });
  },

  async generate(req, ctx) {
    if (req.layers) return this.layers(req, ctx);
    if (req.background === 'transparent') {
      throw new UserError('Transparent backgrounds are not used with Seedream here.', 'Use --provider openai --model gpt-image-1.5.');
    }
    if (req.mask) throw new UserError('Masks are not supported through ModelArk here.', 'Use --provider openai.');
    if (req.images.length > MAX_REFERENCES) throw new UserError(`Seedream takes at most ${MAX_REFERENCES} input images.`);
    const model = ALIASES[req.model] || req.model || ALIASES[this.defaultModel];
    const base = ctx.env.MODELARK_BASE_URL ? `${ctx.env.MODELARK_BASE_URL.replace(/\/+$/, '')}/images/generations` : ENDPOINT;
    const body = JSON.stringify(buildBody(req, model));
    const out = [];
    // One image per request, however many are wanted: the price is per image and nothing is generated that is not asked for.
    for (let i = 0; i < req.n; i++) {
      const json = await http(base, {
        method: 'POST',
        headers: { Authorization: `Bearer ${ctx.key}`, 'Content-Type': 'application/json' },
        body,
        secrets: [ctx.key],
        label: 'ModelArk image request',
      });
      if (json?.error) throw new UserError(`ModelArk could not generate the image: ${json.error.message || json.error.code || 'unknown error'}`);
      const item = (json?.data || []).find((d) => d && !d.error && (d.b64_json || d.url));
      if (!item) throw new UserError('ModelArk returned no image.', 'The prompt may have been declined. Rephrase it and try again.');
      if (item.b64_json) out.push(fromBase64(item.b64_json));
      else {
        const url = modelarkUrl(item.url, ctx.env);
        if (!url) throw new UserError('ModelArk answered with an address that is not one of its own, so it was not followed.');
        out.push(await download(url));
      }
    }
    return out;
  },
};
