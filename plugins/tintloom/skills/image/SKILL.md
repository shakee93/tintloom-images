---
name: image
description: Generate or edit raster images (photos, illustrations, product shots, hero images, textures, sprites, mockups, posters, transparent cutouts) with the user's own image-provider keys - OpenAI gpt-image, Google Gemini "Nano Banana", fal.ai models such as Seedream and Flux, BytePlus ModelArk (Seedream). Use whenever the user asks to create, draw, generate, render or make an image or picture, to edit, restyle, extend or combine existing image files, or to produce visual variants. Not for SVG, icons, charts or diagrams that are better written as code.
---

# Image generation

Make and edit images with the `generate_image` tool from this plugin's `images` server (its full name ends in `__generate_image`). It calls the provider with the user's own key, and saves the file into the project. In apps that support it, the user also gets an image card: clicking the image opens an editor with Select, Comment, Remove BG, Erase, Resize and Variations.

## Workflow

1. **Decide generate or edit.** To change an existing image or combine several, pass them in `images` (by `id` from an earlier result, or by file `path`). With no `images` it creates from text.
2. **Write the prompt** (see below) and call `generate_image`. Leave `provider` and `model` out unless the user named one or the default cannot do the job.
3. **Check the result.** If the result did not include the image itself, open the saved path with the Read tool. Check the subject, the composition, any text in the image, and anything the user said to keep or avoid.
4. **Fix with one targeted edit** when something is off: call again with the image in `images` and say what changes and what stays. Don't start over.
5. **Make sure the user sees it.** The result says whether the app drew the image card. If it did, reply in one short line with the saved path and don't describe the image. If it did not, show the saved file with whatever file-display tool you have, or give its path. Show the prompt only if they ask.

## Editing

Everything the card's editor does, you can do with the tool directly. The card sends a short message as the user ("Change the selected area: make it blue", "Erase the selected area", "Remove the background of this image", "Resize this image to 16:9 (Widescreen)", "Make 3 variations of this image", "Edit this image: …"); act on it without asking again.

When such a message gives no image id, call `generate_image` with `selection: true` in place of `images`, `mask` and `erase`: the card has already told the server which image is open, what the user painted on it and whether it is an erase. Add the rest as in the table (for example `aspect` for a resize, `count: 3` for variations, the transparent-background recipe for Remove BG). Where an app cannot do that, the message carries the id and `edit_regions` itself; then use those.

