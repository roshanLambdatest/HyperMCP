// Copies the shared MCP core (src/ + knowledge/) into the extension so the .vsix is self-contained.
const fs = require("fs");
const path = require("path");
const root = path.join(__dirname, "..", "..");
const ext = path.join(__dirname, "..");
for (const [from, to] of [["src", "core"], ["knowledge", "knowledge"]]) {
  fs.rmSync(path.join(ext, to), { recursive: true, force: true });
  fs.cpSync(path.join(root, from), path.join(ext, to), { recursive: true });
}
// core/*.js are ES modules
fs.writeFileSync(path.join(ext, "core", "package.json"), JSON.stringify({ type: "module" }, null, 2));
console.log("synced src -> core, knowledge -> knowledge");
