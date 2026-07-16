import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import { wardrobeImportApi } from "./scripts/import-job-api.mjs";
import { responsiveImageApi } from "./scripts/responsive-image-api.mjs";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  // The import API spends your OpenAI key and serves personal photos, so the
  // server stays loopback-only unless WARDROBE_HOST opts into wider exposure.
  const host = env.WARDROBE_HOST || "127.0.0.1";
  return {
    optimizeDeps: {
      include: ["react", "react-dom/client"],
    },
    server: {
      host,
      allowedHosts: ["terminal.local"],
      warmup: {
        clientFiles: ["./src/main.jsx"],
      },
    },
    preview: {
      host,
      port: 4173,
      allowedHosts: ["localhost"],
    },
    plugins: [react(), responsiveImageApi(), wardrobeImportApi({ env })],
  };
});
