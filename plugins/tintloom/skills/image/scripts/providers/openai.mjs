// OpenAI Images API, and anything that speaks the same protocol.
// Docs: https://platform.openai.com/docs/api-reference/images
import { basename } from 'node:path';
import { UserError, fromBase64, download, http, ratioOf, sizeForRatio } from '../lib/util.mjs';

const FIXED_SIZES = [
  { width: 1024, height: 1024 },
  { width: 1536, height: 1024 },
  { width: 1024, height: 1536 },
];

/** gpt-image-2 takes flexible sizes; older GPT Image models take three. */
export function openaiSize(req, model) {
  const ratio = ratioOf(req);
  if (ratio === null) return 'auto';
  if (/^gpt-image-2/.test(model)) {
    const s = req.size || sizeForRatio(ratio, 1024 * 1536);
    return `${s.width}x${s.height}`;
  }
  let best = FIXED_SIZES[0];
  for (const s of FIXED_SIZES) {
    if (Math.abs(Math.log(s.width / s.height / ratio)) < Math.abs(Math.log(best.width / best.height / ratio))) best = s;
  }
  return `${best.width}x${best.height}`;
}

export function makeOpenAICompatible({ id, label, envKeys, defaultModel, models, baseUrl, notes }) {
  return {
    id,
    label,
    envKeys,
    defaultModel,
    models,
    notes,
    capabilities: { edit: true, mask: true, transparent: true, multiple: true },

    async generate(req, ctx) {
      const root = (typeof baseUrl === 'function' ? baseUrl(ctx) : baseUrl).replace(/\/+$/, '');
      const model = req.model || defaultModel;
      // Plain gpt-image-2 has no transparent output. Its 2.5 and 2.6 successors (Flare, Sunburst) do.
      if (req.background === 'transparent' && /^gpt-image-2($|-\d{4}-)/.test(model)) {
        throw new UserError(
          'gpt-image-2 cannot produce a transparent background.',
          'Use --model gpt-image-1.5 for true transparency, or generate on a flat solid colour and remove it afterwards.',
        );
      }
      const fields = {
        model,
        prompt: req.prompt,
        n: req.n,
        size: openaiSize(req, model),
        ...(req.quality && { quality: req.quality }),
        ...(req.background && { background: req.background }),
        ...(req.format && { output_format: req.format === 'jpg' ? 'jpeg' : req.format }),
        // gpt-image-2 always keeps inputs at high fidelity and rejects the parameter.
        ...(req.fidelity && req.images.length && !/^gpt-image-2/.test(model) && { input_fidelity: req.fidelity }),
      };
      const auth = { Authorization: `Bearer ${ctx.key}` };
      const common = { method: 'POST', secrets: [ctx.key], label: `${label} image request` };

      let json;
      if (req.images.length) {
        const form = new FormData();
        for (const [k, v] of Object.entries(fields)) form.append(k, String(v));
        const field = req.images.length > 1 ? 'image[]' : 'image';
        for (const img of req.images) form.append(field, new Blob([img.bytes], { type: img.mime }), basename(img.path));
        if (req.mask) form.append('mask', new Blob([req.mask.bytes], { type: req.mask.mime }), basename(req.mask.path));
        json = await http(`${root}/images/edits`, { ...common, headers: auth, body: form });
      } else {
        json = await http(`${root}/images/generations`, {
          ...common,
          headers: { ...auth, 'Content-Type': 'application/json' },
          body: JSON.stringify(fields),
        });
      }

      const out = [];
      for (const item of json?.data || []) {
        if (item.b64_json) out.push(fromBase64(item.b64_json));
        else if (item.url) out.push(await download(item.url));
      }
      return out;
    },
  };
}

export default makeOpenAICompatible({
  id: 'openai',
  label: 'OpenAI',
  envKeys: ['TINTLOOM_OPENAI_KEY', 'OPENAI_API_KEY'],
  defaultModel: 'gpt-image-2',
  models: ['gpt-image-2', 'gpt-image-1.5', 'gpt-image-1-mini'],
  baseUrl: (ctx) => ctx.env.OPENAI_BASE_URL || 'https://api.openai.com/v1',
  notes: 'Best text rendering and edits. Transparent backgrounds need --model gpt-image-1.5.',
});
