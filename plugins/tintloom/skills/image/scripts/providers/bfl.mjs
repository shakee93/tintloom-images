// Black Forest Labs (Flux), called directly.
// Docs, read 18 November 2026:
//   https://docs.bfl.ai/flux_2/flux2_text_to_image                      (FLUX.2: endpoint, polling, 10 minute result links)
//   https://docs.bfl.ml/api-reference/models/generate-or-edit-an-image-with-flux2-[pro].md   (FLUX.2 request fields)
//   https://docs.bfl.ml/api-reference/utility/generate-an-image-with-flux-3.md                (FLUX 3 Image request fields)
//   https://docs.bfl.ml/api-reference/utility/generate-an-image-with-flux-3-klein.md          (FLUX 3 Image Klein)
//   https://docs.bfl.ml/api_integration/integration_guidelines.md       (always poll the polling_url; download at once)
//   https://docs.bfl.ml/api_integration/errors.md                       (402, 429, moderation statuses)
// Flow: POST the model's endpoint with the key in `x-key`; it answers { id, polling_url }; GET the polling_url
// until status is "Ready"; `result.sample` is a link to the image that stops working after 10 minutes.
import { fitPng, imageSize } from '../lib/png.mjs';
import { UserError, download, http, limits, nearestAspect, ratioOf, sleep, sniffMime } from '../lib/util.mjs';

const ENDPOINT = 'https://api.bfl.ai/v1';
const MP = 1024 * 1024; // BFL counts a megapixel as 1024 x 1024 pixels
const ASPECTS = ['21:9', '2:1', '16:9', '3:2', '7:5', '4:3', '5:4', '1:1', '4:5', '3:4', '5:7', '2:3', '9:16', '1:2', '9:21'];

// family "flux2": width and height in pixels, input_image, input_image_2 ... (up to the limit), output_format.
// family "flux3": aspect_ratio and a resolution tier, one `images` list (up to 10), output_format on Klein only.
const MODELS = {
  'flux-2-pro': { family: 'flux2', refs: 8, formats: ['jpeg', 'png', 'webp'] },
  'flux-2-max': { family: 'flux2', refs: 8, formats: ['jpeg', 'png', 'webp'] },
  'flux-2-flex': { family: 'flux2', refs: 8, formats: ['jpeg', 'png', 'webp'] },
  'flux-2-klein-9b': { family: 'flux2', refs: 4, formats: ['jpeg', 'png', 'webp'] },
  'flux-2-klein-4b': { family: 'flux2', refs: 4, formats: ['jpeg', 'png', 'webp'] },
  'flux-3-image': { family: 'flux3', refs: 10, formats: [] },
  'flux-3-image-klein': { family: 'flux3', refs: 10, formats: ['jpeg', 'png'] },
};

const ALIASES = {
  flux: 'flux-2-pro',
  'flux-2': 'flux-2-pro',
  'flux-3': 'flux-3-image',
  'flux-3-klein': 'flux-3-image-klein',
  'flux-klein': 'flux-3-image-klein',
};

export function resolveModel(name) {
  const id = ALIASES[name] || name;
  if (!MODELS[id]) throw new UserError(`Unknown Black Forest Labs model "${name}".`, `Use one of: ${Object.keys(MODELS).join(', ')}.`);
  return id;
}

/** Pixels allowed for the output: 1 MP by default, 2 MP for `high`, 4 MP for `xhigh` and `max`. FLUX.2 bills each started megapixel. */
const budgetFor = (quality) => (quality === 'xhigh' || quality === 'max' ? 4 * MP : quality === 'high' ? 2 * MP : MP);

/** Width and height (multiples of 16, within `budget` pixels) for a ratio. */
export function dimensionsFor(ratio, budget = MP) {
  const r = Math.min(16, Math.max(1 / 16, ratio));
  const floor16 = (v) => Math.max(64, Math.floor(v / 16) * 16);
  let height = floor16(Math.sqrt(budget / r));
  let width = floor16(height * r);
  while (width * height > budget && (width > 64 || height > 64)) {
    if (width >= height) width -= 16;
    else height -= 16;
  }
  return { width, height };
}

/**
 * On the hosted service an input image is brought down to 1 MP before it is sent: BFL bills each started megapixel of
 * every reference, and the catalogue prices an input at that. The host may supply `ctx.shrink(image, maxPixels)` (the
 * website does, for JPEG and PNG); otherwise a PNG is scaled here, and anything else that is too big is refused
 * rather than sent and charged for. With your own key nothing is changed.
 */
