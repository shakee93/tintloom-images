// What the ModelArk stand-in answers in the tests.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');

/**
 * What ModelArk answers to a layer_decomposition request, held to the constraints the real API was seen to enforce
 * (live call, 17 November 2026): exactly one input image (a string or a list of one), `size` a tier, and no `background`.
 * Returns [status, body]. The base is z_index 0, layers follow from 1, and the answer comes back in REVERSE order so a
 * caller that does not sort by z_index is caught. Layer i has a box i*10 wide and 10 tall, so a bigger i is a bigger layer.
 * A prompt with `LAYERS12` (or any `LAYERS<n>`) returns n images in all; the default is 4. `URLS` answers with addresses.
 */
export function modelarkLayers(body, { url = null } = {}) {
  const fail = (message) => [400, { error: { code: 'InvalidParameter', message } }];
  const images = [].concat(body.image ?? []);
  if (images.length !== 1) return fail(`layer_decomposition takes exactly one image, got ${images.length}`);
  if (!/^data:image\/(png|jpeg);base64,/.test(images[0]) && !/^https:/.test(images[0])) return fail('image must be png or jpeg');
  if (!['1K', '1.5K', '2K', 'auto'].includes(body.size)) return fail(`size ${body.size} is not allowed with layer_decomposition`);
  if ('background' in body) return fail('background is not supported with layer_decomposition');
  const count = Number(/LAYERS(\d+)/.exec(body.prompt || '')?.[1]) || 4;
  const png = PNG.toString('base64');
  const item = (z) => ({
    ...(url ? { url } : { b64_json: png }),
    size: '2048x2048', output_format: z === 0 ? body.output_format || 'jpeg' : 'png', z_index: z,
    ...(z > 0 && { name: `Layer ${z} name`, description: `Element number ${z}`, bounding_box: { absolute: [0, 0, z * 10, 10], normalized: [0, 0, z, 10] } }),
  });
  const data = Array.from({ length: count }, (_, z) => item(z)).reverse();
  return [200, { model: body.model, created: 1, data, usage: { input_images: 1, generated_images: count } }];
}
