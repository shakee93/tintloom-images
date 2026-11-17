// Google Gemini native image models ("Nano Banana"), via the Interactions API.
// Docs: https://ai.google.dev/gemini-api/docs/image-generation
import { UserError, fromBase64, http, nearestAspect, ratioOf } from '../lib/util.mjs';

const ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/interactions';
const API_REVISION = '2026-05-20';
const ASPECTS = ['1:1', '2:3', '3:2', '3:4', '4:3', '4:5', '5:4', '9:16', '16:9', '21:9'];

const ALIASES = {
  'nano-banana': 'gemini-nano-banana-2.1',
  'nano-banana-2': 'gemini-3.1-flash-image',
  'nano-banana-pro': 'gemini-3-pro-image',
};

function imageSize(req) {
  if (!req.size) return null;
  const long = Math.max(req.size.width, req.size.height);
  return long > 3000 ? '4K' : long > 1500 ? '2K' : '1K';
}

/** The image parts of a response, wherever the API version nests them. */
export function collectImages(node, out = []) {
  if (Array.isArray(node)) for (const v of node) collectImages(v, out);
  else if (node && typeof node === 'object') {
    if (node.type === 'image' && typeof node.data === 'string') out.push(fromBase64(node.data, node.mime_type));
    else for (const v of Object.values(node)) collectImages(v, out);
  }
  return out;
}

export function buildBody(req, model) {
  const input = [
    ...req.images.map((img) => ({ type: 'image', mime_type: img.mime, data: img.bytes.toString('base64') })),
    { type: 'text', text: req.prompt },
  ];
  const format = { type: 'image' };
  const ratio = ratioOf(req);
  if (ratio !== null) format.aspect_ratio = nearestAspect(ratio, ASPECTS);
  const size = imageSize(req);
  if (size) format.image_size = size;
  if (req.format === 'jpeg' || req.format === 'jpg') format.mime_type = 'image/jpeg';
  return { model, input, response_format: format };
}

export default {
  id: 'gemini',
  label: 'Google Gemini (Nano Banana)',
  envKeys: ['TINTLOOM_GEMINI_KEY', 'GEMINI_API_KEY', 'GOOGLE_API_KEY'],
  defaultModel: 'gemini-nano-banana-2.1',
  models: ['gemini-nano-banana-2.1', 'gemini-3.1-flash-image', 'gemini-3-pro-image', 'gemini-2.5-flash-image'],
  notes: 'Strong at edits that keep a subject consistent, and at blending several reference images.',
  capabilities: { edit: true, mask: false, transparent: false, multiple: true },

  async generate(req, ctx) {
    if (req.background === 'transparent') {
      throw new UserError('Gemini image models cannot produce a transparent background.', 'Use --provider openai --model gpt-image-1.5.');
    }
    if (req.mask) throw new UserError('Gemini image models do not take a mask.', 'Describe the area to change in the prompt, or use --provider openai.');
    const model = ALIASES[req.model] || req.model || this.defaultModel;
    const body = JSON.stringify(buildBody(req, model));
    const out = [];
    // The API has no image-count parameter, so ask once per image.
    for (let i = 0; i < req.n; i++) {
      const json = await http(ctx.env.GEMINI_BASE_URL ? `${ctx.env.GEMINI_BASE_URL.replace(/\/+$/, '')}/interactions` : ENDPOINT, {
        method: 'POST',
        headers: { 'x-goog-api-key': ctx.key, 'Content-Type': 'application/json', 'Api-Revision': API_REVISION },
        body,
        secrets: [ctx.key],
        label: 'Gemini image request',
      });
      const images = collectImages(json);
      if (!images.length) {
        throw new UserError('Gemini returned no image.', 'The prompt may have been declined. Rephrase it and try again.');
      }
      out.push(images[0]);
    }
    return out;
  },
};