export async function fitInput(img, ctx) {
  if (ctx.env.TINTLOOM_HOST !== 'cloud') return img;
  const size = imageSize(img.bytes);
  if (size && size.width * size.height <= MP) return img;
  if (ctx.shrink) return ctx.shrink(img, MP);
  const png = sniffMime(img.bytes) === 'image/png' ? fitPng(img.bytes, MP) : null;
  if (png) return { ...img, bytes: png, mime: 'image/png' };
  throw new UserError('This picture is too large for Flux to take and could not be made smaller here.', 'Use a picture under 1 megapixel (about 1000x1000), or choose another model.');
}

const asFormat = (req, model) => {
  const wanted = req.format === 'jpg' ? 'jpeg' : req.format;
  if (MODELS[model].formats.includes(wanted)) return wanted;
  return MODELS[model].formats.includes('png') ? 'png' : null;
};

/**
 * The JSON body for one image. `host` is "cloud" when the hosted service runs this: there a size sent by a caller
 * only sets the shape, never the pixel count, because the price follows the megapixels.
 */
export function buildBody(req, model, host = 'local') {
  const spec = MODELS[model];
  const body = { prompt: req.prompt };
  const first = req.images[0] && imageSize(req.images[0].bytes);
  const ratio = ratioOf(req) ?? (first ? first.width / first.height : null);
  const budget = budgetFor(req.quality);
  const exact = req.size && host !== 'cloud' ? req.size : null;
  const refs = req.images.map((i) => i.bytes.toString('base64'));

  if (spec.family === 'flux2') {
    const size = exact
      ? dimensionsFor(exact.width / exact.height, Math.min(exact.width * exact.height, 4 * MP))
      : dimensionsFor(ratio ?? 1, budget);
    body.width = size.width;
    body.height = size.height;
    refs.forEach((b64, i) => {
      body[i === 0 ? 'input_image' : `input_image_${i + 1}`] = b64;
    });
  } else {
    if (exact) {
      const size = dimensionsFor(exact.width / exact.height, Math.min(exact.width * exact.height, req.images.length ? 4 * MP : 16 * MP));
      body.width = size.width;
      body.height = size.height;
    } else {
      // Equal-area tiers: 1k is about 1 MP, 1.5k about 2 MP, 2k about 4 MP.
      body.resolution = budget >= 4 * MP ? '2k' : budget >= 2 * MP ? '1.5k' : '1k';
      if (ratio !== null) body.aspect_ratio = nearestAspect(ratio, ASPECTS);
    }
    if (refs.length) body.images = refs;
  }
  const format = asFormat(req, model);
  if (format) body.output_format = format;
  return body;
}

/**
 * Whether a link in an answer may be followed. The polling link gets the key, and the image link is fetched
 * without it; both must be https on BFL's own hosts (api.bfl.ai, api.eu.bfl.ai, delivery.*.bfl.ai ...), with no
 * port or credentials. A local stand-in set with BFL_BASE_URL is also trusted, on its own origin only.
 */
export function bflUrl(raw, env = {}) {
  let url;
  try {
    url = new URL(String(raw));
  } catch {
    return null;
  }
  let standIn = null;
  try {
    standIn = env.BFL_BASE_URL ? new URL(env.BFL_BASE_URL).origin : null;
  } catch {
    /* not a URL: no stand-in */
  }
  if (standIn && url.origin === standIn) return url.href;
  if (url.protocol !== 'https:' || url.port || url.username || url.password) return null;
  const host = url.hostname.toLowerCase();
  return host === 'bfl.ai' || host.endsWith('.bfl.ai') || host.endsWith('.bfl.ml') ? url.href : null;
}

const followed = (raw, env) => {
  const url = bflUrl(raw, env);
  if (!url) throw new UserError('Black Forest Labs answered with an address that is not one of its own, so it was not followed.');
  return url;
};

const reasons = (details) => {
  const list = details?.['Moderation Reasons'] || details?.moderation_reasons;
  return Array.isArray(list) && list.length ? ` (${list.join(', ')})` : '';
};

/** Retries a request that was refused for being too busy (429) or briefly down (502 to 504), then gives up. */
async function withRetry(run, sleepMs = sleep) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await run();
    } catch (e) {
      if (![429, 502, 503, 504].includes(e.status) || attempt >= 3) throw e;
      await sleepMs(1000 * 2 ** attempt);
    }
  }
}

