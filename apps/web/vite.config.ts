import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";

// In development the site runs on Vite (port 5173) and forwards API calls to the hub.
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, "../..", "");
  const hub = env.HUB_URL || "http://localhost:4000";
  const proxy = Object.fromEntries(["/api", "/v1", "/paypal", "/mock-paypal", "/.well-known", "/health"].map((p) => [p, hub]));
  return {
    plugins: [react()],
    server: { port: 5173, proxy },
    build: { outDir: "dist", emptyOutDir: true },
  };
});
