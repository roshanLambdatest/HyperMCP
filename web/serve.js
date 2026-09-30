// Local preview of web/dist: node serve.js [port]  → http://localhost:4321
const http = require("http");
const fs = require("fs");
const path = require("path");
const root = path.join(__dirname, "dist");
const port = Number(process.argv[2]) || 4321;
const types = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".map": "application/json" };
http.createServer((req, res) => {
  const rel = decodeURIComponent(new URL(req.url, "http://x").pathname);
  const file = path.join(root, rel === "/" ? "index.html" : rel);
  if (!file.startsWith(root) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); return res.end("Not found"); }
  res.writeHead(200, { "Content-Type": types[path.extname(file)] || "application/octet-stream", "Cache-Control": "no-cache" });
  fs.createReadStream(file).pipe(res);
}).listen(port, "127.0.0.1", () => console.log(`HyperExecute Studio (web) at http://localhost:${port}`));
