import { randomUUID } from "node:crypto";
import path from "node:path";
import {
  DECISIONS,
  MODELED_PROMPT,
  STAGES,
  buildGarmentPrompt,
  chooseChromaKey,
  cleanupTolerance,
  cropDetectedItem,
  decodeImage,
  json,
  normalizeImage,
  normalizeMetadata,
  openAIAnalyze,
  openAIEdit,
  processChromaBackground,
  publicJob,
  readJsonBody,
  removeChromaBackground,
  stageState,
} from "./core.mjs";

const ASSET_ROOT = "/api/import/assets";
const LIBRARY_ASSET_ROOT = "/api/import/library";
const UUID_RE = /^[a-f0-9-]{36}$/i;
// A stage can only sit in processing/queued while a request is generating it;
// anything older than this was interrupted (function timeout, crash).
const STALE_PROCESSING_MS = 6 * 60 * 1000;

const setting = (name, fallback = "") => process.env[name] || fallback;
const apiBaseUrl = () => setting("OPENAI_API_BASE_URL", "https://api.openai.com/v1").replace(/\/$/, "");
const assetName = (assetUrl) => path.basename(new URL(assetUrl, "http://localhost").pathname);

// Serverless functions cannot run work after the response is sent, so unlike
// the local dev server every generation here runs inside the request that
// triggers it and the response carries the finished stage.
export function createImportHandler(store) {
  const jobPath = (id) => `jobs/${id}/job.json`;

  async function loadJob(id) {
    if (!UUID_RE.test(id)) return null;
    return store.readJson(jobPath(id));
  }

  async function saveJob(job) {
    job.updatedAt = new Date().toISOString();
    await store.writeJson(jobPath(job.id), job);
  }

  async function listJobIds() {
    const ids = new Set();
    for (const pathname of await store.list("jobs/")) {
      const match = pathname.match(/^jobs\/([a-f0-9-]{36})\/job\.json\.v/i);
      if (match) ids.add(match[1]);
    }
    return [...ids];
  }

  function presentJob(job) {
    const copy = publicJob(job);
    for (const name of ["garment", "modeled"]) {
      const stage = copy.stages[name];
      const updatedAt = Date.parse(stage.updatedAt || 0) || 0;
      if (["processing", "queued"].includes(stage.status) && updatedAt < Date.now() - STALE_PROCESSING_MS) {
        stage.status = "failed";
        stage.error = "Generation was interrupted. Retry to run it again.";
      }
    }
    return copy;
  }

  async function setupStatus() {
    const hasApiKey = Boolean(setting("OPENAI_API_KEY").trim());
    let hasBlobStore = true;
    let hasModelReference = false;
    let blobError = null;
    try {
      hasModelReference = await store.exists("model-reference.png");
    } catch (error) {
      // Without working Blob credentials every store call throws; report it
      // as a setup step (with the SDK's reason) instead of failing the route.
      hasBlobStore = false;
      blobError = error.message;
    }
    const missing = [];
    if (!hasBlobStore) missing.push("connect a Blob store to this project (Vercel dashboard → Storage → Create Blob store) and redeploy");
    if (!hasApiKey) missing.push("set OPENAI_API_KEY in your Vercel project's environment variables and redeploy");
    if (hasBlobStore && !hasModelReference) missing.push("upload a clear photo of yourself as the model reference using the button below");
    return {
      ready: hasApiKey && hasBlobStore && hasModelReference,
      hasApiKey,
      hasBlobStore,
      hasModelReference,
      canUploadReference: true,
      modelReference: "model-reference.png",
      hint: missing.length ? `To enable importing, ${missing.join(", and ")}.` : null,
      // Env var NAMES only (never values), to make storage misconfiguration
      // diagnosable from the browser.
      ...(hasBlobStore ? {} : {
        diagnostics: {
          vercelEnv: process.env.VERCEL_ENV || null,
          hasOidcToken: Boolean(process.env.VERCEL_OIDC_TOKEN),
          blobError,
          blobRelatedEnvVars: Object.keys(process.env).filter((name) => name.includes("BLOB") || name.endsWith("_READ_WRITE_TOKEN")).sort(),
        },
      }),
    };
  }

  async function generateSync(jobId, stageName) {
    const current = await loadJob(jobId);
    if (!current) return null;
    const stage = current.stages[stageName];
    stage.status = "processing"; stage.decision = null; stage.error = null; stage.attempts += 1; stage.updatedAt = new Date().toISOString();
    await saveJob(current);
    let failedAssetUrl = null;
    let chromaKeyUsed = null;
    try {
      const key = setting("OPENAI_API_KEY");
      if (!key) throw new Error("OPENAI_API_KEY is not configured");
      const outputName = `${stageName}-${stage.attempts}-${Date.now()}.png`;
      let bytes;
      if (stageName === "garment") {
        const sourceName = current.internal.cropFile || current.internal.originalFile;
        const source = await store.readBytes(`jobs/${jobId}/${sourceName}`);
        if (!source) throw new Error("The job source image is missing");
        chromaKeyUsed = chooseChromaKey(current.metadata.color);
        const basePrompt = buildGarmentPrompt(current.metadata, chromaKeyUsed);
        bytes = await openAIEdit({
          key,
          baseUrl: apiBaseUrl(),
          model: setting("OPENAI_GARMENT_MODEL", setting("OPENAI_IMAGE_MODEL", "gpt-image-2")),
          quality: setting("OPENAI_IMAGE_QUALITY", "high"),
          size: "1024x1024",
          images: [{ data: source, mime: "image/png", name: sourceName }],
          prompt: stage.prompt ? `${basePrompt}\nUser regeneration direction: ${stage.prompt}` : basePrompt,
        });
        const rawName = `${stageName}-${stage.attempts}-source-${Date.now()}.png`;
        await store.writeBytes(`jobs/${jobId}/${rawName}`, bytes, "image/png");
        failedAssetUrl = `${ASSET_ROOT}/${jobId}/${rawName}`;
        bytes = await removeChromaBackground(bytes, chromaKeyUsed);
      } else {
        const garment = await store.readBytes(`jobs/${jobId}/${assetName(current.stages.garment.assetUrl)}`);
        if (!garment) throw new Error("The garment image is missing");
        const modelData = await store.readBytes("model-reference.png");
        if (!modelData) throw new Error("Model reference not uploaded. Run: npm run upload-reference -- your-photo.png");
        bytes = await openAIEdit({
          key,
          baseUrl: apiBaseUrl(),
          model: setting("OPENAI_MODELED_MODEL", setting("OPENAI_IMAGE_MODEL", "gpt-image-2")),
          quality: setting("OPENAI_IMAGE_QUALITY", "high"),
          size: "1536x1024",
          images: [{ data: modelData, mime: "image/png", name: "model.png" }, { data: garment, mime: "image/png", name: "garment.png" }],
          prompt: stage.prompt ? `${MODELED_PROMPT}\nUser regeneration direction: ${stage.prompt}` : MODELED_PROMPT,
        });
      }
      await store.writeBytes(`jobs/${jobId}/${outputName}`, bytes, "image/png");
      const fresh = await loadJob(jobId);
      if (!fresh) return null;
      const freshStage = fresh.stages[stageName];
      freshStage.status = "review";
      freshStage.assetUrl = `${ASSET_ROOT}/${jobId}/${outputName}`;
      freshStage.failedAssetUrl = null;
      freshStage.cleanupPreviewUrl = null;
      freshStage.cleanupDiagnostics = null;
      if (chromaKeyUsed) freshStage.chromaKey = chromaKeyUsed;
      freshStage.updatedAt = new Date().toISOString();
      await saveJob(fresh);
      return fresh;
    } catch (error) {
      const fresh = await loadJob(jobId);
      if (!fresh) return null;
      const freshStage = fresh.stages[stageName];
      freshStage.status = "failed";
      freshStage.error = error.message;
      freshStage.updatedAt = new Date().toISOString();
      if (failedAssetUrl) freshStage.failedAssetUrl = failedAssetUrl;
      if (chromaKeyUsed) freshStage.chromaKey = chromaKeyUsed;
      await saveJob(fresh);
      return fresh;
    }
  }

  async function persistImported(job, includeModeled = false) {
    const id = `import-${job.id}`;
    const stamp = Date.now();
    const garmentBytes = await store.readBytes(`jobs/${job.id}/${assetName(job.stages.garment.assetUrl)}`);
    if (!garmentBytes) throw new Error("The garment image is missing");
    const garmentName = `${id}-garment-${stamp}.png`;
    await store.writeBytes(`imported/${garmentName}`, garmentBytes, "image/png");
    let modeledImage = null;
    if (includeModeled) {
      const modeledBytes = await store.readBytes(`jobs/${job.id}/${assetName(job.stages.modeled.assetUrl)}`);
      if (!modeledBytes) throw new Error("The modeled image is missing");
      const modeledName = `${id}-modeled-${stamp}.png`;
      await store.writeBytes(`imported/${modeledName}`, modeledBytes, "image/png");
      modeledImage = `${LIBRARY_ASSET_ROOT}/${modeledName}`;
    }
    const metadata = job.metadata || {};
    const records = (await store.readJson("library.json")) || [];
    const existing = records.find((record) => record.id === id);
    const record = {
      id,
      name: metadata.name || "New piece",
      part: metadata.part || "upperbody",
      color: metadata.color || "#d8d0c2",
      secondaryColor: metadata.secondaryColor || null,
      palette: [metadata.color, metadata.secondaryColor].filter(Boolean),
      tags: Array.isArray(metadata.tags) ? metadata.tags : [],
      image: `${LIBRARY_ASSET_ROOT}/${garmentName}`,
      thumbnail: `${LIBRARY_ASSET_ROOT}/${garmentName}`,
      modeledImage: modeledImage || existing?.modeledImage || null,
      importJobId: job.id,
    };
    await store.writeJson("library.json", [...records.filter((item) => item.id !== id), record]);
    return record;
  }

  function sendImage(res, bytes, cacheControl) {
    res.statusCode = 200;
    res.setHeader("Content-Type", "image/png");
    res.setHeader("Cache-Control", cacheControl);
    res.end(bytes);
  }

  return async function handler(req, res) {
    const url = new URL(req.url, "http://localhost");
    try {
      if (url.pathname === "/api/import/wardrobe" && req.method === "GET") {
        return json(res, 200, (await store.readJson("library.json")) || []);
      }
      if (url.pathname === "/api/import/config" && req.method === "GET") {
        return json(res, 200, await setupStatus());
      }
      if (url.pathname === "/api/import/model-reference" && (req.method === "PUT" || req.method === "POST")) {
        const input = await readJsonBody(req);
        const image = decodeImage(input);
        const normalized = await normalizeImage(image.data);
        await store.writeBytes("model-reference.png", normalized, "image/png");
        return json(res, 200, await setupStatus());
      }
      const wardrobeDeleteMatch = url.pathname.match(/^\/api\/import\/wardrobe\/(import-[a-f0-9-]{36})$/i);
      if (wardrobeDeleteMatch && req.method === "DELETE") {
        const id = wardrobeDeleteMatch[1];
        const records = (await store.readJson("library.json")) || [];
        const next = records.filter((record) => record.id !== id);
        if (next.length === records.length) return json(res, 404, { error: "Imported wardrobe item not found" });
        await store.writeJson("library.json", next);
        await store.deletePrefix(`imported/${id}-`).catch(() => {});
        return json(res, 200, { deleted: true, id });
      }
      const libraryAssetMatch = url.pathname.match(/^\/api\/import\/library\/([\w.-]+)$/i);
      if (libraryAssetMatch && req.method === "GET") {
        const bytes = await store.readBytes(`imported/${path.basename(libraryAssetMatch[1])}`);
        if (!bytes) return json(res, 404, { error: "Not found" });
        return sendImage(res, bytes, "public, max-age=31536000, immutable");
      }
      const assetMatch = url.pathname.match(/^\/api\/import\/assets\/([a-f0-9-]{36})\/([\w.-]+)$/i);
      if (assetMatch && req.method === "GET") {
        const bytes = await store.readBytes(`jobs/${assetMatch[1]}/${path.basename(assetMatch[2])}`);
        if (!bytes) return json(res, 404, { error: "Not found" });
        return sendImage(res, bytes, "no-store");
      }
      if (url.pathname === "/api/import/jobs" && req.method === "POST") {
        const setup = await setupStatus();
        if (!setup.ready) return json(res, 503, { error: setup.hint || "Setup required." });
        const input = await readJsonBody(req);
        const image = decodeImage(input);
        const normalizedImage = await normalizeImage(image.data);
        const key = setting("OPENAI_API_KEY");
        const detected = (await openAIAnalyze({ key, baseUrl: apiBaseUrl(), model: setting("OPENAI_VISION_MODEL", "gpt-5.4-mini"), image: normalizedImage, mime: "image/png" })).map(normalizeMetadata);
        const jobs = [];
        for (const metadata of detected) {
          const id = randomUUID();
          const originalFile = "original.png";
          const cropFile = "crop.png";
          const croppedImage = await cropDetectedItem(normalizedImage, metadata.boundingBox);
          await store.writeBytes(`jobs/${id}/${originalFile}`, normalizedImage, "image/png");
          await store.writeBytes(`jobs/${id}/${cropFile}`, croppedImage, "image/png");
          const now = new Date().toISOString();
          const cropStage = { ...stageState(), status: "review", assetUrl: `${ASSET_ROOT}/${id}/${cropFile}`, updatedAt: now };
          const job = { id, status: "active", metadata, stages: { crop: cropStage, garment: stageState(), modeled: stageState() }, createdAt: now, updatedAt: now, internal: { originalFile, cropFile, originalMime: "image/png" } };
          job.originalAssetUrl = `${ASSET_ROOT}/${id}/${originalFile}`;
          await saveJob(job);
          jobs.push(publicJob(job));
        }
        return json(res, 202, { jobs, noClothingDetected: jobs.length === 0 });
      }
      if (url.pathname === "/api/import/jobs" && req.method === "GET") {
        const ids = await listJobIds();
        const loadedJobs = (await Promise.all(ids.map((id) => loadJob(id)))).filter(Boolean);
        const visible = loadedJobs.filter((job) => job.status !== "complete"
          && job.stages.crop?.status !== "rejected"
          && job.stages.garment.status !== "rejected"
          && job.stages.modeled.status !== "rejected");
        return json(res, 200, visible.sort((a, b) => a.createdAt.localeCompare(b.createdAt)).map(presentJob));
      }
      const match = url.pathname.match(/^\/api\/import\/jobs\/([a-f0-9-]{36})(?:\/(.*))?$/i);
      if (!match) return json(res, 404, { error: "Not found" });
      const job = await loadJob(match[1]);
      if (!job) return json(res, 404, { error: "Job not found" });
      const action = match[2] || "";
      if (!action && req.method === "GET") return json(res, 200, presentJob(job));
      if (!action && req.method === "DELETE") {
        await store.deletePrefix(`jobs/${job.id}/`);
        return json(res, 200, { deleted: true, id: job.id });
      }
      if (action === "metadata" && (req.method === "PATCH" || req.method === "PUT")) {
        const input = await readJsonBody(req);
        if (!input.metadata || typeof input.metadata !== "object" || Array.isArray(input.metadata)) throw Object.assign(new Error("metadata must be an object"), { status: 400 });
        job.metadata = normalizeMetadata({ ...job.metadata, ...input.metadata });
        await saveJob(job);
        return json(res, 200, presentJob(job));
      }
      const cleanupAction = action.match(/^stages\/garment\/(cleanup-preview|cleanup-accept)$/);
      if (cleanupAction && req.method === "POST") {
        const stage = job.stages.garment;
        if (stage.status !== "failed" || !stage.failedAssetUrl) {
          throw Object.assign(new Error("No failed garment source is available for cleanup"), { status: 409 });
        }
        const input = await readJsonBody(req);
        const tolerance = cleanupTolerance(input.tolerance);
        const source = await store.readBytes(`jobs/${job.id}/${assetName(stage.failedAssetUrl)}`);
        if (!source) throw new Error("The failed garment source image is missing");
        const key = stage.chromaKey || chooseChromaKey(job.metadata?.color);
        const cleaned = await processChromaBackground(source, key, { tolerance });
        const previewName = `garment-${stage.attempts}-cleanup-${tolerance}-${Date.now()}.png`;
        const previewUrl = `${ASSET_ROOT}/${job.id}/${previewName}`;
        await store.writeBytes(`jobs/${job.id}/${previewName}`, cleaned.bytes, "image/png");
        stage.chromaKey = key;
        stage.cleanupTolerance = cleaned.tolerance;
        stage.cleanupDiagnostics = cleaned.verification;
        stage.cleanupPreviewUrl = previewUrl;
        stage.updatedAt = new Date().toISOString();
        if (cleanupAction[1] === "cleanup-accept") {
          stage.status = "review";
          stage.decision = null;
          stage.error = null;
          stage.assetUrl = previewUrl;
        }
        await saveJob(job);
        return json(res, 200, presentJob(job));
      }
      const stageMatch = action.match(/^stages\/(crop|garment|modeled)\/(approve|reject|regenerate)$/);
      if (stageMatch && req.method === "POST") {
        const [, stageName, decision] = stageMatch;
        if (!STAGES.has(stageName)) throw Object.assign(new Error("Invalid stage"), { status: 400 });
        if (decision === "regenerate") {
          if (stageName === "crop") throw Object.assign(new Error("Upload the image again to create new crops"), { status: 400 });
          const input = await readJsonBody(req);
          job.stages[stageName].prompt = typeof input.prompt === "string" ? input.prompt.trim().slice(0, 1200) || null : null;
          job.stages[stageName].status = "queued";
          job.stages[stageName].decision = null;
          await saveJob(job);
          const updated = await generateSync(job.id, stageName);
          if (!updated) return json(res, 404, { error: "Job not found" });
          return json(res, 200, presentJob(updated));
        }
        if (!DECISIONS.has(decision) || job.stages[stageName].status !== "review") throw Object.assign(new Error("Stage is not ready for review"), { status: 409 });
        const previousStatus = job.stages[stageName].status;
        const previousDecision = job.stages[stageName].decision;
        const previousJobStatus = job.status;
        job.stages[stageName].decision = decision === "approve" ? "approved" : "rejected";
        job.stages[stageName].status = job.stages[stageName].decision;
        job.stages[stageName].error = null;
        job.stages[stageName].updatedAt = new Date().toISOString();
        const startGarment = stageName === "crop" && decision === "approve" && job.stages.garment.status === "pending";
        const startModeled = stageName === "garment" && decision === "approve" && job.stages.modeled.status === "pending";
        if (stageName === "modeled" && decision === "approve") job.status = "complete";
        await saveJob(job);
        if (decision === "reject") {
          const response = presentJob(job);
          await store.deletePrefix(`jobs/${job.id}/`);
          return json(res, 200, response);
        }
        let importedRecord = null;
        if (stageName !== "crop") {
          try {
            importedRecord = await persistImported(job, stageName === "modeled");
          } catch (error) {
            job.stages[stageName].status = previousStatus;
            job.stages[stageName].decision = previousDecision;
            job.status = previousJobStatus;
            await saveJob(job);
            throw error;
          }
        }
        let latest = job;
        if (startGarment) latest = (await generateSync(job.id, "garment")) || job;
        if (startModeled) latest = (await generateSync(job.id, "modeled")) || job;
        const response = presentJob(latest);
        if (importedRecord) response.importedRecord = importedRecord;
        if (latest.status === "complete") await store.deletePrefix(`jobs/${job.id}/`);
        return json(res, 200, response);
      }
      return json(res, 404, { error: "Not found" });
    } catch (error) {
      const statusCode = error.status || 500;
      // This is a single-user app; surfacing the message makes self-hosted
      // debugging possible and leaks nothing another user could exploit.
      return json(res, statusCode, { error: statusCode === 500 ? "Internal server error" : error.message, ...(statusCode === 500 ? { detail: error.message } : {}) });
    }
  };
}
