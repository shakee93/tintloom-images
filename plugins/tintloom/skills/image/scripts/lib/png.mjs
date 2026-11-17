// Just enough image plumbing to build edit masks without dependencies:
// read an image's pixel size, and write an RGBA PNG.
import { deflateSync, inflateSync } from 'node:zlib';
import { UserError } from './util.mjs';

const CRC = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const body = Buffer.concat([Buffer.from(type), data]);
  const out = Buffer.alloc(body.length + 8);
  out.writeUInt32BE(data.length, 0);
  body.copy(out, 4);
  out.writeUInt32BE(crc32(body), body.length + 4);
  return out;
}

/** Encode 8-bit RGBA pixels (width * height * 4 bytes) as a PNG. */
export function encodePng(width, height, rgba) {
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  const head = Buffer.alloc(13);
  head.writeUInt32BE(width, 0);
  head.writeUInt32BE(height, 4);
  head.set([8, 6, 0, 0, 0], 8);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', head), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

/** Pixel size of a PNG, JPEG or WebP, or null when it cannot be read. */
export function imageSize(buf) {
  if (buf.length > 24 && buf[0] === 0x89 && buf[1] === 0x50) return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  if (buf.length > 4 && buf[0] === 0xff && buf[1] === 0xd8) {
    for (let i = 2; i + 9 < buf.length; ) {
      if (buf[i] !== 0xff) return null;
      const marker = buf[i + 1];
      // Start-of-frame markers carry the size; C4, C8 and CC are other things.
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) return { width: buf.readUInt16BE(i + 7), height: buf.readUInt16BE(i + 5) };
      i += 2 + buf.readUInt16BE(i + 2);
    }
    return null;
  }
  if (buf.length > 30 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') {
    const kind = buf.toString('ascii', 12, 16);
    if (kind === 'VP8X') return { width: 1 + buf.readUIntLE(24, 3), height: 1 + buf.readUIntLE(27, 3) };
    if (kind === 'VP8 ') return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff };
    if (kind === 'VP8L') {
      const bits = buf.readUInt32LE(21);
      return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
    }
  }
  return null;
}

/**
 * A mask for an edit: opaque everywhere except the given regions, which are
 * transparent (the part the model may change). Regions are fractions of the
 * image: { x, y, width, height } with 0,0 at the top left.
 */
export function maskFromRegions(image, regions) {
  const size = imageSize(image);
  if (!size) throw new UserError('Could not read the size of the image to build a mask for it.');
  const { width, height } = size;
  const rgba = Buffer.alloc(width * height * 4);
  for (let i = 3; i < rgba.length; i += 4) rgba[i] = 255;
  const clamp = (v) => Math.min(1, Math.max(0, Number(v) || 0));
  let cleared = 0;
  for (const r of regions) {
    const x0 = Math.floor(clamp(r.x) * width);
    const y0 = Math.floor(clamp(r.y) * height);
    const x1 = Math.ceil(clamp(Number(r.x) + Number(r.width)) * width);
    const y1 = Math.ceil(clamp(Number(r.y) + Number(r.height)) * height);
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) rgba[(y * width + x) * 4 + 3] = 0;
    }
    cleared += Math.max(0, x1 - x0) * Math.max(0, y1 - y0);
  }
  if (!cleared) throw new UserError('edit_regions does not cover any part of the image.', 'Each region is { x, y, width, height } as fractions from 0 to 1.');
  return encodePng(width, height, rgba);
}

/** Decode an 8-bit RGB or RGBA, non-interlaced PNG to RGBA pixels. Returns null for anything else. */
export function decodePng(buf) {
  if (!(buf.length > 33 && buf[0] === 0x89 && buf[1] === 0x50)) return null;
  const width = buf.readUInt32BE(16), height = buf.readUInt32BE(20);
  const [depth, type, , , interlace] = buf.subarray(24, 29);
  // True colour and true colour with alpha at 8 bits, and indexed-colour images at 1, 2, 4 or 8 bits (what ModelArk's base layer is).
  const indexed = type === 3 && [1, 2, 4, 8].includes(depth);
  if (interlace !== 0 || !(indexed || (depth === 8 && (type === 2 || type === 6)))) return null;
  const parts = [];
  let plte = null, trns = null;
  for (let pos = 8; pos + 12 <= buf.length; ) {
    const length = buf.readUInt32BE(pos);
    const name = buf.toString('ascii', pos + 4, pos + 8);
    if (name === 'IDAT') parts.push(buf.subarray(pos + 8, pos + 8 + length));
    if (name === 'PLTE') plte = buf.subarray(pos + 8, pos + 8 + length);
    if (name === 'tRNS') trns = buf.subarray(pos + 8, pos + 8 + length);
    if (name === 'IEND') break;
    pos += 12 + length;
  }
  if (indexed && !plte) return null;
  const raw = inflateSync(Buffer.concat(parts));
  // bpp is the filter's distance back in bytes (at least one); stride is the bytes in a row.
  const bpp = indexed ? 1 : type === 6 ? 4 : 3;
  const stride = indexed ? Math.ceil((width * depth) / 8) : width * bpp;
  if (raw.length < (stride + 1) * height) return null;
  const rgba = Buffer.alloc(width * height * 4);
  let prev = Buffer.alloc(stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const line = Buffer.from(raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1)));
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? line[x - bpp] : 0, b = prev[x], c = x >= bpp ? prev[x - bpp] : 0;
      let add = 0;
      if (filter === 1) add = a;
      else if (filter === 2) add = b;
      else if (filter === 3) add = (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        add = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      line[x] = (line[x] + add) & 255;
    }
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4;
      if (indexed) {
        const bit = x * depth;
        const index = (line[bit >> 3] >> (8 - depth - (bit & 7))) & ((1 << depth) - 1);
        rgba[o] = plte[index * 3];
        rgba[o + 1] = plte[index * 3 + 1];
        rgba[o + 2] = plte[index * 3 + 2];
        rgba[o + 3] = trns && index < trns.length ? trns[index] : 255;
      } else {
        rgba[o] = line[x * bpp];
        rgba[o + 1] = line[x * bpp + 1];
        rgba[o + 2] = line[x * bpp + 2];
        rgba[o + 3] = bpp === 4 ? line[x * bpp + 3] : 255;
      }
    }
    prev = line;
  }
  return { width, height, rgba };
}

