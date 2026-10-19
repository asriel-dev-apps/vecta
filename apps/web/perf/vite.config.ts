import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { IncomingMessage, ServerResponse } from "node:http";
import { defineConfig, type Plugin } from "vite";
import { FIXTURE_ID } from "./fixture";

// Production-mode bundle of the real WbsApp (preview mode, no server) for scale
// measurement. Not a product route; never imported by app code.
const dir = path.dirname(fileURLToPath(import.meta.url));

/** Hash of index.html and assets/ of the built dist (path + bytes): a dirty build differs from its commit's build. */
function distHash(outDir: string): string {
  const hash = createHash("sha256");
  const walk = (current: string): void => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else hash.update(path.relative(outDir, full)).update(fs.readFileSync(full));
    }
  };
  walk(path.join(outDir, "assets"));
  hash.update(fs.readFileSync(path.join(outDir, "index.html")));
  return hash.digest("hex");
}

/** Lets a script tell this server from any other process that holds the port, and which build it serves. */
function identity(): Plugin {
  const handler = (request: IncomingMessage, response: ServerResponse, next: () => void): void => {
    if (request.url !== "/__perf-identity") return next();
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ fixture: FIXTURE_ID, build: distHash(outDir) }));
  };
  return {
    name: "perf-identity",
    configureServer: (server) => void server.middlewares.use(handler),
    configurePreviewServer: (server) => void server.middlewares.use(handler),
  };
}

const outDir = path.resolve(dir, "dist");

export default defineConfig({
  root: dir,
  plugins: [identity()],
  resolve: { alias: { "~": path.resolve(dir, "../app") } },
  esbuild: { jsx: "automatic" },
  build: { outDir, emptyOutDir: true, sourcemap: true },
});
