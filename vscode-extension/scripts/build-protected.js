// Builds the .vsix that gets shared with the team: no readable source inside.
//   - src/, the knowledge base and every dependency are bundled into three files (extension.js, core.mjs, mcp.mjs)
//   - the knowledge base is embedded as data, not shipped as .md/.yaml files
//   - bundles and the webview script are minified and obfuscated; the stylesheet is minified
//   - no node_modules, core/, knowledge/, tests or scripts in the package
// Bundled + obfuscated code is hard to read, not impossible: VS Code still has to run it.
//
//   npm run package        → hyperexecute-yaml-studio.vsix (protected)
//   npm run package:dev    → the old readable package, for debugging

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const esbuild = require("esbuild");
const Obfuscator = require("javascript-obfuscator");

const ext = path.join(__dirname, "..");
const root = path.join(ext, "..");
const work = path.join(ext, ".build");
const pkgDir = path.join(work, "pkg");
const out = path.join(ext, "hyperexecute-yaml-studio.vsix");

fs.rmSync(work, { recursive: true, force: true });
fs.mkdirSync(path.join(pkgDir, "media"), { recursive: true });

// 1. fresh copy of the shared core
execFileSync(process.execPath, [path.join(__dirname, "sync-core.js")], { stdio: "inherit" });

// 2. knowledge base as data
const kbRoot = path.join(root, "knowledge");
const kb = [];
(function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else if (/\.(md|ya?ml|txt)$/.test(e.name)) kb.push({ path: path.relative(kbRoot, p).split(path.sep).join("/"), text: fs.readFileSync(p, "utf8") });
  }
})(kbRoot);
const core = (f) => JSON.stringify(path.join(ext, "core", f));
fs.writeFileSync(path.join(work, "kb-data.mjs"), `globalThis.__HE_KB_FILES__ = ${JSON.stringify(kb)};\n`);
const coreFiles = fs.readdirSync(path.join(ext, "core")).filter((f) => f.endsWith(".js") && f !== "index.js");
fs.writeFileSync(
  path.join(work, "core-entry.mjs"),
  `import "./kb-data.mjs";\n${coreFiles.map((f) => `export * from ${core(f)};`).join("\n")}\nexport { default as YAML } from "yaml";\n`
);
fs.writeFileSync(path.join(work, "mcp-entry.mjs"), `import "./kb-data.mjs";\nimport ${core("index.js")};\n`);

// 3. bundle + minify
const common = { bundle: true, platform: "node", target: "node18", minify: true, legalComments: "none", logLevel: "warning", nodePaths: [path.join(ext, "node_modules")] };
// ESM bundles still need require() for CommonJS dependencies
const esmBanner = { js: 'import { createRequire as __cr } from "module"; const require = __cr(import.meta.url);' };
esbuild.buildSync({ ...common, entryPoints: [path.join(work, "core-entry.mjs")], format: "esm", outfile: path.join(work, "core.mjs"), banner: esmBanner });
esbuild.buildSync({ ...common, entryPoints: [path.join(work, "mcp-entry.mjs")], format: "esm", outfile: path.join(work, "mcp.mjs"), banner: esmBanner });
esbuild.buildSync({ ...common, entryPoints: [path.join(ext, "extension.js")], format: "cjs", outfile: path.join(work, "extension.js"), external: ["vscode"] });
esbuild.buildSync({ entryPoints: [path.join(ext, "media", "studio.css")], minify: true, outfile: path.join(pkgDir, "media", "studio.css"), logLevel: "warning" });

// 4. obfuscate (names, strings and structure); settings chosen to keep runtime speed
const obfuscate = (src, dest, target, sourceType) => {
  const code = fs.readFileSync(src, "utf8");
  const r = Obfuscator.obfuscate(code, {
    target,
    sourceType,
    compact: true,
    identifierNamesGenerator: "hexadecimal",
    renameGlobals: false,
    stringArray: true,
    stringArrayEncoding: ["base64"],
    stringArrayThreshold: 0.75,
    stringArrayRotate: true,
    stringArrayShuffle: true,
    splitStrings: false,
    controlFlowFlattening: false,
    deadCodeInjection: false,
    selfDefending: false,
    transformObjectKeys: false,
    unicodeEscapeSequence: false,
  });
  fs.writeFileSync(dest, r.getObfuscatedCode());
};
obfuscate(path.join(work, "extension.js"), path.join(pkgDir, "extension.js"), "node", "script");
obfuscate(path.join(work, "core.mjs"), path.join(pkgDir, "core.mjs"), "node", "module");
obfuscate(path.join(work, "mcp.mjs"), path.join(pkgDir, "mcp.mjs"), "node", "module");
obfuscate(path.join(ext, "media", "studio.js"), path.join(pkgDir, "media", "studio.js"), "browser", "script");

// 5. manifest + user-facing files only
const manifest = JSON.parse(fs.readFileSync(path.join(ext, "package.json"), "utf8"));
delete manifest.scripts;
delete manifest.dependencies;
delete manifest.devDependencies;
fs.writeFileSync(path.join(pkgDir, "package.json"), JSON.stringify(manifest, null, 2));
fs.copyFileSync(path.join(ext, "README.md"), path.join(pkgDir, "README.md"));
fs.copyFileSync(path.join(ext, "media", "icon.svg"), path.join(pkgDir, "media", "icon.svg"));
fs.writeFileSync(path.join(pkgDir, ".vscodeignore"), "");

// 6. package
execFileSync("npx", ["--yes", "@vscode/vsce", "package", "--no-dependencies", "--skip-license", "-o", out], { cwd: pkgDir, stdio: "inherit" });
console.log(`Protected package: ${out}`);
