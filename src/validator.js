// Lint a HyperExecute YAML for structural errors and common solution-engineering mistakes.

import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";

const KNOWN_KEYS = new Set([
  "version", "runson", "pre", "post", "autosplit", "concurrency", "matrix", "parallelism", "macParallelism", "winParallelism",
  "linuxParallelism", "testDiscovery", "testRunnerCommand", "linuxTestRunnerCommand", "macTestRunnerCommand", "winTestRunnerCommand",
  "testSuites", "runtime", "cacheKey", "cacheDirectories", "env", "retryOnFailure", "maxRetries", "failFast", "retryOptions", "report",
  "partialReports", "uploadArtefacts", "mergeArtifacts", "errorCategorizedReport", "globalTimeout", "testSuiteTimeout", "testSuiteStep",
  "postDirectives", "preDirectives", "globalPre", "globalPost", "alwaysRunPostSteps", "vars", "dataJsonPath", "dataJsonBuilder",
  "sourcePayload", "exclusionMatrix", "combineTasksInMatrixMode", "jobLabel", "project", "base", "hostsOverride",
  "captureScreenRecordingForScenarios", "cypress", "cypressOps", "background", "backgroundDirectives", "shell", "workingDirectory",
  "dynamicAllocation", "skipArtifactStageIfNoTest", "tunnel", "tunnelOpts", "tunnelNames", "execution", "differentialUpload",
  "scenarioCommandStatusOnly", "frameworkStatusOnly", "testRunnerExecutor", "collectLocalGitData", "strict", "cacheTestURL", "smartGrid",
  "buildConfig", "captureCSVResult", "matrixEnvPrefix", "afterEachScenario", "linkValidity", "stripParentDirectory",
  "generateArtifactAfterEveryStage", "taskIdentifierInNonConflictingArtifacts", "errorCategorizedOnFailureOnly", "framework",
  "jobID", "retryOnFailureOnly", "idleTimeout", "autosplitStrategy", "sequential", "testSuiteStepTimeout",
]);
const V02_NAMES = ["maven/testng", "maven/junit4", "maven/junit5", "maven/spock", "gradle/testng", "gradle/junit4", "gradle/junit5", "gradle/junit6", "gradle/spock", "dotnet/mstest", "dotnet/nunit"];
const RUNSON = ["linux", "mac", "mac13", "win", "win11"];
const REPORT_FRAMEWORKS = ["extent", "extent-native", "testng", "cucumber", "junit", "allure", "playwright", "specflow", "karate", "robot", "katalon", "cypress"];

function lev(a, b) {
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++)
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + (a[i - 1].toLowerCase() === b[j - 1].toLowerCase() ? 0 : 1));
  return dp[a.length][b.length];
}
const suggest = (k) => [...KNOWN_KEYS].map((x) => [x, lev(k, x)]).sort((a, b) => a[1] - b[1]).find(([, d]) => d <= 3)?.[0];

