<div align="center">

# Wardrobe

Your clothes, extracted and organized with gpt-image.

[![License: MIT](https://img.shields.io/badge/license-MIT-191919?style=flat-square)](LICENSE)
[![Node 22+](https://img.shields.io/badge/node-22%2B-191919?style=flat-square)](package.json)

[See the original post →](https://x.com/cdngdev/status/2076812846793650485)

</div>

![Wardrobe gallery](docs/screenshots/gallery.png)

![Modeled wardrobe editor](docs/screenshots/editor.png)

## Quick start

```bash
git clone https://github.com/tandpfun/wardrobe.git
cd wardrobe
npm install
cp .env.example .env
npm run dev
```

⚠️ The importer stays disabled until you add `OPENAI_API_KEY` to `.env` and place a PNG reference photo of yourself at `data/model-reference.png`.

Open [localhost:5173](http://localhost:5173).

## Import with Codex

This repo includes two Codex skills: one imports clothes and generates modeled item photos; the other styles complete outfits and generates a modeled lookbook.

```text
$import-clothes Import the clothes from ~/Pictures/outfits, create modeled photos, and add them to this wardrobe.
$generate-outfits Create modeled outfit ideas from my wardrobe.
```

Open the cloned repo in Codex and run either prompt. The import skill asks for a local model-reference PNG when needed, reviews every cutout and modeled photo, then writes to `data/library.json` and `data/imported/`. The outfit skill asks how many looks to create, then curates, generates, verifies, and saves the complete collection under `data/`.

### For agents

If you are setting up Wardrobe for a user, ask how they want to import their clothes:

- **Codex:** Ask for a folder or camera-roll location and a model-reference PNG, then extract, model, and import the individual pieces by following [the bundled import skill](.agents/skills/import-clothes/SKILL.md). Afterward, offer to create a requested number of modeled looks with [the outfit-generation skill](.agents/skills/generate-outfits/SKILL.md).
- **Web UI:** Help the user configure their own `OPENAI_API_KEY` and `data/model-reference.png`, then let them import through the app.

## What it does

- Detects every garment in a photo with the OpenAI Responses API
- Extracts clean product cutouts with the OpenAI Images API
- Generates an optional modeled editorial preview
- Keeps originals, jobs, generated images, and the JSON database local in `data/`
- Supports drag, drop, paste, editing, review, regeneration, and approval

## Configuration

| Variable | Default |
| --- | --- |
| `OPENAI_API_KEY` | Required |
| `OPENAI_VISION_MODEL` | `gpt-5.4-mini` |
| `OPENAI_IMAGE_MODEL` | `gpt-image-2` |
| `OPENAI_IMAGE_QUALITY` | `high` |
| `WARDROBE_MODEL_REFERENCE` | `data/model-reference.png` |
| `WARDROBE_DATA_DIR` | `data` |
| `WARDROBE_HOST` | `127.0.0.1` |

The server listens on loopback only by default. Setting `WARDROBE_HOST=0.0.0.0` exposes the app — including the import API that uses your OpenAI key and your wardrobe photos — to everyone on your network.

## Deploy to Vercel

The repo also runs as a Vercel app: the gallery deploys as a static site, and the import API runs as a serverless function backed by Vercel Blob (`api/import/[...path].mjs`). Images and the wardrobe database live in the Blob store instead of `data/`.

1. Import the repo into Vercel (framework preset: Vite).
2. In the project's **Storage** tab, create and connect a **Blob** store. This provisions `BLOB_READ_WRITE_TOKEN` automatically.
3. In **Settings → Environment Variables**, add `OPENAI_API_KEY` and — strongly recommended — `WARDROBE_PASSWORD`. The password puts the whole deployment behind HTTP Basic Auth; without it, anyone who finds the URL can import photos on your OpenAI bill and browse your wardrobe.
4. Deploy, then upload your model reference photo from your machine:

   ```bash
   vercel env pull .env.local
   npm run upload-reference -- path/to/your-photo.png
   ```

Notes for the hosted mode:

- Garment and modeled images are generated **during** the approve/regenerate request, so those clicks take a minute or two — the buttons stay disabled while it runs.
- `vercel.json` sets `maxDuration: 300`, which requires Fluid Compute (default on new projects). If your plan rejects it, lower the value and consider `OPENAI_IMAGE_QUALITY=medium`.
- Uploads are downscaled in the browser to fit serverless body limits.
- Blob-stored images are served through the API under your password, but the underlying `*.public.blob.vercel-storage.com` URLs are unlisted-public — treat the store like a private photo album shared by link.
- The deployment is single-user: there are no accounts, and concurrent editing from two devices can race.

## License

[MIT](LICENSE)
