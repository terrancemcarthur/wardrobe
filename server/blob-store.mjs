import { del, head, list, put } from "@vercel/blob";

// All wardrobe state lives under one prefix in the Blob store. JSON documents
// are written as immutable versioned blobs (path.v<timestamp>-<rand>.json) so
// reads never hit a stale CDN copy of an overwritten pathname; images are
// written once under unique names and never mutated.
const PREFIX = "wardrobe/";

const full = (pathname) => `${PREFIX}${pathname}`;

// The SDK only looks for BLOB_READ_WRITE_TOKEN. Stores connected with a
// custom environment-variable prefix expose <PREFIX>_READ_WRITE_TOKEN
// instead, so fall back to any read-write token present in the environment.
export function resolveBlobToken() {
  if (process.env.BLOB_READ_WRITE_TOKEN) return process.env.BLOB_READ_WRITE_TOKEN;
  const key = Object.keys(process.env).find((name) => name.endsWith("_READ_WRITE_TOKEN") && process.env[name]);
  return key ? process.env[key] : undefined;
}

// Only pass an explicit token when one actually exists: an explicit token
// (even undefined) can pre-empt the SDK's own resolution, which on newer
// Vercel projects authenticates via short-lived OIDC credentials instead of
// a BLOB_READ_WRITE_TOKEN env var.
function tokenOption() {
  const token = resolveBlobToken();
  return token ? { token } : {};
}

export function isNotFound(error) {
  return error?.name === "BlobNotFoundError" || /not.?found|does not exist/i.test(error?.message || "");
}

async function listAll(prefix) {
  const blobs = [];
  let cursor;
  do {
    const page = await list({ prefix: full(prefix), cursor, limit: 1000, ...tokenOption() });
    blobs.push(...page.blobs);
    cursor = page.cursor;
  } while (cursor);
  return blobs;
}

async function fetchBlob(url) {
  const separator = url.includes("?") ? "&" : "?";
  const response = await fetch(`${url}${separator}v=${Date.now()}`, { cache: "no-store" });
  if (!response.ok) throw new Error(`Blob fetch failed (${response.status})`);
  return Buffer.from(await response.arrayBuffer());
}

export function createBlobStore() {
  return {
    async readJson(pathname) {
      const versions = await listAll(`${pathname}.v`);
      if (!versions.length) return null;
      const latest = versions.sort((a, b) => a.pathname.localeCompare(b.pathname)).at(-1);
      return JSON.parse((await fetchBlob(latest.url)).toString("utf8"));
    },

    async writeJson(pathname, value) {
      const version = `${String(Date.now()).padStart(15, "0")}-${Math.random().toString(36).slice(2, 8)}`;
      const versionedPath = full(`${pathname}.v${version}.json`);
      await put(versionedPath, JSON.stringify(value), {
        access: "public",
        addRandomSuffix: false,
        contentType: "application/json",
        ...tokenOption(),
      });
      const versions = await listAll(`${pathname}.v`);
      const stale = versions.filter((blob) => blob.pathname < versionedPath);
      if (stale.length) await del(stale.map((blob) => blob.url), tokenOption()).catch(() => {});
    },

    async readBytes(pathname) {
      try {
        const meta = await head(full(pathname), tokenOption());
        return await fetchBlob(meta.url);
      } catch (error) {
        if (isNotFound(error)) return null;
        throw error;
      }
    },

    async writeBytes(pathname, bytes, contentType = "image/png") {
      await put(full(pathname), bytes, {
        access: "public",
        addRandomSuffix: false,
        allowOverwrite: true,
        contentType,
        ...tokenOption(),
      });
    },

    async exists(pathname) {
      try {
        await head(full(pathname), tokenOption());
        return true;
      } catch (error) {
        if (isNotFound(error)) return false;
        throw error;
      }
    },

    async deletePrefix(prefix) {
      const blobs = await listAll(prefix);
      if (blobs.length) await del(blobs.map((blob) => blob.url), tokenOption());
    },

    async list(prefix) {
      return (await listAll(prefix)).map((blob) => blob.pathname.slice(PREFIX.length));
    },
  };
}
