# Installing Tintloom as an MCP server (for AI agents)

Tintloom is a local MCP server that generates and edits images. It uses the user's own key for one image provider. Follow these steps in order.

## Requirements

- Node.js 18 or newer (`node --version`).
- git.
- One provider key from the user: OpenAI, Google Gemini, fal.ai or BytePlus ModelArk. The user must supply it. Do not invent, guess or reuse a key. If the user has not given you one, ask for it and stop until they do.

The server has no npm dependencies, so there is no install step.

## 1. Clone the repository

Pick a folder that will stay in place, for example `~/mcp-servers`.

```bash
git clone https://github.com/shakee93/tintloom-images.git ~/mcp-servers/tintloom-images
```

The server file is `plugins/tintloom/server/tintloom-mcp.mjs` inside the clone. Use its absolute path in the next step (for example `/Users/you/mcp-servers/tintloom-images/plugins/tintloom/server/tintloom-mcp.mjs`). Do not use `~` in the config.

## 2. Add the MCP server config

Add this to the MCP settings, replacing the path and the key:

```json
{
  "mcpServers": {
    "tintloom": {
      "command": "node",
      "args": ["/absolute/path/to/tintloom-images/plugins/tintloom/server/tintloom-mcp.mjs"],
      "env": { "OPENAI_API_KEY": "the key the user gave you" }
    }
  }
}
```

Set exactly one key in `env`, matching the provider the user has:

| Provider | Variable |
| --- | --- |
| OpenAI | `OPENAI_API_KEY` |
| Google Gemini | `GEMINI_API_KEY` |
| fal.ai | `FAL_KEY` |
| BytePlus ModelArk | `ARK_API_KEY` |

Notes:

- OpenAI is the one to use for masked edits (changing one area of an image).
- The server talks over stdio. No port or URL is needed.
- The key is sent only to the provider it belongs to.

## 3. Check that it works

Restart or reload the MCP servers, then list the tools. These should appear:

- `generate_image`
- `list_image_providers`

Call `list_image_providers`. It lists the providers with an `available` flag. The provider the user configured should show `"available": true`.

If the server does not start, run `node --version` and confirm it is 18 or newer, and confirm the path in `args` is absolute and points to an existing file. The server also starts and lists its tools with no key set; a missing key only shows up when an image is requested.

## 4. First use

Ask for one image, for example "a simple blue square icon, saved to the project". Each image costs the user money with their provider, so make one image unless asked for more. The saved file path is returned.
