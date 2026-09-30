// Turns a repo profile (from analyzer.js) + user options into a HyperExecute YAML.

import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { loadCreds } from "./credentials.js";

// The saved LambdaTest account goes straight into the YAML unless turned off
// (option embedCredentials: false, or HE_EMBED_CREDENTIALS=off); then ${{ .secrets.* }} references are used.
export function embeddedCredentials(opts = {}) {
  if (opts.embedCredentials === false || /^(off|0|false|no)$/i.test(process.env.HE_EMBED_CREDENTIALS || "")) return null;
  const c = opts.ltCredentials || loadCreds();
  return c?.username && c?.accessKey ? c : null;
}

const SECRET_LIKE = /(KEY|TOKEN|SECRET|PASSWORD|PASSWD|PWD|USERNAME|USER_NAME|CREDENTIAL|AUTH)/i;

// Which split granularities each framework family supports, first = default.
const SPLITS = {
  "java-classic": ["class", "method", "suite", "tag"],
  "java-cucumber": ["feature", "scenario", "tag"],
  "node-files": ["file", "tag"],
  "node-cucumber": ["feature", "scenario", "tag"],
  pytest: ["file", "method", "tag"],
  behave: ["feature", "scenario", "tag"],
  robot: ["file", "tag"],
  dotnet: ["class", "tag"],
  specflow: ["tag", "none"],
};

function pickFramework(profile, override) {
  if (override) return override;
  const fws = profile.frameworks;
  const order = ["cucumber", "testng", "junit5", "junit4", "spock", "karate", "playwright", "cypress", "webdriverio", "cucumber-js", "nightwatch", "testcafe", "jest", "mocha", "robot", "behave", "pytest-bdd", "pytest", "specflow", "nunit", "xunit", "mstest"];
  return order.find((f) => fws.includes(f)) || fws[0] || null;
}

function familyOf(fw) {
  if (["testng", "junit5", "junit4", "spock", "karate", "serenity"].includes(fw)) return "java-classic";
  if (fw === "cucumber") return "java-cucumber";
  if (fw === "cucumber-js") return "node-cucumber";
  if (["playwright", "cypress", "webdriverio", "nightwatch", "testcafe", "jest", "mocha"].includes(fw)) return "node-files";
  if (fw === "pytest" || fw === "pytest-bdd") return "pytest";
  if (fw === "behave") return "behave";
  if (fw === "robot") return "robot";
  if (fw === "specflow") return "specflow";
  if (["nunit", "xunit", "mstest"].includes(fw)) return "dotnet";
  return null;
}

const q = (s) => `'${s.replace(/'/g, "'\\''")}'`;

