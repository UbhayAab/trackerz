import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";

const root = process.cwd();
const port = Number(process.env.PORT || 4173);
const host = "127.0.0.1";

const types = {
  ".html": "text/html",
  ".css": "text/css",
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".json": "application/json",
  ".md": "text/plain",
  ".toml": "text/plain",
};

createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://${host}:${port}`);
  const relative = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
  const normalized = normalize(relative);

  if (normalized.startsWith("..")) {
    res.writeHead(403);
    res.end("forbidden");
    return;
  }

  try {
    const file = join(root, normalized);
    const body = await readFile(file);
    res.writeHead(200, { "content-type": types[extname(file)] || "application/octet-stream" });
    res.end(body);
  } catch {
    res.writeHead(404);
    res.end("not found");
  }
}).listen(port, host, () => {
  console.log(`Serving http://${host}:${port}`);
});
