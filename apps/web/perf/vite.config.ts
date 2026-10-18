import path from "node:path";
import { fileURLToPath } from "node:url";
import type { IncomingMessage, ServerResponse } from "node:http";
import { defineConfig, type Plugin } from "vite";
import { FIXTURE_ID } from "./fixture";

// Production-mode bundle of the real WbsApp (preview mode, no server) for scale
// measurement. Not a product route; never imported by app code.
const dir = path.dirname(fileURLToPath(import.meta.url));

/** Lets a script tell this server from any other process that holds the port. */
function identity(): Plugin {
  const handler = (request: IncomingMessage, response: ServerResponse, next: () => void): void => {
    if (request.url !== "/__perf-identity") return next();
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ fixture: FIXTURE_ID }));
  };
  return {
    name: "perf-identity",
    configureServer: (server) => void server.middlewares.use(handler),
    configurePreviewServer: (server) => void server.middlewares.use(handler),
  };
}

export default defineConfig({
  root: dir,
  plugins: [identity()],
  resolve: { alias: { "~": path.resolve(dir, "../app") } },
  esbuild: { jsx: "automatic" },
  build: { outDir: path.resolve(dir, "dist"), emptyOutDir: true, sourcemap: true },
});