/** Polls until the image is ready; returns the (still to be downloaded) image link. */
export async function waitForResult(pollingUrl, opts, { env = {}, now = Date.now, sleepMs = sleep, timeoutMs = limits.pollMs } = {}) {
  const deadline = now() + timeoutMs;
  for (let wait = 500; ; wait = Math.min(wait * 1.5, 3000)) {
    const status = await withRetry(() => http(pollingUrl, { ...opts, label: 'Black Forest Labs status check' }), sleepMs);
    switch (status?.status) {
      case 'Ready': {
        if (!status.result?.sample) throw new UserError('Black Forest Labs finished but sent no image.');
        return followed(status.result.sample, env);
      }
      case 'Request Moderated':
        throw new UserError(`Black Forest Labs declined the request: its safety filter flagged the prompt or an input image${reasons(status.details)}.`, 'Rephrase the prompt, or use a different input image, and try again.');
      case 'Content Moderated':
        throw new UserError(`Black Forest Labs made an image and then withheld it: its safety filter flagged the result${reasons(status.details)}.`, 'Rephrase the prompt and try again.');
      case 'No Card Generated':
      case 'Error':
      case 'Failed':
        throw new UserError(`Black Forest Labs could not make the image${typeof status.details === 'string' ? `: ${status.details}` : ''}.`, 'Try again, or try a different model.');
      case 'Task not found':
        throw new UserError('Black Forest Labs lost track of the request (task not found).', 'Try again.');
      default: // Pending, Reasoning, Generating, or anything new that is not final
        break;
    }
    if (now() > deadline) throw new UserError(`Black Forest Labs did not finish within ${Math.round(timeoutMs / 1000)} seconds.`, 'Try a smaller size or a faster model such as flux-3-image-klein.');
    await sleepMs(wait);
  }
}

async function makeOne(req, ctx, model) {
  const base = (ctx.env.BFL_BASE_URL || ENDPOINT).replace(/\/+$/, '');
  const opts = { headers: { 'x-key': ctx.key, accept: 'application/json', 'Content-Type': 'application/json' }, secrets: [ctx.key] };
  const body = JSON.stringify(buildBody(req, model, ctx.env.TINTLOOM_HOST));
  let job;
  try {
    job = await withRetry(() => http(`${base}/${model}`, { ...opts, method: 'POST', body, label: 'Black Forest Labs image request' }));
  } catch (e) {
    if (e.status === 402) throw Object.assign(new UserError('Black Forest Labs says the account is out of credits.', 'Add credits at https://dashboard.bfl.ai.'), { status: 402 });
    throw e;
  }
  if (!job?.polling_url) throw new UserError('Black Forest Labs did not accept the request.');
  // Checked before the key is sent to it.
  const pollingUrl = followed(job.polling_url, ctx.env);
  const imageUrl = await waitForResult(pollingUrl, opts, { env: ctx.env });
  // The link stops working after 10 minutes, so it is fetched at once, and without the key.
  return download(imageUrl);
}

export default {
  id: 'bfl',
  label: 'Black Forest Labs (Flux)',
  envKeys: ['TINTLOOM_BFL_KEY', 'BFL_API_KEY'],
  defaultModel: 'flux-2-pro',
  models: ['flux-2-pro', 'flux-2-max', 'flux-2-flex', 'flux-2-klein-9b', 'flux-2-klein-4b', 'flux-3-image', 'flux-3-image-klein'],
  notes: 'Flux directly from its maker. flux-2-pro is the all-rounder; flux-3-image-klein is the fast, cheap one. Edits take up to 8 reference images (Klein 4, FLUX 3 10).',
  capabilities: { edit: true, mask: false, transparent: false, multiple: true },

  async generate(req, ctx) {
    if (req.background === 'transparent') {
      throw new UserError('Flux models cannot produce a transparent background.', 'Use --provider openai --model gpt-image-1.5.');
    }
    if (req.mask) throw new UserError('Flux models here do not take a mask.', 'Describe the area to change in the prompt, or use --provider openai.');
    const model = resolveModel(req.model || this.defaultModel);
    const limit = MODELS[model].refs;
    if (req.images.length > limit) throw new UserError(`${model} takes at most ${limit} input images.`);
    const fitted = { ...req, images: await Promise.all(req.images.map((img) => fitInput(img, ctx))) };
    // One request per image, in parallel: BFL allows 24 at a time.
    return Promise.all(Array.from({ length: req.n }, () => makeOne(fitted, ctx, model)));
  },
};
