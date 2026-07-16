#!/usr/bin/env node

// Uploads your model-reference photo to the Vercel Blob store used by the
// deployed app. Requires BLOB_READ_WRITE_TOKEN (run `vercel env pull
// .env.local`, or copy the token from the Vercel dashboard).

import { readFile } from "node:fs/promises";
import process from "node:process";
import sharp from "sharp";
import { put } from "@vercel/blob";

const file = process.argv[2];
if (!file) {
  console.error("Usage: npm run upload-reference -- <path-to-your-photo>");
  process.exit(1);
}

if (!process.env.BLOB_READ_WRITE_TOKEN) {
  for (const envFile of [".env.local", ".env"]) {
    try {
      const match = (await readFile(envFile, "utf8")).match(/^BLOB_READ_WRITE_TOKEN\s*=\s*"?([^"\s]+)"?\s*$/m);
      if (match) {
        process.env.BLOB_READ_WRITE_TOKEN = match[1];
        break;
      }
    } catch {
      // file missing; keep looking
    }
  }
}

if (!process.env.BLOB_READ_WRITE_TOKEN) {
  console.error("BLOB_READ_WRITE_TOKEN is not set. Run `vercel env pull .env.local` first, or export the token from your Vercel project's Storage settings.");
  process.exit(1);
}

const png = await sharp(await readFile(file)).rotate().toColorspace("srgb").png().toBuffer();
await put("wardrobe/model-reference.png", png, {
  access: "public",
  addRandomSuffix: false,
  allowOverwrite: true,
  contentType: "image/png",
});
console.log("Model reference uploaded. The deployed importer can now generate modeled photos.");