export function validateYaml(text, repoPath) {
  const errors = [];
  const warnings = [];
  const info = [];

  if (/^\t/m.test(text)) errors.push("YAML contains tab indentation — YAML only allows spaces.");
  let doc;
  try {
    const parsed = YAML.parseDocument(text, { uniqueKeys: true });
    if (parsed.errors.length) return { valid: false, errors: parsed.errors.map((e) => e.message), warnings, info };
    doc = parsed.toJS();
  } catch (e) {
    return { valid: false, errors: [e.message], warnings, info };
  }
  if (!doc || typeof doc !== "object") return { valid: false, errors: ["YAML is empty or not a mapping."], warnings, info };

  for (const k of Object.keys(doc)) {
    if (!KNOWN_KEYS.has(k)) {
      const s = suggest(k);
      warnings.push(`Unknown top-level key "${k}"${s ? ` — did you mean "${s}"?` : ""}`);
    }
  }

  // mandatory
  if (doc.version === undefined) errors.push("Missing `version` (use 0.1).");
  else if (![0.1, 0.2, "0.1", "0.2"].includes(doc.version)) warnings.push(`version ${doc.version} — expected 0.1 or 0.2.`);
  if (!doc.runson) errors.push("Missing `runson` (linux | mac | win).");
  else if (String(doc.runson).includes("matrix.")) {
    const key = String(doc.runson).match(/matrix\.(\w+)/)?.[1];
    if (!doc.matrix || !doc.matrix[key]) errors.push(`runson references \${matrix.${key}} but matrix.${key} is not defined.`);
    else for (const os of doc.matrix[key]) if (!RUNSON.includes(os)) errors.push(`matrix.${key} contains "${os}" — allowed: ${RUNSON.join(", ")}.`);
  } else if (!RUNSON.includes(doc.runson)) errors.push(`runson "${doc.runson}" is invalid — allowed: ${RUNSON.join(", ")}.`);
  if (!doc.pre && !doc.preDirectives && String(doc.version) !== "0.2") warnings.push("No `pre` steps — dependencies won't be installed on the VM.");
  else if (doc.pre && !Array.isArray(doc.pre)) errors.push("`pre` must be a list of commands.");
  if (doc.post && !Array.isArray(doc.post)) errors.push("`post` must be a list of commands.");

  // YAML v0.2 (framework field) — rules from Confluence HYP "Yaml version 0.2"
  if (String(doc.version) === "0.2") {
    const fw = doc.framework;
    if (!fw?.name) errors.push("v0.2 requires `framework.name` (e.g. maven/testng, gradle/junit5, dotnet/nunit).");
    else {
      if (!V02_NAMES.includes(fw.name)) errors.push(`framework.name "${fw.name}" is not a v0.2 runner — allowed: ${V02_NAMES.join(", ")}.`);
      const remoteOnly = /^(gradle\/|maven\/spock|dotnet\/)/.test(fw.name);
      if (remoteOnly && ["local", "static"].includes(fw.discoveryMode)) errors.push(`${fw.name} only supports remote discovery.`);
      if (fw.discoveryMode && !["local", "remote"].includes(fw.discoveryMode)) errors.push(`framework.discoveryMode "${fw.discoveryMode}" — expected local or remote.`);
      if (fw.discoveryType && !["method", "class", "xmltest"].includes(fw.discoveryType)) errors.push(`framework.discoveryType "${fw.discoveryType}" — expected method, class or xmltest.`);
      if (fw.discoveryType === "xmltest" && !fw.name.endsWith("/testng")) errors.push("discoveryType xmltest is TestNG-only.");
      if (fw.baseCommand && !/^(mvn|\.\/mvnw|mvnw|gradle|\.\/gradlew|gradlew)/.test(fw.baseCommand) && !fw.name.startsWith("dotnet/"))
        errors.push(`framework.baseCommand "${fw.baseCommand}" must be a full command starting with the build tool (mvn / gradle / ./gradlew), not a bare goal/task.`);
      for (const k of ["flags", "discoveryFlags", "runnerFlags"]) if (fw[k] && !Array.isArray(fw[k])) errors.push(`framework.${k} must be a list.`);
      if (fw.defaultReports === true && doc.report === true) errors.push("v0.2: framework.defaultReports: true must not be combined with report: true.");
    }
    if (doc.testDiscovery) errors.push("v0.2 YAML must NOT contain testDiscovery — it silently routes the job to the v0.1 path and runs 0 tests. Use framework.discoveryMode instead.");
    if (doc.testRunnerCommand) warnings.push("testRunnerCommand is obsolete in v0.2 — the framework runner builds the command.");
    if (doc.matrix) errors.push("Matrix mode is not supported in v0.2.");
    if (doc.autosplit !== true) errors.push("v0.2 framework discovery requires autosplit: true.");
    if (doc.cacheKey && doc.cacheDirectories) info.push("cacheKey + cacheDirectories disable v0.2's automatic ~/.m2 / ~/.gradle / ~/.nuget caching.");
  } else if (doc.framework) {
    warnings.push("`framework` is a v0.2 field — set version: \"0.2\" (and remove testDiscovery/testRunnerCommand) or drop it.");
  }

  // execution mode
  const isV02 = String(doc.version) === "0.2";
  const isAuto = doc.autosplit === true && !isV02;
  const isMatrix = !!doc.matrix;
  if (!isAuto && !isMatrix && !isV02) errors.push("Neither `autosplit: true` nor `matrix` is set — HyperExecute won't know how to split tests.");
  if (isAuto) {
    if (!doc.testDiscovery) errors.push("autosplit requires `testDiscovery`.");
    else {
      const td = doc.testDiscovery;
      if (!td.command) errors.push("testDiscovery.command is missing.");
      if (td.type && !["raw", "automatic"].includes(td.type)) errors.push(`testDiscovery.type "${td.type}" — expected raw or automatic.`);
      if (!td.mode) warnings.push("testDiscovery.mode not set (local | remote).");
      else if (["static", "dynamic"].includes(td.mode)) info.push(`testDiscovery.mode "${td.mode}" is the legacy name; current docs use local | remote.`);
      else if (!["local", "remote"].includes(td.mode)) errors.push(`testDiscovery.mode "${td.mode}" — expected local or remote.`);
      if (td.command && /\bsed -i\b|\brm\b/.test(td.command)) warnings.push("testDiscovery.command modifies files — discovery should only print test identifiers.");
    }
    const runners = ["testRunnerCommand", "linuxTestRunnerCommand", "macTestRunnerCommand", "winTestRunnerCommand"].filter((k) => doc[k]);
    if (!runners.length) errors.push("autosplit requires `testRunnerCommand`.");
    for (const k of runners) if (!String(doc[k]).includes("$test")) errors.push(`${k} doesn't contain $test — every task would run the same thing.`);
  }
  if (isMatrix) {
    if (!doc.testSuites && !isAuto) errors.push("matrix mode requires `testSuites`.");
    if (doc.testSuites && !Array.isArray(doc.testSuites)) errors.push("`testSuites` must be a list.");
    for (const [k, v] of Object.entries(doc.matrix)) if (!Array.isArray(v)) errors.push(`matrix.${k} must be a list.`);
    const used = new Set((doc.testSuites || []).join(" ").match(/\$(\w+)/g)?.map((m) => m.slice(1)) || []);
    for (const k of Object.keys(doc.matrix)) if (k !== "os" && !used.has(k)) info.push(`matrix.${k} isn't referenced in testSuites — fine if tests read it as an env var, otherwise it only multiplies tasks.`);
    for (const u of used) if (!(u in doc.matrix) && !(doc.env && u in doc.env) && !["RANDOM", "CACHE_DIR", "HOME", "PATH"].includes(u)) warnings.push(`testSuites uses $${u} which is not a matrix key or env var.`);
    const combos = Object.values(doc.matrix).filter(Array.isArray).reduce((n, v) => n * v.length, 1);
    info.push(`Matrix expands to ${combos} task(s).`);
    if ((doc.matrix.test || []).some((v) => String(v).startsWith("<add")) || (doc.matrix.tag || []).some((v) => String(v).startsWith("<add"))) errors.push("Matrix still contains placeholder values — fill them in.");
  }

  // numbers
  if (doc.concurrency !== undefined && (!Number.isInteger(doc.concurrency) || doc.concurrency < 1)) errors.push("`concurrency` must be a positive integer.");
  if (doc.concurrency === undefined && doc.parallelism === undefined) warnings.push("No `concurrency` set — defaults may run tests serially.");
  if (doc.maxRetries !== undefined && (!Number.isInteger(doc.maxRetries) || doc.maxRetries < 1 || doc.maxRetries > 5)) errors.push("`maxRetries` must be 1-5.");
  if (doc.maxRetries && doc.retryOnFailure !== true) warnings.push("`maxRetries` is set but `retryOnFailure` is not true.");
  if (doc.globalTimeout !== undefined && (doc.globalTimeout < 1 || doc.globalTimeout > 150)) errors.push("`globalTimeout` must be 1-150 minutes.");
  if (doc.testSuiteTimeout && doc.globalTimeout && doc.testSuiteTimeout > doc.globalTimeout) warnings.push("testSuiteTimeout is larger than globalTimeout.");

  // cache
  if (doc.cacheKey && !/\{\{\s*checksum\s+"[^"]+"\s*\}\}/.test(doc.cacheKey)) warnings.push(`cacheKey "${doc.cacheKey}" — usual form is '{{ checksum "pom.xml" }}'.`);
  if (doc.cacheKey && !doc.cacheDirectories) warnings.push("cacheKey set but no cacheDirectories.");
  if (doc.cacheDirectories && !Array.isArray(doc.cacheDirectories)) errors.push("`cacheDirectories` must be a list.");
  const preText = (doc.pre || []).join(" ");
  if (!isV02 && preText.includes("mvn") && !preText.includes("maven.repo.local")) warnings.push("Maven in `pre` without -Dmaven.repo.local=<cache dir> — the .m2 cache won't be reused between runs.");
  if ((doc.testRunnerCommand || "").includes("mvn") && doc.env?.CACHE_DIR && !String(doc.testRunnerCommand).includes("maven.repo.local"))
    warnings.push("testRunnerCommand runs mvn without -Dmaven.repo.local=$CACHE_DIR — it will re-download dependencies.");

  // env / secrets
  for (const [k, v] of Object.entries(doc.env || {})) {
    const s = String(v);
    if (/(KEY|TOKEN|SECRET|PASSWORD)/i.test(k) && s && !s.includes("secrets.") && !s.startsWith("$") && !s.startsWith("<")) warnings.push(`env.${k} looks like a hard-coded secret — use \${{ .secrets.${k} }}.`);
    if (s.startsWith("<set ")) errors.push(`env.${k} still has a placeholder value.`);
  }

  // reports / artefacts
  if (doc.partialReports) {
    for (const pr of [].concat(doc.partialReports)) {
      if (!pr.location || !pr.type || !pr.frameworkName) errors.push("partialReports needs location, type and frameworkName.");
      if (pr.type && !["html", "json", "xml"].includes(pr.type)) errors.push(`partialReports.type "${pr.type}" — expected html, json or xml.`);
      if (pr.frameworkName && !REPORT_FRAMEWORKS.includes(pr.frameworkName)) warnings.push(`partialReports.frameworkName "${pr.frameworkName}" is not one I recognize (${REPORT_FRAMEWORKS.join(", ")}).`);
    }
    if (doc.report !== true) warnings.push("partialReports set but `report: true` is missing.");
  }
  for (const a of doc.uploadArtefacts || []) {
    if (!a.name || !a.path) errors.push("Each uploadArtefacts entry needs `name` and `path`.");
    else if (!Array.isArray(a.path)) errors.push(`uploadArtefacts "${a.name}": path must be a list.`);
    if (a.name && /\s/.test(a.name)) warnings.push(`uploadArtefacts name "${a.name}" contains spaces.`);
  }
  if ("uploadArtifacts" in doc) errors.push("Key is spelled `uploadArtefacts` (with 'e') in HyperExecute.");

  // repo-aware checks
  if (repoPath) {
    const root = path.resolve(repoPath);
    const ck = String(doc.cacheKey || "").match(/checksum\s+"([^"]+)"/)?.[1];
    if (ck && !fs.existsSync(path.join(root, ck))) errors.push(`cacheKey checksums "${ck}", which doesn't exist in the repo.`);
    const cmds = [doc.testDiscovery?.command, doc.testRunnerCommand, ...(doc.testSuites || []), ...(doc.pre || [])].filter(Boolean).join(" ");
    const cdDir = cmds.match(/\bcd\s+([^\s&;]+)\s*&&/)?.[1] || doc.framework?.workingDirectory || "";
    if (/\.\/mvnw\b/.test(cmds) && !fs.existsSync(path.join(root, cdDir, "mvnw"))) errors.push("Commands use ./mvnw but the project has no mvnw.");
    if (/\.\/gradlew\b/.test(cmds) && !fs.existsSync(path.join(root, "gradlew"))) errors.push("Commands use ./gradlew but the repo has no gradlew.");
    for (const m of cmds.matchAll(/-r\s+(\S+\.txt)/g)) if (!fs.existsSync(path.join(root, m[1]))) errors.push(`${m[1]} referenced in commands does not exist.`);
  }

  return { valid: errors.length === 0, errors, warnings, info, parsed: doc };
}
