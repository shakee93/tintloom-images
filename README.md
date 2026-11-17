# Tintloom

Image generation and editing for Claude Code, with your own provider keys.

Claude has no image model of its own. This plugin gives it one. Ask for an image and Claude makes it with OpenAI, Google Gemini, fal.ai or BytePlus ModelArk, using a key you supply. You pay the provider per image and nothing else. The saved file lands in your project.

It is free and MIT licensed. It is independent: not made or endorsed by Anthropic.

## Install

```bash
claude plugin marketplace add shakee93/tintloom-images
```

```bash
claude plugin install tintloom@tintloom
```

Add a key: run `/plugin`, open **tintloom**, choose **Configure**, and paste a key for OpenAI, Gemini, fal or BytePlus ModelArk. Start a new session, then ask: "generate a hero image for this page".

The plugin needs Node 18 or newer and has no dependencies.

Setting it up with an AI agent: see [llms-install.md](llms-install.md).

## Examples

<p>
  <img src="docs/examples/cat-selfie.jpg" width="200" alt="A ginger cat taking a selfie">
  <img src="docs/examples/cat-selfie-shades.jpg" width="200" alt="The same photo with the cat wearing pixel sunglasses">
  <img src="docs/examples/sticker-axolotl.png" width="200" alt="A sticker of an axolotl holding a mug, on a transparent background">
</p>

- Left: a photo of a cat taking a selfie.
- Middle: the same photo after painting over the face and asking for "Give it sunglasses". Only the painted area changes.
- Right: a sticker with a transparent background.

## What you can ask for

- A new image: "a hero image for this landing page, 16:9, left side clear for the headline".
- An edit of a file: "make `fox.png` night, keep the fox and the framing".
- One part only: "make the kite red" with a mask or a region; everything outside is kept.
- A transparent background, a new shape, variations, or several different images at once.

In Claude Code you get the saved file and its path. In apps that show MCP Apps cards, the image also appears in a card with an editor.

## Providers

| Provider | Default model | Good for |
| --- | --- | --- |
| `openai` | `gpt-image-2` | Text in images, layouts, precise and masked edits. For transparency use `gpt-image-1.5` or a GPT Image 2.5 or 2.6 model; plain `gpt-image-2` has none. |
| `gemini` | `gemini-nano-banana-2.1` | Consistent subjects across edits, blending references. |
| `fal` | `seedream` | Widest model choice; any fal model id works. |
| `modelark` | `seedream` | ByteDance's own Seedream (5.5); edits with up to 10 input images. |
| `cloud` | `auto` | Any OpenAI-compatible endpoint of your own. |

Masked and region edits need `openai`. Splitting one image into a base plus transparent layers (`layers: true`, or `--layers` on the CLI) needs `modelark`; every image it returns is billed by ModelArk (usually about 5), and at most 10 are kept. Adding a provider is one file: see [CONTRIBUTING.md](CONTRIBUTING.md).

## How keys are handled

Keys are looked up in this order:

1. The plugin's settings (`/plugin` > tintloom > Configure). The fields are marked sensitive, so Claude Code stores them in the system keychain.
2. Environment variables: `OPENAI_API_KEY`, `GEMINI_API_KEY`, `FAL_KEY`, `ARK_API_KEY`.
3. `tintloom keys set <provider>`, saved to `~/.config/tintloom/config.json`, readable only by you.

A key is never typed into a chat, printed, or written inside the plugin folder. Error text from provider calls is redacted so keys do not appear in it. The plugin sends your key only to the provider you chose.

## Without Claude

The engine is also a plain command:

```bash
node plugins/tintloom/skills/image/scripts/tintloom.mjs generate -p "A red fox in snow, golden hour" -a 16:9 -o fox.png
```

```bash
node plugins/tintloom/skills/image/scripts/tintloom.mjs edit -i fox.png -p "Make it night. Keep the fox and framing." -o fox-night.png
```

## Other ways to run it

Claude Desktop, one machine, your keys: add to `claude_desktop_config.json`

```json
{
  "mcpServers": {
    "tintloom": {
      "command": "node",
      "args": ["/absolute/path/to/tintloom/plugins/tintloom/server/tintloom-mcp.mjs"],
      "env": { "OPENAI_API_KEY": "sk-..." }
    }
  }
}
```

A server with one set of keys: `docker build -t tintloom .` and run it with `OPENAI_API_KEY`, `TINTLOOM_SERVER_TOKEN` (a long random string) and `TINTLOOM_PUBLIC_URL`. The connector URL is `https://your-host/mcp/<token>`.

## No keys? The hosted version

If you would rather not create provider accounts or handle keys, [tintloom.com](https://tintloom.com) runs the same engine as a paid connector for Claude on the web, desktop and phone, with a few free credits to start. If you are comfortable with API keys, this plugin is the better deal.

## How it is built

```
.claude-plugin/marketplace.json     lets Claude Code install the plugin from this repository
plugins/tintloom/
  .claude-plugin/plugin.json        manifest: bundled server and key settings
  skills/image/SKILL.md             teaches Claude when and how to make and edit images
  skills/image/scripts/             command-line engine, providers/*.mjs (one file per provider), lib/
  server/core.mjs                   MCP protocol and tools
  server/tintloom-mcp.mjs           local server: stdio and HTTP
  server/ui/image-card.html         the image card and editor (MCP Apps)
test/                               end-to-end tests against a local provider stub; no keys needed
```

Masked edits are strict. Providers redraw the whole picture, so the server puts back every pixel outside the selected area. This needs the image as a PNG, which is what the server saves.

To see what an app sends the plugin, create `~/.config/tintloom/debug.log`. The server appends each request to it (never keys or image data). Delete the file to stop.

## Development and tests

```bash
npm test
```

Runs `node --test test/*.test.mjs` against a local provider stub. No keys or network needed.

```bash
npm run preview
```

Opens the image card in a stand-in chat at http://localhost:8790 with a fake provider, so you can work on the card without a key.

Other scripts: `npm run serve` (local server over HTTP), `npm run validate` (needs the `claude` CLI).

## Security

- Provider keys are never logged. HTTP errors redact them before they reach you or Claude.
- The plugin stores keys in the system keychain (plugin settings) or in a file only you can read. It does not write keys into the plugin folder.
- The debug log is off unless you create the file, and it never contains keys or image data.
- Report a vulnerability privately with "Report a vulnerability" on this repository's Security tab, not in a public issue.

## Licence

MIT. See [LICENSE](LICENSE).
