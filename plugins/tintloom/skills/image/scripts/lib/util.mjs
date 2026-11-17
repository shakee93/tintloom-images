// Shared helpers: errors, HTTP, sizes, files. No dependencies (Node 18+).
import { readFile } from 'node:fs/promises';
import { extname } from 'node:path';

export class UserError extends Error {
  constructor(message, hint) {
    super(message);
    this.hint = hint;
  }
}

const MIME_BY_EXT = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif' };
const EXT_BY_MIME = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' };

export const mimeForPath = (p) => MIME_BY_EXT[extname(p).toLowerCase()] || 'image/png';
export const extForMime = (m) => EXT_BY_MIME[(m || '').split(';')[0].trim()] || 'png';

/** Sniff the real type from magic bytes; providers do not always say. */
export function sniffMime(buf) {
  if (buf.length > 8 && buf[0] === 0x89 && buf[1] === 0x50) return 'image/png';
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8) return 'image/jpeg';
  if (buf.length > 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  if (buf.length > 4 && buf.toString('ascii', 0, 3) === 'GIF') return 'image/gif';
  return null;
}

export async function loadImage(path) {
  let bytes;
  try {
    bytes = await readFile(path);
  } catch {
    throw new UserError(`Input image not found: ${path}`);
  }
  return { path, bytes, mime: sniffMime(bytes) || mimeForPath(path) };
}

export const toDataUri = (img) => `data:${img.mime};base64,${img.bytes.toString('base64')}`;

/** "1536x1024" -> {width, height}. */
export function parseSize(s) {
  const m = /^(\d{2,5})x(\d{2,5})$/i.exec(s || '');
  if (!m) throw new UserError(`Bad --size "${s}". Use WIDTHxHEIGHT, for example 1536x1024.`);
  return { width: +m[1], height: +m[2] };
}

/** "16:9" -> 1.777 */
export function parseAspect(s) {
  const m = /^(\d+(?:\.\d+)?):(\d+(?:\.\d+)?)$/.exec(s || '');
  if (!m || +m[2] === 0) throw new UserError(`Bad --aspect "${s}". Use W:H, for example 16:9.`);
  return +m[1] / +m[2];
}

/** The request's aspect as a number, or null when the caller set neither. */
export function ratioOf(req) {
  if (req.size) return req.size.width / req.size.height;
  if (req.aspect) return parseAspect(req.aspect);
  return null;
}

/** Pick the closest "W:H" label from a provider's allowed list. */
export function nearestAspect(ratio, allowed) {
  let best = allowed[0];
  let bestDiff = Infinity;
  for (const label of allowed) {
    const diff = Math.abs(Math.log(parseAspect(label) / ratio));
    if (diff < bestDiff) [best, bestDiff] = [label, diff];
  }
  return best;
}

/** Width/height for a ratio at roughly `pixels` total, both multiples of `step`. */
export function sizeForRatio(ratio, pixels = 1024 * 1024, step = 16) {
  const h = Math.sqrt(pixels / ratio);
  const snap = (v) => Math.max(step, Math.round(v / step) * step);
  return { width: snap(h * ratio), height: snap(h) };
}

export function redact(text, secrets = []) {
  let out = String(text);
  for (const s of secrets) if (s && s.length > 6) out = out.split(s).join('[redacted]');
  return out;
}

/** Time allowed for one provider request, and for polling a queued job. Hosts with a hard cap lower these. */
export const limits = { requestMs: 300_000, pollMs: 600_000 };

/** fetch + JSON with a timeout and readable provider errors. */
export async function http(url, { method = 'GET', headers = {}, body, timeoutMs = limits.requestMs, secrets = [], label = 'request' } = {}) {
  let res;
  try {
    res = await fetch(url, { method, headers, body, signal: AbortSignal.timeout(timeoutMs) });
  } catch (e) {
    const why = e.name === 'TimeoutError' ? `timed out after ${Math.round(timeoutMs / 1000)}s` : e.cause?.code || e.message;
    // `status` and `timeout` say what happened without reading the words: a host that keeps a failure log classifies on them.
    throw Object.assign(new UserError(`${label} failed: ${redact(why, secrets)}`, 'Check the network connection and try again.'), { timeout: e.name === 'TimeoutError' });
  }
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    /* not JSON */
  }
  if (!res.ok) {
    const detail = json?.error?.message || json?.error || json?.detail || json?.message || text.slice(0, 500);
    const msg = typeof detail === 'string' ? detail : JSON.stringify(detail);
    const hint =
      res.status === 401 || res.status === 403
        ? 'The API key was rejected. Set it again with the `keys set <provider>` command, in your own terminal.'
        : res.status === 429
          ? 'Rate limited or out of credit at the provider.'
          : undefined;
    throw Object.assign(new UserError(`${label} failed (HTTP ${res.status}): ${redact(msg, secrets)}`, hint), { status: res.status });
  }
  return json;
}

export async function download(url, { timeoutMs = 120_000 } = {}) {
  let res;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  } catch (e) {
    throw new UserError(`Could not download the generated image: ${e.cause?.code || e.message}`);
  }
  if (!res.ok) throw new UserError(`Could not download the generated image (HTTP ${res.status}).`);
  const bytes = Buffer.from(await res.arrayBuffer());
  return { bytes, mime: sniffMime(bytes) || res.headers.get('content-type') || 'image/png' };
}

export const fromBase64 = (b64, mime) => {
  const bytes = Buffer.from(b64, 'base64');
  return { bytes, mime: sniffMime(bytes) || mime || 'image/png' };
};

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
