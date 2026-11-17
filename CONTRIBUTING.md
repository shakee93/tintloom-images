# Contributing

Thanks for helping. The rules are few.

## Ground rules

- **No dependencies.** The plugin runs from a plugin cache where nothing is installed. Use Node 18+ built-ins (`fetch`, `FormData`, `node:util`).
- **Never log a key.** Pass it in `secrets` to `http()` so error text is redacted.
- **Fail with a way forward.** Throw `UserError(message, hint)`; the hint says what to do next.
- **Don't silently drop an option.** If a provider can't do what was asked, throw a `UserError` naming a provider that can.
- Run `npm test` before opening a pull request. Tests use a local stub, so no keys or network are needed.

## Adding a provider

1. Create `plugins/tintloom/skills/image/scripts/providers/<id>.mjs`:

```js
import { UserError, http, fromBase64 } from '../lib/util.mjs';

export default {
  id: 'example',
  label: 'Example AI',
  envKeys: ['EXAMPLE_API_KEY'],          // checked in order
  defaultModel: 'example-image-1',
  models: ['example-image-1'],
  notes: 'One line on what it is good at.',
  capabilities: { edit: false, mask: false, transparent: false, multiple: true },

  // req: { prompt, model, images: [{path, bytes, mime}], mask, size: {width, height} | null,
  //        aspect: "16:9" | null, quality, background, format, fidelity, n }
  // ctx: { key, env, setting(name) }
  // Return [{ bytes: Buffer, mime: 'image/png' }, ...]
  async generate(req, ctx) {
    const json = await http('https://api.example.com/v1/images', {
      method: 'POST',
      headers: { Authorization: `Bearer ${ctx.key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: req.model || this.defaultModel, prompt: req.prompt }),
      secrets: [ctx.key],
      label: 'Example image request',
    });
    return json.images.map((i) => fromBase64(i.b64));
  },
};
```

2. Add it to the list in `providers/index.mjs`. To give it a key field in the plugin's settings, also add its key to `userConfig` and the server `env` in `plugins/tintloom/.claude-plugin/plugin.json`.
3. Add a stub route and a test in `test/tintloom.test.mjs`.
4. Add a row to the provider tables in `README.md` and `skills/image/SKILL.md`.

Helpers in `lib/util.mjs` cover the common work: `ratioOf(req)`, `nearestAspect()`, `sizeForRatio()`, `download(url)`, `toDataUri(image)`.

If the provider speaks the OpenAI Images protocol, use `makeOpenAICompatible()` from `providers/openai.mjs`; `providers/cloud.mjs` is a ten-line example.

## Security

Please report vulnerabilities privately through GitHub's "Report a vulnerability" on the repository's Security tab, not in a public issue.
