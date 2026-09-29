// Static analysis of a test-automation repository.
// Produces a structured profile the generator uses to build a HyperExecute YAML.

import fs from "node:fs";
import path from "node:path";

const IGNORED_DIRS = new Set([
  "node_modules", ".git", "target", "build", "dist", "out", "bin", "obj",
  ".gradle", ".idea", ".vscode", "venv", ".venv", "env", "__pycache__",
  ".pytest_cache", ".mvn", "allure-results", "allure-report", "test-output",
  "playwright-report", "test-results", "coverage", ".next", ".cache", "reports",
]);
const MAX_FILES = 20000;
const MAX_READ_BYTES = 512 * 1024;

// ---------- file helpers ----------

function walk(root) {
  const files = [];
  const stack = [root];
  while (stack.length && files.length < MAX_FILES) {
    const dir = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (e.isDirectory()) {
        if (!IGNORED_DIRS.has(e.name) && !e.name.startsWith(".")) stack.push(path.join(dir, e.name));
      } else if (e.isFile()) {
        files.push(path.relative(root, path.join(dir, e.name)).split(path.sep).join("/"));
      }
    }
  }
  return files;
}

function read(root, rel) {
  try {
    const full = path.join(root, rel);
    if (fs.statSync(full).size > MAX_READ_BYTES) return "";
    return fs.readFileSync(full, "utf8");
  } catch {
    return "";
  }
}

const has = (text, re) => (typeof re === "string" ? text.includes(re) : re.test(text));
const uniq = (arr) => [...new Set(arr)];
const byExt = (files, ...exts) => files.filter((f) => exts.some((x) => f.endsWith(x)));
const byName = (files, name) => files.filter((f) => f === name || f.endsWith("/" + name));

// ---------- language-specific analysis ----------

