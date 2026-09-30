// Reads per-test results from the reports a HyperExecute job produces (JUnit XML, Cucumber JSON,
// .NET TRX, Robot output.xml) and maps each failed test to a selector the runner command accepts,
// so only affected tests can be rerun.

import fs from "node:fs";
import path from "node:path";

const decode = (s) => String(s || "").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;|&#39;/g, "'").replace(/&#10;/g, "\n").replace(/&#13;/g, "").replace(/&amp;/g, "&");
const attr = (tag, name) => decode((tag.match(new RegExp(`\\s${name}="([^"]*)"`)) || [])[1]);
const cdata = (s) => decode(String(s || "").replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")).trim();

export function findResultFiles(dirs) {
  const out = [];
  for (const dir of dirs.filter(Boolean)) {
    const stack = [dir];
    while (stack.length && out.length < 2000) {
      const d = stack.pop();
      let entries;
      try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { continue; }
      for (const e of entries) {
        const full = path.join(d, e.name);
        if (e.isDirectory()) { if (!/^(node_modules|\.git|m2_cache_dir|gradle_cache|pip_cache)$/.test(e.name)) stack.push(full); }
        else if (/\.(xml|json|trx)$/i.test(e.name)) out.push(full);
      }
    }
  }
  return out;
}

// ---------- parsers ----------

function parseJUnit(text, source) {
  const tests = [];
  for (const m of text.matchAll(/<testcase\b([^>]*?)(\/>|>([\s\S]*?)<\/testcase>)/g)) {
    const tag = m[1];
    const body = m[3] || "";
    const f = body.match(/<(failure|error)\b([^>]*?)(?:\/>|>([\s\S]*?)<\/\1>)/);
    const skipped = /<skipped\b/.test(body);
    tests.push({
      format: "junit",
      source,
      classname: attr(`x ${tag}`, "classname"),
      name: attr(`x ${tag}`, "name"),
      file: attr(`x ${tag}`, "file") || null,
      status: f ? "failed" : skipped ? "skipped" : "passed",
      kind: f ? f[1] : null,
      message: f ? attr(`x ${f[2]}`, "message") || attr(`x ${f[2]}`, "type") : "",
      detail: f ? cdata(f[3]).slice(0, 4000) : "",
    });
  }
  return tests;
}

function parseCucumber(json, source) {
  const tests = [];
  for (const feature of Array.isArray(json) ? json : []) {
    for (const el of feature.elements || []) {
      if (el.type && el.type !== "scenario") continue;
      const steps = [...(el.before || []), ...(el.steps || []), ...(el.after || [])];
      const bad = steps.find((s) => s.result?.status === "failed") || steps.find((s) => s.result?.status === "undefined");
      tests.push({
        format: "cucumber",
        source,
        uri: feature.uri,
        line: el.line,
        name: el.name,
        classname: feature.name,
        status: bad ? "failed" : steps.every((s) => ["passed", "skipped"].includes(s.result?.status)) ? "passed" : "skipped",
        kind: bad?.result?.status === "undefined" ? "undefined-step" : bad ? "failure" : null,
        message: bad ? (bad.result.error_message || `Step "${bad.keyword || ""}${bad.name || ""}" is ${bad.result.status}`).split("\n")[0].slice(0, 400) : "",
        detail: bad?.result?.error_message?.slice(0, 4000) || "",
      });
    }
  }
  return tests;
}

function parseTrx(text, source) {
  const tests = [];
  const defs = new Map();
  for (const m of text.matchAll(/<UnitTest\b[^>]*\bid="([^"]+)"[\s\S]*?<TestMethod\b([^>]*)\/?>/g)) defs.set(m[1], { className: attr(`x ${m[2]}`, "className"), name: attr(`x ${m[2]}`, "name") });
  for (const m of text.matchAll(/<UnitTestResult\b([^>]*?)(\/>|>([\s\S]*?)<\/UnitTestResult>)/g)) {
    const outcome = attr(`x ${m[1]}`, "outcome");
    const def = defs.get(attr(`x ${m[1]}`, "testId")) || {};
    const msg = cdata((m[3] || "").match(/<Message>([\s\S]*?)<\/Message>/)?.[1]);
    const stack = cdata((m[3] || "").match(/<StackTrace>([\s\S]*?)<\/StackTrace>/)?.[1]);
    tests.push({ format: "trx", source, classname: (def.className || "").split(",")[0], name: def.name || attr(`x ${m[1]}`, "testName"), status: outcome === "Failed" ? "failed" : outcome === "Passed" ? "passed" : "skipped", kind: outcome === "Failed" ? "failure" : null, message: msg.split("\n")[0].slice(0, 400), detail: `${msg}\n${stack}`.slice(0, 4000) });
  }
  return tests;
}

function parseRobot(text, source) {
  const tests = [];
  const suiteSrc = [...text.matchAll(/<suite\b[^>]*\bsource="([^"]+)"/g)].map((m) => m[1]);
  for (const m of text.matchAll(/<test\b([^>]*)>([\s\S]*?)<\/test>/g)) {
    const st = [...m[2].matchAll(/<status\b([^>]*?)(?:\/>|>([\s\S]*?)<\/status>)/g)].pop();
    const status = st ? attr(`x ${st[1]}`, "status") : "";
    tests.push({ format: "robot", source, file: suiteSrc.at(-1) || null, name: attr(`x ${m[1]}`, "name"), classname: "", status: status === "FAIL" ? "failed" : status === "PASS" ? "passed" : "skipped", kind: status === "FAIL" ? "failure" : null, message: cdata(st?.[2]).split("\n")[0].slice(0, 400), detail: cdata(st?.[2]).slice(0, 4000) });
  }
  return tests;
}

export function parseResultFile(file) {
  let text;
  try {
    if (fs.statSync(file).size > 20 * 1024 * 1024) return [];
    text = fs.readFileSync(file, "utf8");
  } catch { return []; }
  if (/\.trx$/i.test(file) || /<TestRun\b/.test(text)) return parseTrx(text, file);
  if (/<testsuites?\b|<testcase\b/.test(text)) return parseJUnit(text, file);
  if (/<robot\b/.test(text)) return parseRobot(text, file);
  if (/\.json$/i.test(file) && /"elements"\s*:/.test(text)) { try { return parseCucumber(JSON.parse(text), file); } catch { return []; } }
  return [];
}

// All tests across result files, de-duplicated by identity (retries: last result wins).
export function collectTestResults(dirs) {
  const byKey = new Map();
  for (const f of findResultFiles(dirs)) {
    for (const t of parseResultFile(f)) {
      const key = t.format === "cucumber" ? `${t.uri}:${t.line}` : `${t.classname}|${t.name}|${t.file || ""}`;
      const prev = byKey.get(key);
      if (!prev || prev.status !== "passed") byKey.set(key, t); // a later pass (retry) clears a failure
    }
  }
  return [...byKey.values()];
}

// ---------- selectors (what the runner command's $test expects) ----------

function normalizeFeaturePath(uri, profile) {
  let p = String(uri || "").replace(/^(file:|classpath:)/, "").replace(/^\/+/, "");
  const root = profile?.repoPath;
  const pr = profile?.projectRoot || "";
  if (root && path.isAbsolute(uri || "")) p = path.relative(path.join(root, pr), uri.replace(/^file:/, ""));
  if (root && !fs.existsSync(path.join(root, pr, p))) {
    const hit = (profile.tests?.features || []).find((f) => f.endsWith(p) || f.endsWith("/" + path.posix.basename(p)));
    if (hit) p = pr && hit.startsWith(pr + "/") ? hit.slice(pr.length + 1) : hit;
  }
  return p.split(path.sep).join("/");
}

function pythonNodeId(t, profile) {
  // pytest junit: classname "tests.test_login.TestCheckout" / "tests.test_login", name "test_pay"
  const parts = String(t.classname || "").split(".");
  for (let i = parts.length; i > 0; i--) {
    const file = parts.slice(0, i).join("/") + ".py";
    if (profile?.repoPath && fs.existsSync(path.join(profile.repoPath, file))) {
      const cls = parts.slice(i);
      return [file, ...cls, t.name.replace(/\[.*$/, "")].join("::");
    }
  }
  return t.file ? `${t.file}::${t.name}` : null;
}

// Returns {selector, level} or null when the test can't be targeted individually.
export function toSelector(t, profile, yamlJs = {}) {
  const lang = profile?.language;
  const gradle = profile?.buildTool === "gradle";
  const method = String(t.name || "").replace(/\[.*$/, "").replace(/\(.*$/, "").trim();
  if (t.format === "cucumber") return t.uri && t.line ? { selector: `${normalizeFeaturePath(t.uri, profile)}:${t.line}`, level: "scenario" } : null;
  if (lang === "java" && t.classname) return method && !/\s/.test(method) ? { selector: `${t.classname}${gradle ? "." : "#"}${method}`, level: "method", classSelector: t.classname } : { selector: t.classname, level: "class" };
  if (lang === "python") {
    if (t.format === "robot") return t.file ? { selector: normalizeFeaturePath(t.file, profile), level: "file" } : null;
    const id = pythonNodeId(t, profile);
    return id ? { selector: id, level: "method" } : null;
  }
  if (lang === "csharp" && t.classname) return { selector: t.classname, level: "class" };
  if (lang === "node") {
    const f = t.file || (/[\\/]|\.(spec|test|cy)\./.test(t.classname || "") ? t.classname : null);
    return f ? { selector: normalizeFeaturePath(f, profile), level: "file" } : null;
  }
  return null;
}

export const testLabel = (t) => (t.format === "cucumber" ? `${t.name} (${path.posix.basename(String(t.uri || ""))}:${t.line})` : `${t.classname ? t.classname.split(".").pop() + "." : ""}${t.name}`);