/**
 * The image with its metadata removed (EXIF and so GPS, XMP, text, comments, timestamps) and nothing else changed:
 * the pixels are not decoded or re-encoded. PNG and JPEG are cleaned; anything else (WebP) comes back as it is.
 * Colour profiles and the JPEG's own colour-transform marker stay, so the picture looks the same.
 */
export function stripMetadata(buf) {
  if (buf.length > 33 && buf[0] === 0x89 && buf[1] === 0x50) {
    const keep = new Set(['IHDR', 'PLTE', 'IDAT', 'IEND', 'tRNS', 'gAMA', 'cHRM', 'sRGB', 'iCCP', 'sBIT', 'pHYs']);
    const parts = [buf.subarray(0, 8)];
    for (let pos = 8; pos + 12 <= buf.length; ) {
      const length = buf.readUInt32BE(pos);
      const name = buf.toString('ascii', pos + 4, pos + 8);
      const end = pos + 12 + length;
      if (end > buf.length) return buf;
      // A chunk whose first letter is capital is critical to drawing the image; the rest are kept only if listed.
      if (keep.has(name) || (name.charCodeAt(0) & 0x20) === 0) parts.push(buf.subarray(pos, end));
      pos = end;
      if (name === 'IEND') break;
    }
    return Buffer.concat(parts);
  }
  if (buf.length > 4 && buf[0] === 0xff && buf[1] === 0xd8) {
    const parts = [buf.subarray(0, 2)];
    let pos = 2;
    while (pos + 4 <= buf.length) {
      if (buf[pos] !== 0xff) return buf;
      const marker = buf[pos + 1];
      if (marker === 0xff) { pos++; continue; }
      if (marker === 0xda) { parts.push(buf.subarray(pos)); break; } // the picture's data follows: the rest is kept as it is
      if (marker === 0xd9) { parts.push(buf.subarray(pos, pos + 2)); break; }
      const length = buf.readUInt16BE(pos + 2);
      const end = pos + 2 + length;
      if (length < 2 || end > buf.length) return buf;
      const icc = marker === 0xe2 && buf.toString('ascii', pos + 4, pos + 15) === 'ICC_PROFILE';
      // APP1 (EXIF, XMP), APP13 (Photoshop), the other APPn and comments go; JFIF (APP0), ICC and Adobe's APP14 stay.
      const drop = marker === 0xe1 || marker === 0xed || marker === 0xfe || (marker >= 0xe3 && marker <= 0xef && marker !== 0xee) || (marker === 0xe2 && !icc);
      if (!drop) parts.push(buf.subarray(pos, end));
      pos = end;
    }
    return Buffer.concat(parts);
  }
  return buf;
}

/** A smaller PNG of a PNG, its long edge at most `maxEdge`, by averaging blocks of pixels. Null if it cannot be read. */
export function shrinkPng(buf, maxEdge) {
  const image = decodePng(buf);
  if (!image) return null;
  const step = Math.max(1, Math.ceil(Math.max(image.width, image.height) / maxEdge));
  const width = Math.floor(image.width / step), height = Math.floor(image.height / step);
  if (!width || !height) return null;
  const out = Buffer.alloc(width * height * 4);
  const area = step * step;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      // Colours are weighted by alpha, so a transparent pixel's hidden colour does not darken the edge of what is drawn.
      let r = 0, g = 0, b = 0, a = 0;
      for (let dy = 0; dy < step; dy++) {
        let i = ((y * step + dy) * image.width + x * step) * 4;
        for (let dx = 0; dx < step; dx++, i += 4) {
          const alpha = image.rgba[i + 3];
          r += image.rgba[i] * alpha;
          g += image.rgba[i + 1] * alpha;
          b += image.rgba[i + 2] * alpha;
          a += alpha;
        }
      }
      const o = (y * width + x) * 4;
      out[o] = a ? r / a : 0;
      out[o + 1] = a ? g / a : 0;
      out[o + 2] = a ? b / a : 0;
      out[o + 3] = a / area;
    }
  }
  return encodePng(width, height, out);
}