function analyzeJava(root, allFiles, profile) {
  let files = allFiles;
  const poms = byName(files, "pom.xml");
  const gradles = files.filter((f) => /(^|\/)build\.gradle(\.kts)?$/.test(f));
  if (!poms.length && !gradles.length && !byExt(files, ".java").length) return;

  profile.language = "java";
  profile.buildTool = poms.length ? "maven" : gradles.length ? "gradle" : "unknown";
  profile.buildFiles.push(...poms, ...gradles);
  // Project may live in a sub-folder (monorepo): use the shallowest build file as the project root.
  const primary = [...poms, ...gradles].sort((x, y) => x.split("/").length - y.split("/").length || x.length - y.length)[0];
  profile.projectRoot = primary && primary.includes("/") ? path.posix.dirname(primary) : "";
  profile.primaryBuildFile = primary ? path.posix.basename(primary) : null;
  // Independent projects (build files not nested under the chosen root) are ignored, with a warning.
  const others = [...new Set([...poms, ...gradles].map((f) => path.posix.dirname(f)))].filter((d) => profile.projectRoot && d !== profile.projectRoot && !d.startsWith(profile.projectRoot + "/"));
  if (others.length) profile.warnings.push(`Several separate projects found; using ${profile.projectRoot}/. Others: ${others.slice(0, 5).join(", ")}${others.length > 5 ? "…" : ""}. Open the one you want as the repo folder to switch.`);
  const inProject = (f) => !profile.projectRoot || f.startsWith(profile.projectRoot + "/");
  files = files.filter(inProject);
  profile.hasMavenWrapper = files.includes("mvnw");
  profile.hasGradleWrapper = files.includes("gradlew");

  profile.buildFiles = profile.buildFiles.filter(inProject);
  const buildText = profile.buildFiles.map((f) => read(root, f)).join("\n");
  const deps = {
    testng: has(buildText, "org.testng") || has(buildText, "<artifactId>testng</artifactId>"),
    junit5: has(buildText, "junit-jupiter"),
    junit4: /<artifactId>junit<\/artifactId>|['"]junit:junit:/.test(buildText),
    cucumber: has(buildText, "io.cucumber") || has(buildText, "info.cukes"),
    selenium: has(buildText, "selenium-java") || has(buildText, "org.seleniumhq"),
    appium: has(buildText, "io.appium"),
    playwright: has(buildText, "com.microsoft.playwright"),
    serenity: has(buildText, "net.serenity-bdd"),
    karate: has(buildText, "com.intuit.karate") || has(buildText, "io.karatelabs"),
    spock: has(buildText, "org.spockframework"),
    restassured: has(buildText, "rest-assured"),
    extent: has(buildText, "extentreports"),
    allure: has(buildText, "io.qameta.allure"),
  };
  profile.dependencies = deps;

  const jv =
    buildText.match(/<maven\.compiler\.(?:release|source)>\s*([\d.]+)/) ||
    buildText.match(/<java\.version>\s*([\d.]+)/) ||
    buildText.match(/<release>\s*([\d.]+)<\/release>/) ||
    buildText.match(/sourceCompatibility\s*=\s*['"]?(?:JavaVersion\.VERSION_)?([\d._]+)/) ||
    buildText.match(/languageVersion\.set\(JavaLanguageVersion\.of\((\d+)\)/);
  if (jv) profile.runtimeVersion = jv[1].replace("_", ".").replace(/^1\.(\d+)$/, "$1");

  const cukeVer = buildText.match(/<groupId>io\.cucumber<\/groupId>\s*<artifactId>[^<]+<\/artifactId>\s*<version>([^<]+)</);
  if (cukeVer) profile.cucumberVersion = cukeVer[1];

  // Surefire suiteXmlFiles / TestNG suites
  const suiteRefs = [...buildText.matchAll(/<suiteXmlFile>([^<]+)<\/suiteXmlFile>/g)].map((m) => m[1].trim());
  const testngXmls = byExt(files, ".xml").filter((f) => !f.endsWith("pom.xml") && has(read(root, f), /<suite[\s>]/) && has(read(root, f), "testng"));
  profile.testngSuites = uniq([...testngXmls, ...suiteRefs.filter((s) => !s.includes("${"))]);

  // Test classes & methods
  const javaFiles = byExt(files, ".java");
  const testClasses = [];
  for (const f of javaFiles) {
    const src = read(root, f);
    if (!/@Test\b|@ParameterizedTest\b/.test(src)) continue;
    if (/\babstract\s+class\b/.test(src) && !/\n\s*public\s+(?:final\s+)?class/.test(src)) continue;
    const pkg = (src.match(/^\s*package\s+([\w.]+)\s*;/m) || [])[1];
    const cls = (src.match(/\bclass\s+(\w+)/) || [])[1] || path.basename(f, ".java");
    const methods = [];
    const re = /@(?:Test|ParameterizedTest)\b[^]*?\bvoid\s+(\w+)\s*\(/g;
    let m;
    while ((m = re.exec(src))) methods.push(m[1]);
    const groups = uniq([...src.matchAll(/groups\s*=\s*\{?([^})]+)/g)].flatMap((g) => [...g[1].matchAll(/"([^"]+)"/g)].map((x) => x[1])));
    const tags = uniq([...src.matchAll(/@Tag\(\s*"([^"]+)"\s*\)/g)].map((x) => x[1]));
    testClasses.push({ file: f, className: pkg ? `${pkg}.${cls}` : cls, simpleName: cls, methods, groups, tags });
  }
  profile.tests.classes = testClasses;

  // Cucumber runners
  profile.cucumberRunners = javaFiles
    .filter((f) => has(read(root, f), "@CucumberOptions") || has(read(root, f), "@Suite") && has(read(root, f), "IncludeEngines(\"cucumber\")"))
    .map((f) => {
      const src = read(root, f);
      const pkg = (src.match(/^\s*package\s+([\w.]+)\s*;/m) || [])[1];
      const cls = (src.match(/\bclass\s+(\w+)/) || [])[1];
      return { file: f, className: pkg ? `${pkg}.${cls}` : cls, simpleName: cls };
    });

  // Frameworks (ordered by specificity)
  if (deps.cucumber || byExt(files, ".feature").length) profile.frameworks.push("cucumber");
  if (deps.karate) profile.frameworks.push("karate");
  if (deps.testng) profile.frameworks.push("testng");
  if (deps.junit5) profile.frameworks.push("junit5");
  else if (deps.junit4) profile.frameworks.push("junit4");
  if (deps.spock) profile.frameworks.push("spock");
  if (deps.serenity) profile.frameworks.push("serenity");
  for (const k of ["selenium", "appium", "playwright", "restassured"]) if (deps[k]) profile.drivers.push(k);

  if (deps.extent) profile.reports.push("extent");
  if (deps.allure) profile.reports.push("allure");
  profile.reports.push(profile.buildTool === "gradle" ? "gradle-test-results" : "surefire");
}

function analyzeNode(root, files, profile) {
  const pkgFile = files.includes("package.json") ? "package.json" : byName(files, "package.json")[0];
  if (!pkgFile) return;
  let pkg;
  try {
    pkg = JSON.parse(read(root, pkgFile));
  } catch {
    return;
  }
  if (profile.language) return; // Java/Python repos sometimes carry a package.json for tooling
  profile.language = "node";
  profile.buildFiles.push(pkgFile);
  profile.packageRoot = path.posix.dirname(pkgFile) === "." ? "" : path.posix.dirname(pkgFile);
  profile.packageManager = files.includes("pnpm-lock.yaml") ? "pnpm" : files.includes("yarn.lock") ? "yarn" : "npm";
  profile.lockFile = ["package-lock.json", "yarn.lock", "pnpm-lock.yaml"].find((f) => files.includes(f)) || null;
  profile.scripts = pkg.scripts || {};
  if (pkg.engines?.node) profile.runtimeVersion = pkg.engines.node.replace(/[^\d.]/g, "").split(".")[0] || null;
  const nvmrc = read(root, ".nvmrc").trim();
  if (nvmrc) profile.runtimeVersion = nvmrc.replace(/^v/, "").split(".")[0];

  const all = { ...pkg.dependencies, ...pkg.devDependencies };
  const d = (n) => Object.prototype.hasOwnProperty.call(all, n);
  profile.dependencies = Object.fromEntries(Object.keys(all).map((k) => [k, all[k]]));

  if (d("@playwright/test")) profile.frameworks.push("playwright");
  if (d("cypress")) profile.frameworks.push("cypress");
  if (d("@wdio/cli") || d("webdriverio")) profile.frameworks.push("webdriverio");
  if (d("@cucumber/cucumber") || d("cucumber")) profile.frameworks.push("cucumber-js");
  if (d("nightwatch")) profile.frameworks.push("nightwatch");
  if (d("testcafe")) profile.frameworks.push("testcafe");
  if (d("jest")) profile.frameworks.push("jest");
  if (d("mocha")) profile.frameworks.push("mocha");
  if (d("selenium-webdriver")) profile.drivers.push("selenium");
  if (d("playwright") && !d("@playwright/test")) profile.drivers.push("playwright");
  if (d("puppeteer") || d("puppeteer-core")) profile.drivers.push("puppeteer");
  if (d("appium") || d("webdriverio") && files.some((f) => /appium/i.test(f))) profile.drivers.push("appium");
  if (d("mochawesome") || d("cypress-mochawesome-reporter")) profile.reports.push("mochawesome");
  if (d("allure-playwright") || d("allure-commandline") || d("@wdio/allure-reporter")) profile.reports.push("allure");
  if (d("jest-junit") || d("mocha-junit-reporter") || d("@wdio/junit-reporter")) profile.reports.push("junit-xml");

  // Test files per framework
  const specRe = /\.(spec|test)\.(m?[jt]sx?)$/;
  let tests = [];
  const fw = profile.frameworks[0];
  if (fw === "playwright") {
    const cfg = files.find((f) => /^playwright\.config\.[mc]?[jt]s$/.test(path.posix.basename(f)));
    profile.configFile = cfg || null;
    const testDir = cfg && (read(root, cfg).match(/testDir\s*:\s*['"`]([^'"`]+)['"`]/) || [])[1];
    profile.testDir = testDir ? testDir.replace(/^\.\//, "") : null;
    tests = files.filter((f) => specRe.test(f) && (!profile.testDir || f.startsWith(profile.testDir)));
    profile.reports.push("playwright-html");
  } else if (fw === "cypress") {
    profile.configFile = files.find((f) => /^cypress\.config\.[jt]s$|^cypress\.json$/.test(f)) || null;
    tests = files.filter((f) => /\.cy\.[jt]sx?$/.test(f) || (f.startsWith("cypress/integration/") && /\.[jt]s$/.test(f)));
  } else if (fw === "webdriverio") {
    profile.configFile = files.find((f) => /wdio.*\.conf\.[jt]s$/.test(f)) || null;
    tests = files.filter((f) => (specRe.test(f) || /\.e2e\.[jt]s$/.test(f) || /specs?\//.test(f) && /\.[jt]s$/.test(f)) && !f.includes("pageobjects"));
  } else if (fw === "cucumber-js") {
    tests = byExt(files, ".feature");
  } else if (fw === "nightwatch") {
    profile.configFile = files.find((f) => /nightwatch\.(conf|json)/.test(f)) || null;
    tests = files.filter((f) => /(^|\/)(tests?|specs?)\//.test(f) && /\.[jt]s$/.test(f));
  } else {
    tests = files.filter((f) => specRe.test(f));
  }
  profile.tests.files = tests;
}

function analyzePython(root, files, profile) {
  const reqs = files.filter((f) => /(^|\/)requirements[\w-]*\.txt$/.test(f));
  const manifests = [...reqs, ...["pyproject.toml", "setup.py", "Pipfile", "setup.cfg", "tox.ini", "pytest.ini"].filter((f) => files.includes(f))];
  const pyFiles = byExt(files, ".py", ".robot");
  if (profile.language || (!manifests.length && !pyFiles.length)) return;
  profile.language = "python";
  profile.buildFiles.push(...manifests);
  profile.requirementsFile = reqs.find((f) => f === "requirements.txt") || reqs[0] || null;
  const pv = read(root, ".python-version").trim() || (read(root, "pyproject.toml").match(/python\s*=\s*["'][^\d]*([\d.]+)/) || [])[1];
  if (pv) profile.runtimeVersion = pv.split(".").slice(0, 2).join(".");

  const text = manifests.map((f) => read(root, f)).join("\n").toLowerCase();
  const d = (n) => text.includes(n);
  if (d("robotframework") || byExt(files, ".robot").length) profile.frameworks.push("robot");
  if (d("behave") || (byExt(files, ".feature").length && files.some((f) => f.endsWith("steps.py") || f.includes("/steps/")))) profile.frameworks.push("behave");
  if (d("pytest-bdd")) profile.frameworks.push("pytest-bdd");
  if (d("pytest") || files.some((f) => /(^|\/)(test_[^/]+|[^/]+_test)\.py$/.test(f)) || files.includes("conftest.py")) profile.frameworks.push("pytest");
  if (d("selenium")) profile.drivers.push("selenium");
  if (d("playwright")) profile.drivers.push("playwright");
  if (d("appium")) profile.drivers.push("appium");
  if (d("pytest-xdist")) profile.dependencies.xdist = true;
  if (d("pytest-html")) profile.reports.push("pytest-html");
  if (d("allure-pytest") || d("allure-behave")) profile.reports.push("allure");
  if (d("pabot")) profile.dependencies.pabot = true;

  const fw = profile.frameworks[0];
  if (fw === "robot") profile.tests.files = byExt(files, ".robot").filter((f) => /\*{3}\s*Test Cases/i.test(read(root, f)));
  else if (fw === "behave" || fw === "pytest-bdd") profile.tests.files = byExt(files, ".feature");
  else {
    profile.tests.files = files.filter((f) => /(^|\/)(test_[^/]+|[^/]+_test)\.py$/.test(f));
    profile.tests.functions = profile.tests.files.flatMap((f) => {
      const out = [];
      let cls = null;
      for (const line of read(root, f).split("\n")) {
        const c = line.match(/^class\s+(Test\w*)/);
        if (c) cls = c[1];
        else if (/^\S/.test(line) && !line.startsWith("@")) cls = null;
        const t = line.match(/^(\s*)(?:async\s+)?def\s+(test\w*)/);
        if (t) out.push(t[1] && cls ? `${f}::${cls}::${t[2]}` : `${f}::${t[2]}`);
      }
      return out;
    });
    profile.tests.markers = uniq(profile.tests.files.flatMap((f) => [...read(root, f).matchAll(/@pytest\.mark\.(\w+)/g)].map((m) => m[1])))
      .filter((m) => !["parametrize", "skip", "skipif", "xfail", "usefixtures", "asyncio", "flaky"].includes(m));
  }
}

function analyzeDotnet(root, files, profile) {
  const csproj = byExt(files, ".csproj");
  if (profile.language || !csproj.length) return;
  profile.language = "csharp";
  profile.buildTool = "dotnet";
  profile.buildFiles.push(...byExt(files, ".sln"), ...csproj);
  const text = csproj.map((f) => read(root, f)).join("\n");
  const tf = text.match(/<TargetFramework>net(?:coreapp)?([\d.]+)<\/TargetFramework>/);
  if (tf) profile.runtimeVersion = tf[1];
  if (/SpecFlow|Reqnroll/.test(text)) profile.frameworks.push("specflow");
  if (/"NUnit"|Include="NUnit"/.test(text)) profile.frameworks.push("nunit");
  if (/xunit/i.test(text)) profile.frameworks.push("xunit");
  if (/MSTest/.test(text)) profile.frameworks.push("mstest");
  if (/Selenium\.WebDriver/.test(text)) profile.drivers.push("selenium");
  if (/Microsoft\.Playwright/.test(text)) profile.drivers.push("playwright");
  if (/Appium/.test(text)) profile.drivers.push("appium");
  profile.playwrightDotnetVersion = (text.match(/Include="Microsoft\.Playwright[^"]*"\s+Version="([^"]+)"/) || [])[1] || null;
  // The csproj(s) that actually hold tests (reference a test adapter / test SDK)
  profile.testProjects = csproj.filter((f) => /NUnit3TestAdapter|MSTest\.TestAdapter|Microsoft\.NET\.Test\.Sdk|xunit\.runner/.test(read(root, f)));
  if (/ExtentReports/i.test(text)) profile.reports.push("extent");
  profile.reports.push("trx");

  const csFiles = byExt(files, ".cs").filter((f) => !f.endsWith(".feature.cs"));
  profile.tests.classes = csFiles
    .map((f) => {
      const src = read(root, f);
      if (!/\[(Test|TestCase|Fact|Theory|TestMethod)\b/.test(src)) return null;
      const ns = (src.match(/namespace\s+([\w.]+)/) || [])[1];
      const cls = (src.match(/\bclass\s+(\w+)/) || [])[1];
      const cats = uniq([...src.matchAll(/\[(?:Category|TestCategory|Trait\("Category",)\s*\(?\s*"([^"]+)"/g)].map((m) => m[1]));
      return { file: f, className: ns ? `${ns}.${cls}` : cls, simpleName: cls, categories: cats };
    })
    .filter(Boolean);
  if (profile.frameworks.includes("specflow")) profile.tests.features = byExt(files, ".feature");
}

// ---------- cross-cutting analysis ----------

function analyzeFeatures(root, files, profile) {
  const scope = profile.projectRoot || profile.packageRoot || "";
  const features = byExt(files, ".feature").filter((f) => !scope || f.startsWith(scope + "/"));
  if (!features.length) return;
  const scenarios = [];
  const tags = new Set();
  for (const f of features) {
    read(root, f).split("\n").forEach((line, i) => {
      if (/^\s*Scenario( Outline| Template)?:/.test(line)) scenarios.push(`${f}:${i + 1}`);
      for (const t of line.matchAll(/(^|\s)(@[\w-]+)/g)) if (/^\s*@/.test(line)) tags.add(t[2]);
    });
  }
  profile.tests.features = features;
  profile.tests.scenarios = scenarios;
  profile.tests.tags = [...tags];
  const featureDirs = uniq(features.map((f) => path.posix.dirname(f)));
  profile.featureRoot = commonPrefix(featureDirs);
}

function commonPrefix(dirs) {
  if (!dirs.length) return "";
  const parts = dirs.map((d) => d.split("/"));
  const out = [];
  for (let i = 0; i < parts[0].length; i++) {
    if (parts.every((p) => p[i] === parts[0][i])) out.push(parts[0][i]);
    else break;
  }
  return out.join("/") || ".";
}

function analyzeGridAndEnv(root, files, profile) {
  // Only scan files of the detected stack (and inside its project folder) so tooling scripts don't leak env vars.
  const exts = {
    java: /\.(java|kt|groovy|properties|ya?ml|json|feature|conf|env)$/,
    node: /\.([cm]?[jt]sx?|json|ya?ml|env)$/,
    python: /\.(py|robot|ini|cfg|toml|ya?ml|json|env)$/,
    csharp: /\.(cs|json|config|runsettings|ya?ml|env)$/,
  }[profile.language] || /\.(java|kt|[cm]?[jt]s|py|cs|rb|properties|json|ya?ml|env|conf|ini|robot)$/;
  const scope = profile.projectRoot || profile.packageRoot || "";
  const srcFiles = files.filter((f) => exts.test(f) && !f.includes("package-lock") && (!scope || f.startsWith(scope + "/")));
  const envVars = new Set();
  const hubs = new Set();
  let usesLtOptions = false;
  let usesLocalDriver = false;
  const configFiles = [];
  for (const f of srcFiles.slice(0, 4000)) {
    const src = read(root, f);
    if (!src) continue;
    for (const m of src.matchAll(/System\.getenv\(\s*"(\w+)"/g)) envVars.add(m[1]);
    for (const m of src.matchAll(/process\.env\.(\w+)|process\.env\[['"](\w+)['"]\]/g)) envVars.add(m[1] || m[2]);
    for (const m of src.matchAll(/os\.(?:environ\.get|getenv)\(\s*['"](\w+)['"]|os\.environ\[['"](\w+)['"]\]/g)) envVars.add(m[1] || m[2]);
    for (const m of src.matchAll(/Environment\.GetEnvironmentVariable\(\s*"(\w+)"/g)) envVars.add(m[1]);
    for (const m of src.matchAll(/%ENV\{(\w+)\}|\$\{ENV:(\w+)\}|%\{(\w+)\}/g)) envVars.add(m[1] || m[2] || m[3]);
    for (const m of src.matchAll(/(https?:\/\/[^"'\s]*(?:lambdatest\.com|:4444)[^"'\s]*)/g)) hubs.add(m[1].replace(/\/\/[^@/]+@/, "//<creds>@"));
    if (src.includes("LT:Options") || src.includes("lt:options")) usesLtOptions = true;
    if (/new\s+(Chrome|Firefox|Edge|Safari)Driver\s*\(|webdriver\.(Chrome|Firefox|Edge)\(|\bchromium\.launch\(/.test(src)) usesLocalDriver = true;
    if (/(^|\/)(config|env|environments?)\.(properties|json|ya?ml)$|\.env$|config\.properties$/.test(f)) configFiles.push(f);
  }
  profile.envVars = [...envVars].filter((v) => !["HOME", "PATH", "USER", "CI", "NODE_ENV", "PWD", "TEMP", "TMP"].includes(v)).sort();
  profile.grid = {
    hubUrls: [...hubs],
    usesLambdaTestHub: [...hubs].some((h) => h.includes("lambdatest.com")),
    usesLtOptions,
    usesLocalDriver,
  };
  profile.configFiles = uniq(configFiles);
}

function buildWarnings(profile) {
  const w = profile.warnings;
  if (!profile.language) w.push("Could not detect the project language. Pass `language`/`framework` explicitly to generate_hyperexecute_yaml.");
  if (!profile.frameworks.length) w.push("No test framework detected. Pass `framework` explicitly.");
  const testCount = profile.tests.classes.length + profile.tests.files.length + profile.tests.features.length;
  if (profile.language && !testCount) w.push("No test classes/files were found. Check the repo path or that tests live in a conventional location.");
  if (profile.grid.hubUrls.some((h) => h.includes("localhost") || h.includes("127.0.0.1")))
    w.push("Tests point at a local Selenium hub (localhost:4444). On HyperExecute either run browsers locally on the VM or switch the hub to https://hub.lambdatest.com/wd/hub.");
  if (profile.grid.usesLambdaTestHub && !profile.envVars.some((v) => /LT_USERNAME|LT_ACCESS_KEY/.test(v)))
    w.push("LambdaTest hub URL found but credentials don't seem to come from LT_USERNAME/LT_ACCESS_KEY env vars. Hard-coded credentials should be moved to env vars / HyperExecute secrets.");
  if (profile.language === "java" && profile.frameworks.includes("cucumber") && !profile.cucumberRunners.length)
    w.push("Cucumber detected but no runner class (@CucumberOptions / @Suite) found. Runner command may need a custom -Dtest value.");
  if (profile.language === "java" && profile.testngSuites.length && profile.tests.classes.length)
    w.push(`TestNG suite file(s) found (${profile.testngSuites.join(", ")}). Class-level autosplit uses -Dtest=<class>, which bypasses suite XML parameters/listeners. If the suite XML carries required <parameter>s or listeners, prefer discovery by suite XML or pass them as -D properties.`);
}

// ---------- public API ----------

export function analyzeRepo(repoPath) {
  const root = path.resolve(repoPath);
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) throw new Error(`Repo path does not exist or is not a directory: ${root}`);
  const files = walk(root);

  const profile = {
    repoPath: root,
    fileCount: files.length,
    truncated: files.length >= MAX_FILES,
    language: null,
    buildTool: null,
    runtimeVersion: null,
    buildFiles: [],
    frameworks: [],
    drivers: [],
    reports: [],
    dependencies: {},
    tests: { classes: [], files: [], features: [], scenarios: [], tags: [], functions: [], markers: [] },
    testngSuites: [],
    cucumberRunners: [],
    envVars: [],
    configFiles: [],
    grid: {},
    existingHyperExecuteYamls: files.filter((f) => /\.ya?ml$/.test(f) && (/hyperexecute/i.test(f) || /^runson\s*:/m.test(read(root, f)))),
    warnings: [],
  };

  analyzeJava(root, files, profile);
  analyzeDotnet(root, files, profile);
  analyzePython(root, files, profile);
  analyzeNode(root, files, profile);
  analyzeFeatures(root, files, profile);
  analyzeGridAndEnv(root, files, profile);
  profile.frameworks = uniq(profile.frameworks);
  profile.drivers = uniq(profile.drivers);
  profile.reports = uniq(profile.reports);
  profile.primaryFramework = profile.frameworks[0] || null;
  buildWarnings(profile);
  return profile;
}

// Compact version for returning to the LLM (large lists are truncated).
export function summarizeProfile(p, limit = 40) {
  const cap = (arr) => (arr.length > limit ? [...arr.slice(0, limit), `... (+${arr.length - limit} more)`] : arr);
  const deps = p.language === "node" ? Object.keys(p.dependencies) : Object.keys(p.dependencies).filter((k) => p.dependencies[k]);
  return {
    ...p,
    dependencies: cap(deps),
    tests: {
      classCount: p.tests.classes.length,
      methodCount: p.tests.classes.reduce((n, c) => n + (c.methods?.length || 0), 0),
      classes: cap(p.tests.classes.map((c) => ({ className: c.className, methods: c.methods?.length, groups: c.groups?.length ? c.groups : undefined, tags: c.tags?.length ? c.tags : c.categories?.length ? c.categories : undefined }))),
      fileCount: p.tests.files.length,
      files: cap(p.tests.files),
      featureCount: p.tests.features.length,
      features: cap(p.tests.features),
      scenarioCount: p.tests.scenarios.length,
      tags: cap(p.tests.tags),
      functionCount: p.tests.functions.length,
      markers: p.tests.markers,
    },
  };
}