// Directory roots (e.g. "src/test/java", "moduleA/src/test/java") that contain the Java test classes.
function javaTestRoots(profile) {
  const roots = new Set();
  for (const c of profile.tests.classes) {
    const m = c.file.match(/^(.*?src\/test\/(?:java|groovy))\//);
    if (m) roots.add(m[1]);
    else roots.add(path.posix.dirname(c.file));
  }
  return roots.size ? [...roots] : ["src/test/java"];
}

// ---------- recipes ----------
// Each recipe returns { env, cacheKey, cacheDirectories, pre, runtime, discovery: {split: cmd}, runner(split) -> cmd with $test,
//   tagRunner -> cmd with $tag, matrixValues: {split: [...]}, partialReports, uploadArtefacts, notes }

// Java projects can sit in a sub-folder: run every command from there and point report/artefact paths into it.
function javaRecipe(profile, fw, opts) {
  const r = javaRecipeInner(profile, fw, opts);
  const pr = profile.projectRoot;
  if (!pr) return r;
  const cd = (c) => `cd ${pr} && ${c}`;
  const inRoot = (p) => path.posix.join(pr, p);
  const rel = (p) => (p.startsWith(pr + "/") ? p.slice(pr.length + 1) : p);
  r.pre = r.pre.map(cd);
  const runner = r.runner;
  r.runner = (s) => cd(runner(s));
  for (const k of ["tagRunner", "suiteRunner"]) if (r[k]) r[k] = cd(r[k]);
  for (const k of Object.keys(r.discovery)) r.discovery[k] = cd(r.discovery[k]);
  for (const k of ["feature", "scenario", "suite"]) if (r.matrixValues[k]) r.matrixValues[k] = r.matrixValues[k].map(rel);
  if (r.partialReports) r.partialReports.location = inRoot(r.partialReports.location);
  r.uploadArtefacts = r.uploadArtefacts.map((a) => ({ ...a, path: a.path.map(inRoot) }));
  r.notes.push(`The Java project lives in ${pr}/ — commands cd into it and report paths point there.`);
  return r;
}

function javaRecipeInner(profile, fw, opts) {
  const notes = [];
  const maven = profile.buildTool !== "gradle";
  const win = opts.runson.startsWith("win");
  const pr = profile.projectRoot || "";
  const cd = pr ? `cd ${pr} && ` : "";
  const rel = (p) => (pr && p.startsWith(pr + "/") ? p.slice(pr.length + 1) : p);
  const inRoot = (p) => (pr ? path.posix.join(pr, p) : p);
  const roots = javaTestRoots(profile).map(rel);
  const rootsArg = roots.join(" ");
  const r = { env: {}, notes, discovery: {}, matrixValues: {}, uploadArtefacts: [] };

  if (maven) {
    const mvn = profile.hasMavenWrapper && !win ? "./mvnw" : "mvn";
    r.env.CACHE_DIR = "m2_cache_dir";
    r.cacheKey = `{{ checksum "${inRoot("pom.xml")}" }}`;
    r.cacheDirectories = ["$CACHE_DIR"];
    const P = opts.mavenProfile ? ` -P${opts.mavenProfile}` : "";
    r.pre = [`${mvn}${P} -Dmaven.repo.local=$CACHE_DIR -Dmaven.test.skip=true clean install`];
    r.base = `${mvn} test${P} -Dmaven.repo.local=$CACHE_DIR -DfailIfNoTests=false -Dsurefire.failIfNoSpecifiedTests=false`;
    if (opts.mavenProfile) notes.push(`Maven profile ${opts.mavenProfile} is passed to every mvn command (-P${opts.mavenProfile}).`);
  } else {
    const gradle = profile.hasGradleWrapper ? (win ? "gradlew.bat" : "./gradlew") : "gradle";
    const bf = inRoot(profile.primaryBuildFile || "build.gradle");
    r.env.GRADLE_USER_HOME = "gradle_cache";
    r.cacheKey = `{{ checksum "${bf}" }}`;
    r.cacheDirectories = ["gradle_cache"];
    r.pre = [`${gradle} clean testClasses --no-daemon`];
    r.base = `${gradle} test --no-daemon`;
  }
  if (profile.runtimeVersion) r.runtime = { language: "java", version: String(profile.runtimeVersion) };

  if (fw === "cucumber") {
    const featRoot = rel(profile.featureRoot || "src/test/resources");
    const runner = profile.cucumberRunners[0];
    if (profile.cucumberRunners.length > 1) notes.push(`Multiple Cucumber runners found (${profile.cucumberRunners.map((c) => c.simpleName).join(", ")}); using ${runner.simpleName}. Pass runnerClass to override.`);
    const runnerClass = opts.runnerClass || runner?.simpleName;
    const major = parseInt((profile.cucumberVersion || "7").split(".")[0], 10);
    const featProp = (v) => (major >= 5 ? `-Dcucumber.features=${v}` : `-Dcucumber.options=${v}`);
    const tagProp = (v) => (major >= 5 ? `-Dcucumber.filter.tags=${v}` : `-Dcucumber.options="--tags ${v}"`);
    const sel = maven ? (runnerClass ? ` -Dtest=${runnerClass}` : "") : runnerClass ? ` --tests "*${runnerClass}"` : "";
    r.discovery.feature = `find ${featRoot} -type f -name '*.feature' | sed 's#^\\./##'`;
    r.discovery.scenario = `grep -rnE '^[[:space:]]*Scenario( Outline| Template)?:' ${featRoot} --include='*.feature' | awk -F: '{print $1":"$2}'`;
    r.discovery.tag = `grep -rhoE '(^|[[:space:]])@[A-Za-z0-9_-]+' ${featRoot} --include='*.feature' | sed -E 's/^[[:space:]]*//' | sort -u`;
    r.runner = () => `${r.base}${sel} ${featProp('"$test"')}`;
    r.tagRunner = `${r.base}${sel} ${tagProp('"$tag"')}`;
    r.matrixValues.feature = profile.tests.features;
    r.matrixValues.scenario = profile.tests.scenarios;
    r.matrixValues.tag = profile.tests.tags;
    const cukeJson = findCucumberJson(profile);
    r.partialReports = { location: cukeJson || "target/cucumber-reports/", type: "json", frameworkName: "cucumber" };
    if (!cukeJson) notes.push("No Cucumber `json:` plugin output found in runner options. Add e.g. plugin = {\"json:target/cucumber-reports/cucumber.json\"} so HyperExecute can build the Cucumber report.");
    r.uploadArtefacts.push({ name: "Reports", path: maven ? ["target/cucumber-reports/**", "target/surefire-reports/**"] : ["build/reports/**"] });
    if (!maven) notes.push("Gradle + Cucumber: make sure your test task forwards system properties (systemProperties System.getProperties()) so -Dcucumber.* reaches the JVM.");
    return r;
  }

  // TestNG / JUnit
  const sedFqn = `sed -E 's#^.*src/test/(java|groovy)/##; s#\\.(java|groovy)$##; s#/#.#g'`;
  r.discovery.class = fw === "spock"
    ? `grep -rlE --include='*.groovy' 'extends[[:space:]]+(spock\\.lang\\.)?Specification' ${rootsArg} | ${sedFqn}`
    : `grep -rlE --include='*.java' '@(Test|ParameterizedTest)([^A-Za-z]|$)' ${rootsArg} | ${sedFqn}`;
  const sep = maven ? "#" : ".";
  r.discovery.method =
    `grep -rlE --include='*.java' '@(Test|ParameterizedTest)([^A-Za-z]|$)' ${rootsArg} | while read f; do ` +
    `c=$(echo "$f" | ${sedFqn}); ` +
    `awk -v c="$c" '/@(Test|ParameterizedTest)([^A-Za-z]|$)/{t=1} t && /void[ \\t]+[A-Za-z0-9_]+[ \\t]*\\(/{s=$0; sub(/.*void[ \\t]+/,"",s); sub(/[ \\t]*\\(.*/,"",s); print c"${sep}"s; t=0}' "$f"; done`;
  r.matrixValues.class = profile.tests.classes.map((c) => c.className);
  r.matrixValues.method = profile.tests.classes.flatMap((c) => c.methods.map((m) => `${c.className}${sep}${m}`));
  r.matrixValues.tag = [...new Set(profile.tests.classes.flatMap((c) => [...(c.groups || []), ...(c.tags || [])]))];
  r.runner = () => (maven ? `${r.base} -Dtest="$test"` : `${r.base} --tests "$test"`);
  // Gradle multi-module: "gradle test --tests X" fails in every module where X doesn't exist
  // ("No tests found for given includes"), so each discovered item names its module's test task.
  const modRoots = roots.filter((x) => x !== "src/test/java" && x.endsWith("/src/test/java"));
  if (!maven && modRoots.length) {
    const gradle = r.base.split(" ")[0];
    const toTask = `sed -E 's#^(.*)/src/test/java/(.*)\\.java$#\\1 \\2#' | awk '{m=$1; gsub("/",":",m); c=$2; gsub("/",".",c); print m":test --tests "c}'`;
    r.discovery.class = `grep -rlE --include='*.java' '@(Test|ParameterizedTest)([^A-Za-z]|$)' ${rootsArg} | ${toTask}`;
    delete r.discovery.method;
    r.runner = () => `${gradle} :$test --no-daemon`;
    r.matrixValues.class = profile.tests.classes.map((c) => { const m = c.file.slice(0, c.file.indexOf("/src/test/java/")); return `${m.replace(/\//g, ":")}:test --tests ${c.className}`; });
    notes.push(`Gradle multi-module build: each task runs one module's test task (e.g. :${modRoots[0].replace("/src/test/java", "").replace(/\//g, ":")}:test --tests <class>), because a --tests filter fails in modules that don't have the class. $test is left unquoted on purpose so it expands to task + filter.`);
  }
  r.tagRunner = maven ? `${r.base} -Dgroups="$tag"` : `${r.base} -Dgroups="$tag"`;
  if (!maven) notes.push("Gradle has no built-in CLI flag for TestNG groups / JUnit tags; tag splitting assumes your build.gradle reads -Dgroups (useTestNG { includeGroups System.getProperty('groups') }).");

  // TestNG suite-level splitting
  const suites = profile.testngSuites.filter((s) => !s.includes("${"));
  const buildText = profile.buildFiles.map((f) => safeRead(profile.repoPath, f)).join("\n");
  const suiteProp = (buildText.match(/<suiteXmlFile>\s*\$\{([\w.-]+)\}\s*<\/suiteXmlFile>/) || [])[1];
  r.discovery.suite = `grep -rlE --include='*.xml' '<suite[[:space:]>]' . | grep -v -e '/target/' -e 'pom.xml' | sed 's#^\\./##'`;
  r.matrixValues.suite = suites;
  if (suiteProp) r.suiteRunner = `${r.base} -D${suiteProp}="$test"`;
  else {
    r.suiteRunner = `${r.base} -Dsurefire.suiteXmlFiles="$test"`;
    if (/<suiteXmlFile>/.test(buildText)) notes.push("pom.xml hard-codes <suiteXmlFile>; the CLI -Dsurefire.suiteXmlFiles is ignored in that case. Change it to <suiteXmlFile>${suiteXmlFile}</suiteXmlFile> for suite-level splitting.");
  }

  if (fw === "testng") r.partialReports = { location: maven ? "target/surefire-reports/html" : "build/reports/tests/test", type: "html", frameworkName: "testng" };
  else r.partialReports = { location: maven ? "target/surefire-reports/" : "build/test-results/test/", type: "xml", frameworkName: "junit" };
  if (profile.reports.includes("extent")) {
    const out = findExtentOut(profile);
    notes.push(`ExtentReports detected${out ? ` (output: ${out})` : ""}. You can switch partialReports to { frameworkName: extent, type: html, location: <extent output dir> } for the Extent view.`);
  }
  r.uploadArtefacts.push({ name: "Reports", path: [maven ? "target/surefire-reports/**" : "build/reports/**"] });
  if (profile.reports.includes("extent")) r.uploadArtefacts.push({ name: "ExtentReports", path: [(findExtentOut(profile) || "test-output") + "/**"] });
  return r;
}

function nodeRecipe(profile, fw, opts) {
  const notes = [];
  const r = { env: {}, notes, discovery: {}, matrixValues: {}, uploadArtefacts: [] };
  const cd = profile.packageRoot ? `cd ${profile.packageRoot} && ` : "";
  const installRoot = profile.installRoot ?? profile.packageRoot;
  const icd = installRoot ? `cd ${installRoot} && ` : "";
  const pm = profile.packageManager;
  const install =
    pm === "yarn" ? "yarn install --frozen-lockfile" :
    pm === "pnpm" ? "npm install -g pnpm && pnpm install --frozen-lockfile" :
    profile.lockFile ? "npm ci" : "npm install";
  r.pre = [`${icd}${install}`];
  r.cacheKey = `{{ checksum "${profile.lockFile || path.posix.join(installRoot || "", "package.json")}" }}`;
  r.cacheDirectories = [path.posix.join(installRoot || "", "node_modules")];
  if (profile.monorepo) notes.push(`Workspace monorepo: dependencies install at the repo root; tests run from ${profile.packageRoot || "the root"}/.`);
  // Env vars the package's test script sets inline (cross-env FOO=bar …)
  const script = (profile.testScripts || []).find((t) => Object.keys(t.env).length);
  if (script) Object.assign(r.env, script.env);
  r.runtime = { language: "node", version: String(profile.runtimeVersion || "20") };
  const specFind = (dir, pattern) => `find ${dir || "."} -type f ${pattern} -not -path '*/node_modules/*' | sed 's#^\\./##'`;
  const specPat = `\\( -name '*.spec.*' -o -name '*.test.*' \\)`;
  const files = profile.tests.files.map((f) => (profile.packageRoot ? f.slice(profile.packageRoot.length + 1) : f));
  r.matrixValues.file = files;

  switch (fw) {
    case "playwright":
      {
        const isDefaultCfg = !profile.configFile || /^playwright\.config\.[mc]?[jt]s$/.test(profile.configFile);
        const cfgArg = isDefaultCfg ? "" : ` --config=${profile.configFile}`;
        const proj = opts.extraMatrix?.project ? ' --project="$project"' : "";
        r.pre.push(`${cd}npx playwright install --with-deps`);
        r.discovery.file = `${cd}${specFind(profile.testDir, specPat)}`;
        r.runner = () => `${cd}npx playwright test${cfgArg}${proj} "$test"`;
        r.tagRunner = `${cd}npx playwright test${cfgArg}${proj} --grep "$tag"`;
        if (cfgArg) notes.push(`Using ${profile.configFile} (from the package's test script) — Playwright only reads playwright.config.* by default.`);
        if ((profile.playwrightProjects || []).length > 1 && !proj) notes.push(`playwright config has ${profile.playwrightProjects.length} projects (${profile.playwrightProjects.join(", ")}); every task runs all of them. To spread them over VMs pass extraMatrix {"project": [${profile.playwrightProjects.map((x) => `"${x}"`).join(", ")}]}.`);
        if (profile.playwrightWorkers > 2) notes.push(`The config sets workers: ${profile.playwrightWorkers}; add --workers=1 (or 2) to the runner on HyperExecute — parallelism comes from concurrency.`);
      }
      r.matrixValues.tag = grepTags(profile, /@[\w-]+/g);
      r.uploadArtefacts.push({ name: "PlaywrightReport", path: ["playwright-report/**", "test-results/**"] });
      if (profile.grid.usesLambdaTestHub) notes.push("Tests connect to LambdaTest via CDP (wss://cdp.lambdatest.com). That works from HyperExecute, but running browsers locally on the VM is usually faster.");
      break;
    case "cypress":
      {
        // Cypress <10 keeps specs in cypress/integration with any name; 10+ uses *.cy.* files
        const legacy = files.some((f) => f.startsWith("cypress/integration/")) || parseInt(String(profile.dependencies.cypress || "").replace(/[^\d.]/g, ""), 10) < 10;
        r.discovery.file = legacy
          ? `${cd}${specFind("cypress/integration", `\\( -name '*.js' -o -name '*.ts' -o -name '*.jsx' -o -name '*.tsx' -o -name '*.feature' \\)`)}`
          : `${cd}${specFind("cypress", `\\( -name '*.cy.js' -o -name '*.cy.ts' -o -name '*.cy.jsx' -o -name '*.cy.tsx' \\)`)}`;
      }
      r.runner = () => `${cd}npx cypress run --spec "$test"`;
      r.tagRunner = `${cd}npx cypress run --env grepTags="$tag"`;
      r.uploadArtefacts.push({ name: "CypressArtifacts", path: ["cypress/videos/**", "cypress/screenshots/**", "mochawesome-report/**", "cypress/reports/**"] });
      notes.push("Tag splitting for Cypress assumes @cypress/grep is installed.");
      break;
    case "webdriverio": {
      const cfg = profile.configFile || "wdio.conf.js";
      {
        const dirs = [...new Set(files.map((f) => path.posix.dirname(f)))];
        const common = dirs.length ? dirs.reduce((a, b2) => { const x = a.split("/"), y = b2.split("/"); let i = 0; while (i < x.length && x[i] === y[i]) i++; return x.slice(0, i).join("/"); }) : "";
        r.discovery.file = `${cd}${specFind(common || "test", `\\( -name '*.js' -o -name '*.ts' \\)${common ? "" : " -path '*spec*'"}`)}`;
      }
      r.runner = () => `${cd}npx wdio run ${cfg} --spec "$test"`;
      r.tagRunner = `${cd}npx wdio run ${cfg} --mochaOpts.grep "$tag"`;
      r.uploadArtefacts.push({ name: "Reports", path: ["reports/**", "allure-results/**"] });
      notes.push(`Check the discovery command matches your wdio \`specs\` glob (from ${cfg}).`);
      break;
    }
    case "cucumber-js": {
      const featRoot = profile.featureRoot || "features";
      r.discovery.feature = `${cd}find ${featRoot} -type f -name '*.feature'`;
      r.discovery.scenario = `${cd}grep -rnE '^[[:space:]]*Scenario( Outline| Template)?:' ${featRoot} --include='*.feature' | awk -F: '{print $1":"$2}'`;
      r.discovery.tag = `${cd}`+`grep -rhoE '(^|[[:space:]])@[A-Za-z0-9_-]+' ${featRoot} --include='*.feature' | sed -E 's/^[[:space:]]*//' | sort -u`;
      r.runner = () => `${cd}npx cucumber-js "$test" --format json:reports/cucumber-$RANDOM.json`;
      r.tagRunner = `${cd}npx cucumber-js --tags "$tag" --format json:reports/cucumber-$RANDOM.json`;
      r.matrixValues.feature = profile.tests.features;
      r.matrixValues.scenario = profile.tests.scenarios;
      r.matrixValues.tag = profile.tests.tags;
      r.partialReports = { location: "reports/", type: "json", frameworkName: "cucumber" };
      r.uploadArtefacts.push({ name: "Reports", path: ["reports/**"] });
      break;
    }
    case "nightwatch":
      r.discovery.file = `${cd}${specFind("tests", `-name '*.js'`)}`;
      r.runner = () => `${cd}npx nightwatch "$test"`;
      r.tagRunner = `${cd}npx nightwatch --tag "$tag"`;
      r.uploadArtefacts.push({ name: "Reports", path: ["tests_output/**"] });
      break;
    case "testcafe":
      r.discovery.file = `${cd}${specFind(".", specPat)}`;
      r.runner = () => `${cd}npx testcafe chrome:headless "$test"`;
      r.tagRunner = `${cd}npx testcafe chrome:headless . --test-meta tag="$tag"`;
      break;
    case "jest":
      r.discovery.file = `${cd}${specFind(".", specPat)}`;
      r.runner = () => `${cd}npx jest "$test"`;
      r.tagRunner = `${cd}npx jest -t "$tag"`;
      break;
    default: // mocha & others
      r.discovery.file = `${cd}${specFind(".", specPat)}`;
      r.runner = () => `${cd}npx mocha "$test"`;
      r.tagRunner = `${cd}npx mocha --grep "$tag"`;
  }
  if (!r.matrixValues.tag) r.matrixValues.tag = profile.tests.tags;
  return r;
}

function pythonRecipe(profile, fw, opts) {
  const notes = [];
  const win = opts.runson.startsWith("win");
  const py = win ? "python" : "python3";
  const r = { env: {}, notes, discovery: {}, matrixValues: {}, uploadArtefacts: [] };
  const req = profile.requirementsFile;
  const extras = profile.pythonTestExtras || [];
  r.pre = [
    req ? `pip3 install -r ${req} --cache-dir pip_cache` :
    profile.poetry ? `pip3 install poetry --cache-dir pip_cache && poetry config virtualenvs.create false && poetry install --no-interaction${(profile.poetryGroups || []).length ? " --with " + profile.poetryGroups.join(",") : ""}` :
    extras.length ? `pip3 install -e ".[${extras.join(",")}]" --cache-dir pip_cache` :
    `pip3 install -e . --cache-dir pip_cache`,
  ];
  if (!req && profile.poetry) notes.push("Installed with Poetry into the VM's Python (virtualenvs.create false), so python3 -m pytest sees the packages.");
  if (!req && !profile.poetry && extras.length) notes.push(`No requirements file — installing the project with its test extras [${extras.join(",")}] from pyproject.toml.`);
  if (profile.drivers.includes("playwright")) r.pre.push(`${py} -m playwright install`);
  r.cacheKey = `{{ checksum "${req || (profile.poetry && fs.existsSync(path.join(profile.repoPath, "poetry.lock")) ? "poetry.lock" : profile.buildFiles[0]) || "requirements.txt"}" }}`;
  r.cacheDirectories = ["pip_cache"];
  if (profile.runtimeVersion) r.runtime = { language: "python", version: String(profile.runtimeVersion) };
  const exclude = `-not -path '*/venv/*' -not -path '*/.venv/*' -not -path '*/site-packages/*'`;

  if (fw === "robot") {
    r.discovery.file = `grep -rlE --include='*.robot' '^\\*\\*\\*[[:space:]]*Test Cases' . | sed 's#^\\./##'`;
    r.runner = () => `${py} -m robot --outputdir robot-results "$test"`;
    r.tagRunner = `${py} -m robot --outputdir robot-results --include "$tag" .`;
    r.matrixValues.file = profile.tests.files;
    r.uploadArtefacts.push({ name: "RobotResults", path: ["robot-results/**"] });
    notes.push("Robot writes output.xml/log.html/report.html into robot-results/; mergeArtifacts combines them per task.");
    return r;
  }
  if (fw === "behave") {
    const featRoot = profile.featureRoot || "features";
    r.discovery.feature = `find ${featRoot} -type f -name '*.feature'`;
    r.discovery.scenario = `grep -rnE '^[[:space:]]*Scenario( Outline| Template)?:' ${featRoot} --include='*.feature' | awk -F: '{print $1":"$2}'`;
    r.discovery.tag = `grep -rhoE '(^|[[:space:]])@[A-Za-z0-9_-]+' ${featRoot} --include='*.feature' | sed -E 's/^[[:space:]]*//' | sort -u`;
    r.runner = () => `${py} -m behave "$test" -f json.pretty -o reports/behave-$RANDOM.json -f pretty`;
    r.tagRunner = `${py} -m behave --tags="$tag" -f json.pretty -o reports/behave-$RANDOM.json -f pretty`;
    r.matrixValues.feature = profile.tests.features;
    r.matrixValues.scenario = profile.tests.scenarios;
    r.matrixValues.tag = profile.tests.tags;
    r.uploadArtefacts.push({ name: "Reports", path: ["reports/**"] });
    return r;
  }
  // pytest
  const xdistOff = /(^|\s)-n\s*\S+|--numprocesses/.test(profile.pytestAddopts || "") ? " -n 0" : "";
  const tpaths = (profile.pytestTestpaths || []).filter((d) => fs.existsSync(path.join(profile.repoPath, d)));
  const where = tpaths.length ? tpaths.join(" ") : ".";
  if (profile.pytestByContent) notes.push("Test files don't follow test_*.py naming; discovery finds files that define test functions (pytest collects them when passed explicitly).");
  r.discovery.file = profile.pytestByContent
    ? `grep -rlE --include='*.py' '^[[:space:]]*(async[[:space:]]+)?def[[:space:]]+test' ${where} | grep -vE '(^|/)(conftest|setup)\\.py$|/(venv|\\.venv|site-packages)/' | sed 's#^\\./##'`
    : `find ${where} -type f \\( -name 'test_*.py' -o -name '*_test.py' \\) ${exclude} | sed 's#^\\./##'`;
  r.discovery.method =
    `find ${where} -type f \\( -name 'test_*.py' -o -name '*_test.py' \\) ${exclude} | sed 's#^\\./##' | while read f; do ` +
    `awk -v f="$f" '/^class[ \\t]+Test/{c=$2; sub(/[(:].*/,"",c); next} /^[^ \\t#@]/{c=""} /^[ \\t]*(async[ \\t]+)?def[ \\t]+test/{s=$0; sub(/.*def[ \\t]+/,"",s); sub(/\\(.*/,"",s); if (c!="" && $0 ~ /^[ \\t]/) print f"::"c"::"s; else if ($0 !~ /^[ \\t]/) print f"::"s}' "$f"; done`;
  r.runner = () => `${py} -m pytest "$test"${xdistOff} --junitxml=reports/junit-$RANDOM.xml`;
  r.tagRunner = `${py} -m pytest -m "$tag"${xdistOff} --junitxml=reports/junit-$RANDOM.xml`;
  if (xdistOff) notes.push(`pytest addopts ("${profile.pytestAddopts}") turns on xdist; the runner adds -n 0 so each VM runs its share without extra workers — parallelism comes from concurrency.`);
  if (tpaths.length) notes.push(`Discovery is limited to pytest testpaths: ${tpaths.join(", ")}.`);
  r.matrixValues.file = profile.tests.files;
  r.matrixValues.method = profile.tests.functions;
  r.matrixValues.tag = profile.tests.markers;
  r.partialReports = { location: "reports/", type: "xml", frameworkName: "junit" };
  r.uploadArtefacts.push({ name: "Reports", path: ["reports/**"] });
  if (profile.dependencies.xdist && !xdistOff) notes.push("pytest-xdist is installed — don't pass -n on HyperExecute; parallelism comes from `concurrency`.");
  return r;
}

function dotnetRecipe(profile, fw, opts) {
  const notes = [];
  const r = { env: { NUGET_PACKAGES: "nuget_cache" }, notes, discovery: {}, matrixValues: {}, uploadArtefacts: [] };
  const proj = profile.buildFiles.find((f) => f.endsWith(".sln")) || profile.buildFiles.find((f) => f.endsWith(".csproj")) || "";
  r.pre = [`dotnet restore ${proj}`.trim(), `dotnet build ${proj} --no-restore`.trim()];
  r.cacheKey = `{{ checksum "${profile.buildFiles.find((f) => f.endsWith(".csproj")) || proj}" }}`;
  r.cacheDirectories = ["nuget_cache"];
  if (profile.runtimeVersion) r.runtime = { language: "dotnet", version: String(profile.runtimeVersion) };
  const base = `dotnet test ${proj} --no-build --logger "trx;LogFileName=results-$RANDOM.trx" --results-directory TestResults`.replace("  ", " ");
  r.discovery.class =
    `grep -rlE --include='*.cs' '\\[(Test|TestCase|Fact|Theory|TestMethod)' . | grep -v -e '/bin/' -e '/obj/' | ` +
    `xargs awk 'FNR==1{ns="";d=0} /^[[:space:]]*namespace[[:space:]]/{ns=$2; gsub(/[;{]/,"",ns)} !d && /(^|[[:space:]])class[[:space:]]/{for(i=1;i<NF;i++) if($i=="class"){c=$(i+1); gsub(/[^A-Za-z0-9_].*/,"",c); print (ns!=""?ns".":"") c; d=1; break}}'`;
  r.runner = () => `${base} --filter "FullyQualifiedName~$test."`;
  r.tagRunner = `${base} --filter "TestCategory=$tag"`;
  if (fw === "specflow") r.discovery.tag = `grep -rhoE '(^|[[:space:]])@[A-Za-z0-9_-]+' . --include='*.feature' | sed -E 's/^[[:space:]]*@//' | sort -u`;
  r.matrixValues.class = profile.tests.classes.map((c) => c.className);
  r.matrixValues.tag = [...new Set([...profile.tests.classes.flatMap((c) => c.categories || []), ...profile.tests.tags.map((t) => t.replace(/^@/, ""))])];
  r.matrixValues.none = ["all"];
  r.noneRunner = base;
  r.uploadArtefacts.push({ name: "TestResults", path: ["TestResults/**"] });
  if (fw === "specflow") notes.push("SpecFlow/Reqnroll: feature scenarios are generated at build time, so splitting defaults to tags (TestCategory). Use split 'none' to run everything in one task.");
  if (profile.reports.includes("extent")) notes.push("ExtentReports detected — add its output folder to uploadArtefacts / partialReports (frameworkName: extent).");
  return r;
}

function safeRead(root, rel) {
  try {
    return fs.readFileSync(path.join(root, rel), "utf8");
  } catch {
    return "";
  }
}

function findCucumberJson(profile) {
  for (const r of profile.cucumberRunners) {
    const m = safeRead(profile.repoPath, r.file).match(/"json:([^"]+)"/);
    if (m) return path.posix.dirname(m[1]) + "/";
  }
  const props = safeRead(profile.repoPath, "src/test/resources/cucumber.properties") + safeRead(profile.repoPath, "src/test/resources/junit-platform.properties");
  const m = props.match(/json:([^\s,]+)/);
  return m ? path.posix.dirname(m[1]) + "/" : null;
}

