// When no rule explains a failed run, gather what a person would look at next, so the agent can propose a
// YAML change from evidence instead of a raw log tail:
//   - the failed step's command and its cleaned log
//   - the repo files that command depends on (test scripts and runner config, build files, wrapper scripts,
//     system properties the tests read)
//   - the repo's own HyperExecute YAMLs, compared key by key with the one that ran (in the batches, the most
//     useful clue: the flags, -D properties and runner commands a working setup already used)
//   - knowledge-base sections and learned fixes for the error line
// Everything is masked; nothing leaves the machine.

import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import crypto from "node:crypto";
import { cleanLine, isNoise, maskKeepRefs } from "./feedback.js";
import { searchKnowledge } from "./knowledge.js";

const read = (root, f) => { try { return fs.readFileSync(path.join(root, f), "utf8"); } catch { return null; } };
const excerpt = (text, max = 1500) => maskKeepRefs(String(text).length > max ? String(text).slice(0, max) + "\n…" : String(text));

// The keys that decide what runs on the VM; the rest (labels, timeouts) rarely explains a failure.
const KEYS = ["runson", "runtime", "pre", "testDiscovery", "testRunnerCommand", "testSuites", "matrix", "env", "framework", "cacheDirectories"];

function parse(text) {
  try { return YAML.parse(String(text).replace(/\$\{\{[^}]*\}\}/g, (m) => JSON.stringify(m))) || {}; } catch { return null; }
}

// Env values can be secrets: compare which keys are set, show values only for references and plain non-secret settings.
function shown(key, v) {
  if (key !== "env" || !v || typeof v !== "object") return v;
  return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, /KEY|TOKEN|SECRET|PASSWORD|USERNAME|AUTH/i.test(k) && !/\$\{\{/.test(String(x)) ? "<set>" : x]));
}

// The repo's own HyperExecute YAMLs, each compared with the one that ran.
export function compareWithRepoYamls(repo, profile, runYamlText, runConfig) {
  const ours = parse(runYamlText);
  if (!ours) return [];
  // .updatedhyperexecute.yaml is the CLI's own rewrite of the YAML that ran, .hyperexecute-rerun.yaml ours
  const own = (profile.existingHyperExecuteYamls || []).filter((f) => path.normalize(f) !== path.normalize(runConfig) && !/^\.(hyperexecute-rerun|updatedhyperexecute)/.test(path.basename(f)));
  const out = [];
  for (const f of own.slice(0, 4)) {
    const theirs = parse(read(repo, f));
    if (!theirs) continue;
    const differs = [];
    for (const k of KEYS) {
      const a = JSON.stringify(shown(k, ours[k]) ?? null), b = JSON.stringify(shown(k, theirs[k]) ?? null);
      if (a !== b && theirs[k] !== undefined) differs.push({ key: k, theirs: shown(k, theirs[k]), ours: shown(k, ours[k]) ?? null });
    }
    if (differs.length) out.push({ file: f, differs: JSON.parse(maskKeepRefs(JSON.stringify(differs))) });
  }
  return out;
}