| What is wanted | How to call `generate_image` |
| --- | --- |
| Change the whole image ("make it night") | `images: [{id}]`, prompt says what changes and what stays |
| Change one part only (the card's **Select**: "changing only the selected area (mask id …)") | `images: [{id}]`, `mask: {id: <mask id>}`, `provider: "openai"`. The request is about what is already inside the area: look at the image, name that object in the prompt ("make the kite red", not "change the color to red") and say to keep its shape and position. Everything outside the mask is kept exactly as it was |
| Remove something (the card's **Erase**) | Same, plus `erase: true`, with a prompt such as "Fill the area in so it matches its surroundings." Keep the image's model and background (a transparent image stays `gpt-image-1.5`, `background: "transparent"`) |
| Change one part, and there is no mask (you are working without the card) | `edit_regions: [{x, y, width, height}]` as fractions of the image from its top-left corner. Read the image first to place the region |
| Point comments (the card's **Comment**: "At 62% from the left, 37% from the top: …") | One edit with every change in the prompt, each tied to where it is ("the sun, right of centre in the upper half"). For a small, local change you may add an `edit_regions` box around the point |
| Remove the background (**Remove BG**) | `images: [{id}]`, `provider: "openai"`, `model: "gpt-image-1.5"`, `background: "transparent"`, `fidelity: "high"` |
| New shape (**Resize**) | `images: [{id}]`, `aspect: "16:9"`, prompt: "Keep the scene and extend it to fit the new shape" |
| Variations | `images: [{id}]`, `count: 3`, prompt asks for variations on the same subject and style |
| Combine images, restyle from a reference | Several entries in `images`; say what each one is for |
| Keep a face, logo or product exact | `fidelity: "high"` with `model: "gpt-image-1.5"`; `gpt-image-2` already keeps inputs at high fidelity |

When the card's message says `edit_regions [...]` in place of a mask id, pass that array as `edit_regions` unchanged.

To split an image into layers ("separate the elements", "give me the pieces as transparent PNGs"), pass `images: [{id}]` (exactly one image) or `selection: true`, with `layers: true`; no mask, `edit_regions` or `count`. `prompt` is optional and may say how to split it. It needs a BytePlus ModelArk key and always runs on Seedream. The result is a base (the picture with the elements taken out) plus transparent PNG layers, each with an id and a name, base first; ModelArk bills every image it returns (usually about 5), and at most 10 are kept. Layer ids can be edited like any image. The CLI form is `tintloom edit --image in.png --layers`.

Masks and regions work with `openai` only. If the user's provider is Gemini, fal or ModelArk, do the edit by describing the area in the prompt instead, and say that it may touch more than the selected part.

## Arguments

| Argument | Meaning |
| --- | --- |
| `prompt` | What to make. For edits: what changes and what stays. Required. |
| `images` | Images to edit or use as references: `{ "id": … }`, `{ "path": … }`, `{ "url": … }` or `{ "data": … }`. |
| `mask` | Limits an edit to part of the first image: `{ "id": … }` from the card, or a PNG `path`, transparent where the change may happen. |
| `edit_regions` | Limits an edit to rectangles, as fractions: `[{ "x": 0, "y": 0, "width": 1, "height": 0.33 }]` is the top third. |
| `fidelity` | `high` keeps faces, logos and fine detail of the inputs (openai `gpt-image-1.5`). |
| `aspect` | Shape, such as `1:1`, `16:9`, `9:16`, `4:5`, `3:2`. Prefer this over `size`. |
| `size` | Exact pixels, such as `1536x1024`, when the user needs them. |
| `quality` | `low` for drafts, `high` for finals. |
| `count` | Variants of this one prompt, 1 to 4. |
| `prompts` | 2 to 4 different prompts in one call, in place of `prompt`; one image each, shown together. |
| `background` | `transparent` for cutouts (see below). |
| `provider`, `model` | From `list_image_providers`. |
| `out` | Where to save: a file path, or a folder ending in `/`. Default `generated-images/`. |

## Keys

If the tool says no key is set, tell the user to add one: run `/plugin`, open **tintloom**, choose **Configure**, paste a key for OpenAI, Gemini, fal or BytePlus ModelArk, then start a new session. Never ask for a key in the chat, and never print one.

## Choosing a provider and model

`list_image_providers` is the source of truth. As a guide:

- **openai** (`gpt-image-2`): the safest general choice. Best at text inside images, layouts and precise edits.
- **gemini** (Nano Banana): strong at keeping a person, product or character consistent across edits, and at blending several reference images.
- **modelark** (`seedream`, `seedream-5-flash`, `seedream-4.5`, or any ModelArk model id): ByteDance's own Seedream; edits and blends up to 10 images, no masks, no transparency.
- **fal** (`seedream`, `flux-schnell`, or any fal model id): widest choice; `flux-schnell` is fast and cheap for drafts.

If a provider refuses an option, say which option and offer the provider that supports it. Don't silently drop something the user asked for, and don't silently switch provider or model.

**Transparent backgrounds:** only `openai` with `model: "gpt-image-1.5"` and `background: "transparent"` gives real transparency. Tell the user this uses the older model before you do it.

## Cost and care

Every image spends the user's money. Make one unless they ask for more, draft at `quality: "low"` when exploring, and ask before any run of more than 4 images.

For several different images in one reply (an apple, a pear and cherries), pass `prompts` with one prompt each, up to 4: they are made side by side and shown as one gallery. `count` is only for variants of one prompt.

## Where files go

- Meant for the project (a hero image, an asset the code references): save straight to its real place with `out`, following the project's existing asset folders and naming.
- Just exploring: leave the default.
- An existing file is never overwritten; a `-v2` name is used. To replace an asset on purpose, save beside it and move it.

## Writing prompts

A specific request needs only tidying into a clear description; don't add creative ideas the user didn't ask for. A vague request ("a logo for my café") deserves a few sensible specifics. Cover what matters, in plain sentences:

- **Subject:** what it is, with the details that make it this one.
- **Setting and composition:** where, framing, camera angle, what is in focus, empty space for text if it's a banner.
- **Style:** photo, 3D render, flat illustration, watercolour; for photos, lens and lighting.
- **Light and colour:** direction and quality of light, palette.
- **Text in the image:** put the exact words in quotes and say where they go and in what kind of lettering. Check the spelling in the result.
- **Avoid:** anything that must not appear.

For edits, say what changes and, just as firmly, what stays: "Change only X. Keep the face, pose, framing, lighting and background exactly as they are." When passing several images, say what each is for: "Image 1 is the product. Image 2 is the style reference."

## When it fails

Relay the tool's error in plain words. A declined prompt usually needs rephrasing; HTTP 401 means the key is wrong; 429 means the user's provider account is rate limited or out of credit.

## Without the tool

If `generate_image` is not available (the server is off, or this app loads skills only), the same engine runs as a script:

```bash
node "${CLAUDE_SKILL_DIR}/scripts/tintloom.mjs" generate --json -p "…" -a 16:9 -o path/to/file.png
```

If `${CLAUDE_SKILL_DIR}` appears unexpanded, use the absolute path of `scripts/tintloom.mjs` in the folder that holds this file.

`edit -i in.png -p "…"` edits; `providers --json` lists providers; `--help` lists every option. It reads keys from `OPENAI_API_KEY`, `GEMINI_API_KEY`, `FAL_KEY` or `ARK_API_KEY`, or from `keys set <provider>`, which the user runs in their own terminal. Give the shell call a timeout of at least 5 minutes, then open the saved file with Read.
