// fal.ai: one key for many hosted models (Seedream, Flux and more).
// Docs: https://fal.ai/docs/model-apis/model-endpoints/queue
import { UserError, download, http, limits, ratioOf, sizeForRatio, sleep, toDataUri } from '../lib/util.mjs';

const QUEUE = 'https://queue.fal.run';

// Short names for common models. Any full fal model id also works.
const ALIASES = {
  seedream: { generate: 'fal-ai/bytedance/seedream/v4/text-to-image', edit: 'fal-ai/bytedance/seedream/v4/edit' },
  'flux-schnell': { generate: 'fal-ai/flux/schnell' },
};

/**
 * fal's answers name the addresses to poll and to download from. Only fal's own hosts are followed:
 * the status and result addresses (which get the key) on queue.fal.run, and the image files on fal's
 * file hosts. A local stand-in set with FAL_QUEUE_URL is also trusted, on its own origin only.
 * Returns the address to use, or null for one that must not be followed.
 */
export function falUrl(raw, kind, env = {}) {
  let url;
  try {
    url = new URL(String(raw));
  } catch {
    return null;
  }
  let standIn = null;
  try {
    standIn = env.FAL_QUEUE_URL ? new URL(env.FAL_QUEUE_URL).origin : null;
  } catch {
    /* not a URL: no stand-in */
  }
  if (standIn && url.origin === standIn) return url.href;
  if (url.protocol !== 'https:' || url.port || url.username || url.password) return null;
  const host = url.hostname.toLowerCase();
  const ok = kind === 'queue' ? host === 'queue.fal.run' : host === 'fal.media' || /\.(fal\.media|fal\.run|fal\.ai)$/.test(host);
  return ok ? url.href : null;
}

const followed = (raw, kind, env) => {
  const url = falUrl(raw, kind, env);
  if (!url) throw new UserError('fal answered with an address that is not one of its own, so it was not followed.');
  return url;
};

export function resolveModel(name, editing) {
  const alias = ALIASES[name];
  if (!alias) return name;
  if (editing && !alias.edit) throw new UserError(`fal model "${name}" cannot edit images.`, 'Use --model seedream, or pass a full fal edit model id.');
  return editing ? alias.edit : alias.generate;
}

export function buildInput(req) {
  const input = { prompt: req.prompt, num_images: req.n };
  const ratio = ratioOf(req);
  if (req.size) input.image_size = req.size;
  else if (ratio !== null) input.image_size = sizeForRatio(ratio, 2048 * 2048);
  if (req.images.length) input.image_urls = req.images.map(toDataUri);
  if (req.format === 'png' || req.format === 'jpeg') input.output_format = req.format;
  return input;
}

export default {
  id: 'fal',
  label: 'fal.ai (Seedream, Flux, many more)',
  envKeys: ['TINTLOOM_FAL_KEY', 'FAL_KEY'],
  defaultModel: 'seedream',
  models: ['seedream', 'flux-schnell', '<any fal model id>'],
  notes: 'Widest model choice. Pass any fal model id with --model.',
  capabilities: { edit: true, mask: false, transparent: false, multiple: true },

  async generate(req, ctx) {
    if (req.background === 'transparent') {
      throw new UserError('This fal model cannot produce a transparent background.', 'Use --provider openai --model gpt-image-1.5.');
    }
    if (req.mask) throw new UserError('Masks are not supported through fal here.', 'Use --provider openai.');
    const model = resolveModel(req.model || this.defaultModel, req.images.length > 0);
    const headers = { Authorization: `Key ${ctx.key}`, 'Content-Type': 'application/json' };
    const opts = { headers, secrets: [ctx.key] };

    const job = await http(`${(ctx.env.FAL_QUEUE_URL || QUEUE).replace(/\/+$/, '')}/${model}`, { ...opts, method: 'POST', body: JSON.stringify(buildInput(req)), label: 'fal image request' });
    if (!job?.status_url || !job?.response_url) throw new UserError('fal did not accept the request.');
    // Both get the key, so both must be fal's queue host. Checked before either is asked.
    const statusUrl = followed(job.status_url, 'queue', ctx.env);
    const responseUrl = followed(job.response_url, 'queue', ctx.env);

    const deadline = Date.now() + limits.pollMs;
    for (let wait = 1000; ; wait = Math.min(wait * 1.5, 5000)) {
      const status = await http(statusUrl, { ...opts, label: 'fal status check' });
      if (status?.status === 'COMPLETED') {
        if (status.error) throw new UserError(`fal could not generate the image: ${status.error}`);
        break;
      }
      if (Date.now() > deadline) throw new UserError(`fal did not finish within ${Math.round(limits.pollMs / 1000)} seconds.`, 'Try a faster model such as flux-schnell, or a smaller size.');
      await sleep(wait);
    }

    const result = await http(responseUrl, { ...opts, label: 'fal result' });
    const images = (result?.images || (result?.image ? [result.image] : [])).filter((i) => i?.url);
    // The files are fetched without the key, and only from fal's file hosts.
    const urls = images.map((i) => followed(i.url, 'file', ctx.env));
    return Promise.all(urls.map((u) => download(u)));
  },
};