/** The image with everything under the mask's transparent area cleared, so a model cannot see what is being removed. Null if either cannot be read. */
export function clearUnderMask(imageBuf, maskBuf) {
  const image = decodePng(imageBuf), mask = decodePng(maskBuf);
  if (!image || !mask || image.width !== mask.width || image.height !== mask.height) return null;
  for (let i = 3; i < mask.rgba.length; i += 4) {
    if (mask.rgba[i] < 128) image.rgba[i] = image.rgba[i - 1] = image.rgba[i - 2] = image.rgba[i - 3] = 0;
  }
  return encodePng(image.width, image.height, image.rgba);
}

/**
 * A strict masked edit: the result's pixels inside the mask's transparent area,
 * the original's everywhere else, blended over a soft edge. Providers treat a
 * mask as a hint and redraw the rest; this puts the rest back. Null if the
 * three cannot be read or differ in size.
 */
export function keepOutsideMask(originalBuf, resultBuf, maskBuf, feather = 6) {
  const original = decodePng(originalBuf), result = decodePng(resultBuf), mask = decodePng(maskBuf);
  if (!original || !result || !mask) return null;
  const { width, height } = original;
  if (result.width !== width || result.height !== height || mask.width !== width || mask.height !== height) return null;
  // Weight of the result at each pixel: 1 inside the editable area, fading to 0 outside it.
  let weight = new Float32Array(width * height);
  for (let i = 0; i < weight.length; i++) weight[i] = 1 - mask.rgba[i * 4 + 3] / 255;
  const blur = (src, horizontal) => {
    const out = new Float32Array(src.length);
    const [lines, length, step, stride] = horizontal ? [height, width, 1, width] : [width, height, width, 1];
    for (let l = 0; l < lines; l++) {
      const base = l * stride;
      let sum = 0;
      for (let k = -feather; k <= feather; k++) sum += src[base + Math.min(length - 1, Math.max(0, k)) * step];
      for (let p = 0; p < length; p++) {
        out[base + p * step] = sum / (2 * feather + 1);
        sum += src[base + Math.min(length - 1, p + feather + 1) * step] - src[base + Math.max(0, p - feather) * step];
      }
    }
    return out;
  };
  if (feather > 0) weight = blur(blur(weight, true), false);
  const out = Buffer.alloc(width * height * 4);
  for (let i = 0; i < weight.length; i++) {
    const w = weight[i], o = i * 4;
    if (w <= 0.001) original.rgba.copy(out, o, o, o + 4);
    else if (w >= 0.999) result.rgba.copy(out, o, o, o + 4);
    else {
      // Blend with alpha taken into account, so a transparent side does not darken the edge.
      const a0 = original.rgba[o + 3] * (1 - w), a1 = result.rgba[o + 3] * w, a = a0 + a1;
      for (let c = 0; c < 3; c++) out[o + c] = a ? (original.rgba[o + c] * a0 + result.rgba[o + c] * a1) / a : 0;
      out[o + 3] = a;
    }
  }
  return encodePng(width, height, out);
}

/** A mask stretched to another pixel size (nearest pixel, so its edge stays hard). Null if it cannot be read. */
export function resizeMask(maskBuf, width, height) {
  const mask = decodePng(maskBuf);
  if (!mask || !width || !height) return null;
  const out = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) {
    const sy = Math.min(mask.height - 1, Math.floor(((y + 0.5) * mask.height) / height));
    for (let x = 0; x < width; x++) {
      const sx = Math.min(mask.width - 1, Math.floor(((x + 0.5) * mask.width) / width));
      mask.rgba.copy(out, (y * width + x) * 4, (sy * mask.width + sx) * 4, (sy * mask.width + sx) * 4 + 4);
    }
  }
  return encodePng(width, height, out);
}

/** Only the part of the image under the mask's transparent area, in place, the rest black: a guide that shows a model where an edit applies. Null if either cannot be read. */
export function onlyUnderMask(imageBuf, maskBuf) {
  const image = decodePng(imageBuf), mask = decodePng(maskBuf);
  if (!image || !mask || image.width !== mask.width || image.height !== mask.height) return null;
  for (let i = 0; i < mask.rgba.length; i += 4) {
    if (mask.rgba[i + 3] >= 128) {
      image.rgba[i] = image.rgba[i + 1] = image.rgba[i + 2] = 0;
      image.rgba[i + 3] = 255;
    }
  }
  return encodePng(image.width, image.height, image.rgba);
}