// Files the failed command (or the test runner) depends on, per stack.
export function relatedFiles(repo, profile, command = "") {
  const files = [];
  const add = (f, why, max) => { const t = f && read(repo, f); if (t != null && !files.some((x) => x.file === f)) files.push({ file: f, why, excerpt: excerpt(t, max) }); };
  const pkgRoot = profile.packageRoot ? profile.packageRoot + "/" : "";
  if (profile.language === "node") {
    const scripts = profile.scripts || {};
    if (Object.keys(scripts).length) files.push({ file: `${pkgRoot}package.json`, why: "npm scripts: the flags the repo's own test command passes (timeouts, config, reporters)", excerpt: excerpt(JSON.stringify({ scripts }, null, 2)) });
    if (profile.configFile) add(pkgRoot + profile.configFile, "the test runner's config");
    for (const f of [".mocharc.js", ".mocharc.json", ".mocharc.yml", ".mocharc.yaml"]) add(pkgRoot + f, "Mocha options");
  }
  if (profile.language === "java") {
    const root = profile.projectRoot ? profile.projectRoot + "/" : "";
    const pom = read(repo, root + "pom.xml");
    if (pom) {
      // the surefire/failsafe plugin block says which suites, groups and system properties a test run uses
      const plugin = pom.match(/<plugin>(?:(?!<\/plugin>)[\s\S])*?maven-(surefire|failsafe)-plugin[\s\S]*?<\/plugin>/);
      files.push({ file: root + "pom.xml", why: plugin ? "the surefire/failsafe configuration" : "the build file", excerpt: excerpt(plugin ? plugin[0] : pom, 2500) });
    }
    for (const f of ["build.gradle", "build.gradle.kts"]) add(root + f, "the build file", 2500);
    const gw = read(repo, root + "gradlew");
    if (gw != null) {
      const crlf = /\r\n/.test(gw), jar = fs.existsSync(path.join(repo, root, "gradle/wrapper/gradle-wrapper.jar"));
      if (crlf || !jar) files.push({ file: root + "gradlew", why: "the Gradle wrapper", excerpt: [crlf && "Windows (CRLF) line endings: fails on Linux with 'sh\\r: No such file'", !jar && "gradle/wrapper/gradle-wrapper.jar is missing: ./gradlew can't start"].filter(Boolean).join("; ") });
    }
    if (profile.sysProps?.length) files.push({ file: "(Java system properties)", why: "System.getProperty reads with no default: the run must pass -D<name>=…", excerpt: profile.sysProps.join(", ") });
    for (const f of (profile.configFiles || []).filter((x) => /GebConfig|testng.*\.xml$|\.properties$/.test(x)).slice(0, 3)) add(f, "test configuration", 1200);
  }
  if (profile.language === "python") for (const f of ["requirements.txt", "pyproject.toml", "pytest.ini", "setup.cfg", "tox.ini"]) add(f, "Python dependencies / pytest options", 1200);
  if (profile.language === "ruby") for (const f of ["Gemfile", ".ruby-version", ".rspec"]) add(f, "Ruby version and gems", 1200);
  if (profile.language === "dotnet") for (const f of (profile.configFiles || []).filter((x) => /\.csproj$/.test(x)).slice(0, 2)) add(f, "target framework and test packages", 1500);
  // files the failed command names that exist in the repo (a script it runs, a suite file it passes)
  for (const tok of String(command).split(/[\s"'=]+/).filter((t) => /[\w-]+\.[a-z]{1,5}$/i.test(t) && !/^https?:/.test(t)).slice(0, 4)) add(tok.replace(/^\.\//, ""), "named in the failed command", 1200);
  return files.slice(0, 8);
}

export function investigate({ repo, profile, yamlText, config, evidence, diagnosis, failure, learnedFix }) {
  const st = evidence?.failedStage;
  const clean = (t, n = 60) => maskKeepRefs(String(t).split("\n").map(cleanLine).filter((l) => l && !isNoise(l)).slice(-n).join("\n"));
  const failedStep = { stage: st?.stage || null, command: st?.command || null, remark: st?.remark || null, log: st?.log ? clean(st.log) : null };
  // a test-stage failure has no step log of its own: show the first test log that reports an error
  if (!failedStep.log) {
    // logs/<jobId>/scenarios/<test name>: named after the test (specs-google.spec.js), so not in evidence.files
    // this job's folder first; other folders are earlier attempts of the same setup
    const all = (() => { try { return fs.readdirSync(path.join(repo, "logs")); } catch { return []; } })();
    const jobs = [...new Set([evidence.jobId, ...all].filter(Boolean))];
    const scen = jobs.flatMap((j) => { try { return fs.readdirSync(path.join(repo, "logs", j, "scenarios")).map((n) => `logs/${j}/scenarios/${n}`); } catch { return []; } });
    for (const f of scen.filter((x) => !/-retry-\d+$/.test(x)).slice(0, 40)) {
      const t = read(repo, f);
      if (!t || !/\b(error|exception|failed|failing|fail)\b|\w(Error|Exception)\b/i.test(t)) continue;
      const lines = t.split("\n").map(cleanLine).filter((l) => l && !isNoise(l));
      const errs = lines.filter((l) => /\b(error|exception|failed|failing|fail|timed? ?out|not found|cannot|unable)\b|\w(Error|Exception)\b/i.test(l) && !/^\s*at\s/.test(l)).slice(0, 25);
      failedStep.testLog = { file: f, errors: maskKeepRefs(errs.join("\n")), tail: maskKeepRefs(lines.slice(-25).join("\n")) };
      break;
    }
  }
  const query = [failure?.headline, st?.command].filter(Boolean).join(" ").slice(0, 300);
  const knowledge = query ? searchKnowledge(query, 3).map((k) => ({ topic: k.topic, section: k.section, source: k.source, text: excerpt(k.text, 700) })) : [];
  return {
    failure: failure?.headline || null,
    failedStep: failedStep.stage || failedStep.log || failedStep.testLog ? failedStep : null,
    repoFiles: relatedFiles(repo, profile, st?.command),
    repoYamls: compareWithRepoYamls(repo, profile, yamlText, config),
    knowledge,
    fixedBefore: learnedFix ? { change: learnedFix.change, worked: learnedFix.worked } : undefined,
    how: "Work out the cause from failedStep, then repoFiles and repoYamls (a working setup's flags, -D properties and runner commands are the strongest clue). Change only what the evidence points at, validate_hyperexecute_yaml, then fix_and_rerun_hyperexecute with yamlContent. A change outside the YAML (test code, app, account, the platform) is not yours to make: report it.",
  };
}

// Identifies a YAML change exactly (values included: --timeout=5000 and --timeout=100000 are different changes),
// so the loop can refuse to apply one it already tried.
export const changeKey = (before, after) => {
  const a = new Set(String(before).split("\n")), b = new Set(String(after).split("\n"));
  const d = [...String(after).split("\n").filter((l) => l.trim() && !a.has(l)).map((l) => "+" + l.trim()), ...String(before).split("\n").filter((l) => l.trim() && !b.has(l)).map((l) => "-" + l.trim())].sort();
  return d.length ? crypto.createHash("sha1").update(d.join("\n")).digest("hex").slice(0, 12) : null;
};