function findExtentOut(profile) {
  const p = safeRead(profile.repoPath, "src/test/resources/extent.properties");
  const m = p.match(/extent\.reporter\.spark\.out\s*=\s*(\S+)/);
  return m ? path.posix.dirname(m[1]) : null;
}

function grepTags(profile, re) {
  return profile.tests.tags;
}

// ---------- YAML v0.2 (framework field; HyperExecute runner does discovery) ----------
// Source: Confluence HYP "Yaml version 0.2" + "Java runners" + ".NET runners" pages.

const V02_REMOTE_ONLY = /^(gradle\/|maven\/spock|dotnet\/)/;

export function v02FrameworkName(profile, fw) {
  if (profile.language === "java" && ["testng", "junit4", "junit5", "spock"].includes(fw)) return `${profile.buildTool === "gradle" ? "gradle" : "maven"}/${fw}`;
  if (profile.language === "csharp" && ["nunit", "mstest"].includes(fw)) return `dotnet/${fw}`;
  return null;
}

function generateV02(profile, fw, name, opts) {
  const notes = [];
  const warnings = [...profile.warnings.filter((w) => !w.includes("bypasses suite XML"))];
  const win = opts.runson.startsWith("win");
  const split = opts.splitBy || "class";
  const discoveryType = { method: "method", class: "class", suite: "xmltest" }[split];
  if (!discoveryType) throw new Error(`splitBy "${split}" isn't available in YAML v0.2 (method | class | suite). Use yamlVersion "0.1" for ${split}.`);
  if (discoveryType === "xmltest" && fw !== "testng") throw new Error("splitBy suite (discoveryType xmltest) is TestNG-only.");

  const framework = { name, discoveryMode: opts.discoveryMode || "remote", discoveryType };
  if (framework.discoveryMode === "local" && V02_REMOTE_ONLY.test(name)) throw new Error(`${name} only supports remote discovery.`);
  const doc = {
    version: "0.2",
    globalTimeout: opts.globalTimeout,
    testSuiteTimeout: opts.testSuiteTimeout,
    testSuiteStep: opts.testSuiteStep,
    runson: opts.runson,
    autosplit: true,
    retryOnFailure: opts.retryOnFailure,
  };
  if (opts.retryOnFailure) doc.maxRetries = opts.maxRetries;
  doc.concurrency = opts.concurrency;

  let pre = [];
  let uploads = [];
  let partialReports;
  if (profile.language === "java") {
    const maven = name.startsWith("maven/");
    if (maven) {
      const mvn = profile.hasMavenWrapper && !win ? "./mvnw" : "mvn";
      pre = [`${mvn} dependency:resolve`];
      if (mvn !== "mvn") framework.baseCommand = `${mvn} test`;
      uploads = [{ name: "Reports", path: ["target/surefire-reports/**"] }];
      partialReports = fw === "testng" ? { location: "target/surefire-reports/html", type: "html", frameworkName: "testng" } : { location: "target/surefire-reports/", type: "xml", frameworkName: "junit" };
    } else {
      if (profile.hasGradleWrapper) framework.baseCommand = win ? "gradlew.bat test" : "./gradlew test";
      uploads = [{ name: "Reports", path: ["build/reports/**", "build/test-results/**"] }];
      notes.push("Gradle v0.2 runners need Gradle 7.0+, JDK 8+ and the java plugin (groovy for Spock). For a custom Test task set baseCommand to the full command, e.g. ./gradlew integrationTest.");
    }
    if (opts.groups) framework.discoveryFlags = [`-Dgroups=${opts.groups}`];
    if (discoveryType === "xmltest") notes.push("discoveryType xmltest shards one unit per <test> in your TestNG suite XML — suite parameters and listeners are preserved.");
    if (fw === "spock" && maven) notes.push("maven/spock runs on the JUnit 5 Surefire provider — requires Spock 2.x / JUnit Platform.");
    if (profile.runtimeVersion) doc.runtime = { language: "java", version: String(profile.runtimeVersion) };
  } else {
    // The runner refuses when the repo root resolves to several .csproj files, so pin the test project whenever there is more than one.
    const multi = profile.buildFiles.filter((f) => f.endsWith(".csproj")).length > 1;
    const sln = profile.buildFiles.find((f) => f.endsWith(".sln"));
    pre = [`dotnet restore${sln ? " " + sln : ""}`, `dotnet build${sln ? " " + sln : ""} -c Release --no-restore`];
    if (multi) {
      const proj = profile.testProjects?.[0] || profile.buildFiles.find((f) => f.endsWith(".csproj"));
      framework.flags = ["--project", proj];
      notes.push(`Several .csproj files found — pointing the runner at ${proj}. Change --project if the tests live elsewhere.`);
    }
    if (profile.playwrightDotnetVersion && !opts.runson.startsWith("linux")) {
      pre.unshift(`npm install playwright@${profile.playwrightDotnetVersion} --save-exact`);
      notes.push("Playwright CDP on win/mac workers needs a worker-local playwright matching Microsoft.Playwright — added to pre.");
    }
    if (profile.drivers.includes("selenium")) {
      doc.idleTimeout = 900;
      notes.push("idleTimeout: 900 keeps the idle monitor from killing quiet Selenium shards. Concurrent grid sessions = NUnit LevelOfParallelism × concurrency.");
    }
    if (profile.runtimeVersion) {
      if (parseFloat(profile.runtimeVersion) < 5) warnings.push(`Target framework ${profile.runtimeVersion} is EOL — v0.2 .NET runners need net5.0+ (UNSUPPORTED_TFM_OR_RUNTIME).`);
      doc.runtime = { language: "dotnet", version: /\./.test(profile.runtimeVersion) ? profile.runtimeVersion : `${profile.runtimeVersion}.0` };
    }
    uploads = [{ name: "TestResults", path: ["TestResults/**"] }];
  }
  if (profile.language === "java" && profile.projectRoot) {
    const pr = profile.projectRoot;
    framework.workingDirectory = pr;
    pre = pre.map((c) => `cd ${pr} && ${c}`);
    uploads = uploads.map((a) => ({ ...a, path: a.path.map((p) => path.posix.join(pr, p)) }));
    if (partialReports) partialReports.location = path.posix.join(pr, partialReports.location);
    notes.push(`The Java project lives in ${pr}/ — set as framework.workingDirectory.`);
  }
  if (opts.includeRuntime === false) delete doc.runtime;
  if (opts.mavenProfile && profile.buildTool !== "gradle") {
    framework.flags = [...(framework.flags || []), `-P${opts.mavenProfile}`];
    pre = pre.map((c) => c.replace(/dependency:resolve/, `dependency:resolve -P${opts.mavenProfile}`));
  }
  if (opts.flags?.length) framework.flags = [...(framework.flags || []), ...opts.flags];

  const env = buildEnv(profile, {}, opts, notes);
  if (Object.keys(env).length) doc.env = env;
  if (opts.tunnel) doc.tunnel = true;
  doc.pre = [...pre, ...(opts.extraPre || [])];
  doc.post = opts.post || ["ls -la"];
  doc.framework = framework;
  doc.mergeArtifacts = true;
  doc.uploadArtefacts = uploads;
  if (partialReports) {
    doc.report = true;
    doc.partialReports = partialReports;
  }
  doc.jobLabel = opts.jobLabel || [fw, opts.runson, "v0.2"];
  notes.push("v0.2: caching of ~/.m2 / ~/.gradle/caches / ~/.nuget/packages is automatic (setting both cacheKey and cacheDirectories disables it). Never add a testDiscovery block — it silently routes to v0.1 and runs 0 tests.");
  return { doc, notes, warnings, split, framework: fw };
}

