// In-memory filesystem for the browser build. The customer's repo is loaded into it from the folder or zip
// they pick; the shared core (analyzer, generator, validator…) reads it through the same fs calls it uses in Node.
// Nothing here touches the network or the real disk.

const files = new Map(); // abs path → { data: string, size, mtimeMs }
const dirs = new Map(); // abs path → Set(child names)

const norm = (p) => {
  const parts = [];
  for (const s of String(p).split("/")) {
    if (!s || s === ".") continue;
    if (s === "..") parts.pop();
    else parts.push(s);
  }
  return "/" + parts.join("/");
};
const parent = (p) => (p === "/" ? null : p.slice(0, p.lastIndexOf("/")) || "/");
const base = (p) => p.slice(p.lastIndexOf("/") + 1);

function ensureDir(p) {
  p = norm(p);
  if (dirs.has(p)) return;
  dirs.set(p, new Set());
  const up = parent(p);
  if (up) {
    ensureDir(up);
    dirs.get(up).add(base(p));
  }
}
ensureDir("/");

const enoent = (op, p) => Object.assign(new Error(`ENOENT: no such file or directory, ${op} '${p}'`), { code: "ENOENT" });

// ---------- loading (used by the app, not by the core) ----------

export function vfsReset() {
  files.clear();
  dirs.clear();
  ensureDir("/");
}

// size is the real size (so the analyzer's size limits behave); data is "" for files we didn't read (binary / too big)
export function vfsAdd(path, data, size = data.length, mtimeMs = 0) {
  path = norm(path);
  ensureDir(parent(path));
  dirs.get(parent(path)).add(base(path));
  files.set(path, { data, size, mtimeMs });
}

export const vfsFiles = () => [...files.keys()];
export const vfsRead = (p) => files.get(norm(p))?.data;

// ---------- node:fs surface ----------

function stat(p) {
  const n = norm(p);
  const f = files.get(n);
  if (f) return { size: f.size, mtimeMs: f.mtimeMs, isFile: () => true, isDirectory: () => false, isSymbolicLink: () => false };
  if (dirs.has(n)) return { size: 0, mtimeMs: 0, isFile: () => false, isDirectory: () => true, isSymbolicLink: () => false };
  throw enoent("stat", p);
}

function readFileSync(p, opts) {
  const f = files.get(norm(p));
  if (!f) throw enoent("open", p);
  const enc = typeof opts === "string" ? opts : opts?.encoding;
  return enc ? f.data : new TextEncoder().encode(f.data);
}

function readdirSync(p, opts) {
  const n = norm(p);
  const kids = dirs.get(n);
  if (!kids) throw enoent("scandir", p);
  const names = [...kids].sort();
  if (!opts?.withFileTypes) return names;
  return names.map((name) => {
    const full = n === "/" ? "/" + name : n + "/" + name;
    const isDir = dirs.has(full);
    return { name, isDirectory: () => isDir, isFile: () => !isDir, isSymbolicLink: () => false };
  });
}

function writeFileSync(p, data) {
  vfsAdd(p, typeof data === "string" ? data : new TextDecoder().decode(data), undefined, Date.now());
}

function rmSync(p) {
  const n = norm(p);
  if (files.delete(n)) dirs.get(parent(n))?.delete(base(n));
}

const fs = {
  existsSync: (p) => files.has(norm(p)) || dirs.has(norm(p)),
  statSync: stat,
  lstatSync: stat,
  readFileSync,
  readdirSync,
  writeFileSync,
  appendFileSync: (p, d) => writeFileSync(p, (files.get(norm(p))?.data || "") + d),
  mkdirSync: (p) => ensureDir(p),
  mkdtempSync: (prefix) => { const p = norm(prefix + Math.random().toString(36).slice(2, 8)); ensureDir(p); return p; },
  rmSync,
  unlinkSync: rmSync,
  renameSync: (a, b) => { const f = files.get(norm(a)); if (f) { rmSync(a); vfsAdd(b, f.data, f.size, f.mtimeMs); } },
  chmodSync: () => {},
  cpSync: () => { throw new Error("cpSync is not available in the browser"); },
};

export default fs;
export const { existsSync, statSync, lstatSync, readdirSync: readdir, writeFileSync: writeFile, mkdirSync, rmSync: rm } = fs;
export { readFileSync, readdirSync, writeFileSync };
