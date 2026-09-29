// Local knowledge base: every .md file in ./knowledge (and HE_KB_DIR, if set) is indexed by "## " sections.
// Drop your own customer notes / golden YAMLs in as markdown and they become searchable.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
export const KB_DIRS = [path.join(here, "..", "knowledge"), process.env.HE_KB_DIR].filter(Boolean);

function mdFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return mdFiles(p);
    return /\.(md|ya?ml|txt)$/.test(e.name) ? [p] : [];
  });
}

export function loadKnowledge() {
  const docs = [];
  for (const dir of KB_DIRS) {
    for (const file of mdFiles(dir)) {
      const text = fs.readFileSync(file, "utf8");
      const topic = path.relative(dir, file).replace(/\.(md|ya?ml|txt)$/, "");
      if (!file.endsWith(".md")) {
        docs.push({ topic, section: path.basename(file), text });
        continue;
      }
      const parts = text.split(/^(?=## )/m);
      for (const part of parts) {
        const heading = (part.match(/^##\s+(.+)/) || [])[1] || (part.match(/^#\s+(.+)/m) || [])[1] || topic;
        docs.push({ topic, section: heading.trim(), text: part.trim() });
      }
    }
  }
  return docs;
}

export function listTopics() {
  const docs = loadKnowledge();
  const topics = {};
  for (const d of docs) (topics[d.topic] ||= []).push(d.section);
  return topics;
}

export function searchKnowledge(query, limit = 6) {
  const docs = loadKnowledge();
  const terms = query.toLowerCase().split(/[^a-z0-9_.#-]+/).filter((t) => t.length > 1);
  if (!terms.length) return [];
  return docs
    .map((d) => {
      const hay = d.text.toLowerCase();
      const head = `${d.topic} ${d.section}`.toLowerCase();
      let score = 0;
      for (const t of terms) {
        const n = hay.split(t).length - 1;
        score += Math.min(n, 10) + (head.includes(t) ? 8 : 0);
      }
      return { ...d, score };
    })
    .filter((d) => d.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

export function getTopic(topic) {
  for (const dir of KB_DIRS) {
    for (const ext of [".md", ".yaml", ".yml", ".txt"]) {
      const p = path.join(dir, topic + ext);
      if (fs.existsSync(p)) return fs.readFileSync(p, "utf8");
    }
  }
  return null;
}