function buildEnv(profile, base, opts, notes) {
  const env = { ...base };
  // With a saved account its values go in directly; otherwise secret references are filled at run time
  // (see credentials.runtimeConfig), so the VMs reach the grid without secrets created in the portal.
  const creds = embeddedCredentials(opts);
  env.LT_USERNAME = creds ? creds.username : "${{ .secrets.LT_USERNAME }}";
  env.LT_ACCESS_KEY = creds ? creds.accessKey : "${{ .secrets.LT_ACCESS_KEY }}";
  for (const v of profile.envVars) {
    if (env[v]) continue;
    env[v] = SECRET_LIKE.test(v) ? `\${{ .secrets.${v} }}` : `<set ${v}>`;
  }
  Object.assign(env, opts.extraEnv || {});
  const secrets = Object.entries(env).filter(([, v]) => String(v).includes(".secrets.")).map(([k]) => k).filter((k) => !["LT_USERNAME", "LT_ACCESS_KEY"].includes(k));
  notes.push(creds
    ? `LT_USERNAME / LT_ACCESS_KEY are your saved LambdaTest account (${creds.username}). The file contains your access key — don't commit it to a shared repo or send it to a customer. (Turn off with embedCredentials: false to use \${{ .secrets.* }} references instead.)`
    : "LT_USERNAME / LT_ACCESS_KEY are filled from your saved LambdaTest account when the Studio or MCP runs the job — no portal secrets needed. Save your account once (Studio Setup card or set_lambdatest_credentials) and new YAMLs contain it directly.");
  if (secrets.length) notes.push(`Create these secrets in HyperExecute (Settings → Secrets) before running: ${secrets.join(", ")}.`);
  const placeholders = Object.entries(env).filter(([, v]) => String(v).startsWith("<set ")).map(([k]) => k);
  if (placeholders.length) notes.push(`Fill in values for env vars your code reads: ${placeholders.join(", ")} (remove any that aren't needed).`);
  return env;
}

