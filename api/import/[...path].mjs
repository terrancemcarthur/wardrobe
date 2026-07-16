import { createImportHandler } from "../../server/import-router.mjs";
import { createBlobStore } from "../../server/blob-store.mjs";

let handler;

export default async function (req, res) {
  handler ??= createImportHandler(createBlobStore());
  return handler(req, res);
}