function render(profile, doc, meta, opts) {
  const header = [
    `HyperExecute YAML generated for: ${path.basename(profile.repoPath)}`,
    `Framework: ${meta.framework} | Language: ${profile.language} | Build: ${profile.buildTool || profile.packageManager || "-"}`,
    `YAML ${doc.version} | Mode: ${meta.mode} | Split by: ${meta.split}`,
    `Run: ./hyperexecute --user "$LT_USERNAME" --key "$LT_ACCESS_KEY" --config ${opts.outputFileName || "hyperexecute.yaml"}`,
  ];
  const body = YAML.stringify(doc, { lineWidth: 0, defaultStringType: "PLAIN", defaultKeyType: "PLAIN" });
  return `---\n${header.map((h) => `# ${h}`).join("\n")}\n\n${body}`;
}

// ---------- assembly ----------

export function generateYaml(profile, options = {}) {
  const opts = {
    runson: "linux",
    executionMode: "autosplit",
    concurrency: 5,
    retryOnFailure: true,
    maxRetries: 1,
    globalTimeout: 90,
    testSuiteTimeout: 90,
    testSuiteStep: 90,
    jobLabel: null,
    tunnel: false,
    extraMatrix: null,
    extraEnv: {},
    ...Object.fromEntries(Object.entries(options).filter(([, v]) => v !== undefined && v !== null)),
  };
  const fw = pickFramework(profile, opts.framework);
  const family = familyOf(fw);
  if (!family) throw new Error(`Unsupported or undetected framework "${fw}". Detected: ${JSON.stringify(profile.frameworks)}. Pass framework explicitly (e.g. testng, junit5, cucumber, playwright, cypress, webdriverio, pytest, behave, robot, nunit).`);

  // YAML version: v0.2 (framework field) where HyperExecute has a native runner and no v0.1-only feature is requested.
  const v02Name = v02FrameworkName(profile, fw);
  const needsV01 = opts.executionMode === "matrix" || opts.runsonMatrix || opts.extraMatrix || opts.discoveryCommand || opts.runnerCommand || opts.matrixValues || ["tag", "none", "file", "feature", "scenario"].includes(opts.splitBy);
  const version = opts.yamlVersion && opts.yamlVersion !== "auto" ? opts.yamlVersion : v02Name && !needsV01 ? "0.2" : "0.1";
  if (version === "0.2") {
    if (!v02Name) throw new Error(`YAML v0.2 has no native runner for ${fw} (${profile.language}). Supported: maven|gradle /testng|junit4|junit5|spock, dotnet/nunit|mstest. Use yamlVersion "0.1".`);
    if (needsV01) throw new Error("YAML v0.2 doesn't support matrix mode, custom discovery/runner commands or tag/file/feature splitting. Use yamlVersion \"0.1\".");
    const r = generateV02(profile, fw, v02Name, opts);
    return { yaml: render(profile, r.doc, { framework: fw, mode: "autosplit (native discovery)", split: r.split }, opts), yamlVersion: "0.2", framework: fw, splitBy: r.split, executionMode: "autosplit", supportedSplits: fw === "testng" ? ["class", "method", "suite"] : ["class", "method"], notes: r.notes, warnings: r.warnings };
  }

  const lang = family.startsWith("java") ? "java" : family.startsWith("node") ? "node" : ["pytest", "behave", "robot"].includes(family) ? "python" : "dotnet";
  const recipe = { java: javaRecipe, node: nodeRecipe, python: pythonRecipe, dotnet: dotnetRecipe }[lang](profile, fw, opts);

  let split = opts.splitBy || SPLITS[family][0];
  // Tags are a fixed list → matrix, unless autosplit was asked for and the tags can be discovered from files
  const tagAutosplit = split === "tag" && options.executionMode === "autosplit" && recipe.discovery.tag;
  if (split === "tag" && opts.executionMode === "autosplit" && !tagAutosplit) opts.executionMode = "matrix";
  if (split === "none") opts.executionMode = "matrix";
  if (!SPLITS[family].includes(split)) throw new Error(`splitBy "${split}" not supported for ${fw}. Options: ${SPLITS[family].join(", ")}`);
  const notes = [...recipe.notes];
  const warnings = [...profile.warnings];

  // runner
  let runner = tagAutosplit ? recipe.tagRunner.replace(/\$tag/g, "$test") : split === "tag" ? recipe.tagRunner : split === "suite" ? recipe.suiteRunner : split === "none" ? recipe.noneRunner : recipe.runner(split);
  if (opts.runnerCommand) runner = opts.runnerCommand;

  const doc = {
    version: 0.1,
    globalTimeout: opts.globalTimeout,
    testSuiteTimeout: opts.testSuiteTimeout,
    testSuiteStep: opts.testSuiteStep,
    runson: opts.executionMode === "matrix" && Array.isArray(opts.runsonMatrix) ? "${matrix.os}" : opts.runson,
  };

  if (opts.executionMode === "autosplit") {
    doc.autosplit = true;
  }
  doc.retryOnFailure = opts.retryOnFailure;
  if (opts.retryOnFailure) doc.maxRetries = opts.maxRetries;
  doc.concurrency = opts.concurrency;
  if (recipe.runtime && opts.includeRuntime !== false) doc.runtime = recipe.runtime;

  // env: detected vars + secrets
  const env = buildEnv(profile, recipe.env, opts, notes);
  if (Object.keys(env).length) doc.env = env;

  if (opts.tunnel) {
    doc.tunnel = true;
    notes.push("tunnel: true — HyperExecute will start a LambdaTest tunnel so tests can reach internal/staging URLs.");
  }

  doc.cacheKey = recipe.cacheKey;
  doc.cacheDirectories = recipe.cacheDirectories;
  doc.pre = [...recipe.pre, ...(opts.extraPre || [])];
  doc.post = opts.post || ["ls -la"];

  if (opts.executionMode === "autosplit") {
    const cmd = opts.discoveryCommand || recipe.discovery[split];
    if (!cmd) throw new Error(`No discovery command for split "${split}" with ${fw}`);
    doc.testDiscovery = { type: "raw", mode: opts.discoveryMode || (opts.runson.startsWith("win") ? "local" : "remote"), command: cmd };
    doc.testRunnerCommand = runner;
  } else {
    const key = split === "tag" ? "tag" : "test";
    let values = opts.matrixValues || recipe.matrixValues[split] || [];
    if (split === "tag" && values.length === 0) warnings.push("No tags/groups/markers were detected — fill in matrix.tag manually.");
    if (!values.length) values = [`<add ${split}s here>`];
    doc.matrix = {};
    if (Array.isArray(opts.runsonMatrix)) doc.matrix.os = opts.runsonMatrix;
    if (split !== "none") doc.matrix[key] = values;
    if (opts.extraMatrix) Object.assign(doc.matrix, opts.extraMatrix);
    if (!Object.keys(doc.matrix).length) doc.matrix.run = ["all"];
    if (split !== "tag") runner = runner.replace(/\$test/g, `$${key}`);
    doc.testSuites = [runner];
    if (opts.extraMatrix) notes.push(`Matrix keys ${Object.keys(opts.extraMatrix).join(", ")} are exposed to tests as environment variables — read them in your capabilities/driver setup.`);
  }

  doc.mergeArtifacts = true;
  doc.uploadArtefacts = recipe.uploadArtefacts;
  if (recipe.partialReports) {
    doc.report = true;
    doc.partialReports = recipe.partialReports;
  }
  doc.jobLabel = opts.jobLabel || [fw, opts.runson, opts.executionMode === "autosplit" ? "autosplit" : "matrix"];

  const yamlText = render(profile, doc, { framework: fw, mode: opts.executionMode, split }, opts);

  if (lang === "java" && profile.grid.usesLocalDriver && !profile.grid.usesLambdaTestHub)
    notes.push("Tests instantiate local browser drivers. That works on HyperExecute VMs (browsers are pre-installed), but make sure headless/driver-manager settings suit a CI VM.");
  if (v02Name) notes.push(`${fw} also has a native YAML v0.2 runner (${v02Name}) with built-in discovery — pass yamlVersion "0.2" if you don't need v0.1 features.`);

  return { yaml: yamlText, yamlVersion: "0.1", framework: fw, splitBy: split, executionMode: opts.executionMode, supportedSplits: SPLITS[family], notes, warnings };
}
