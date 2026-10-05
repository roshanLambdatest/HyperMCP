# Troubleshooting & solution-engineering checklist

## Discovery finds 0 tests
- Run the command locally from the repo root (`dry_run_test_discovery`). Paths are relative to the repo root that the CLI uploads.
- With `mode: remote` the command runs on the VM OS — Windows VMs may not have grep/sed/awk; use `mode: local` or a PowerShell command.
- Check the pattern matches (e.g. `*.spec.ts` vs `*.test.ts`, `src/test/java` in multi-module repos).
- A pom whose suite path has a property (`xml/testng_${platname}.xml`) needs it passed: `-Dplatname=linux` on the mvn command (v0.2: `framework.flags`). Otherwise Maven says "Suite file … is not a valid file" and nothing runs.
- A Cucumber runner in `src/main/java` is reached only through the pom's suite file: `-Dtest=Runner` finds nothing (surefire looks in test classes) and, with `-DfailIfNoTests=false`, the job goes green with 0 tests.
- `Unexpected token '?'` in `pre` = the VM's Node is too old (engines `>=12` is a minimum, not the version to run): set `runtime: {language: node, version: "20"}`.

## Pre step fails
- A YAML/environment problem: the job stops during setup, so nothing executes. The CLI shows `x [1]  pre`, "Failed pre stage percentage", and a remark like `step 1 - exit status 1` (the Nth `pre` command).
- The reason is in the stage log the CLI downloads: `logs/<jobId>/tasks/<taskId>/pre` (no file extension). Each command's output starts with `******* <command> *******`; the last one is the command that failed.
- `npm ERR! code ERESOLVE` → peer dependency conflict: `npm ci --legacy-peer-deps`, or fix package.json.
- `Usage: npm <command>` after `npm ci` → the VM's Node/npm is too old for `npm ci`: set `runtime: {language: node, version: "18"}`.
- "package.json and package-lock.json are in sync" → commit an updated lock file, or use `npm install`.
- `EBADENGINE` / "engine node is incompatible" → set `runtime` to the Node version the package asks for.
- Missing project file (requirements.txt, package.json, pom.xml) → the command needs `cd <project folder> &&`.

## Every task runs all tests
- `$test` missing from `testRunnerCommand`, or the framework ignores the flag (e.g. Cucumber without `-Dtest=Runner`, surefire `<includes>` hard-coded, JUnit 4 + `-Dtest` on an old surefire).

## Dependencies downloaded on every run
- cacheKey file path wrong, cache directory not passed to the tool (`-Dmaven.repo.local=$CACHE_DIR`, `--cache-dir`), or the cache dir is outside the project.

## Tests pass locally, fail on HyperExecute
- Hard-coded local paths (`C:\\Users\\...`, `/Users/...`), local chromedriver paths → use Selenium Manager / WebDriverManager.
- Tests hitting `localhost:4444` → run browsers on the VM or point at `https://hub.lambdatest.com/wd/hub`.
- Internal URLs → `tunnel: true`.
- Missing env vars/secrets → add to `env` (secrets via `${{ .secrets.NAME }}`).
- Headed browsers on Linux → the VMs have displays, but headless is faster.

## Suite XML parameters lost
- `-Dtest=` bypasses testng.xml → parameters/listeners not applied. Split by suite or move parameters to system properties.

## Reports missing
- `partialReports.location` must match where the framework writes; json plugin needed for Cucumber; `report: true` required.
- Use `mergeArtifacts: true` so per-task artefacts are merged.

## Pre-sales checklist
- Language / build tool / framework / runner and versions.
- How is the browser created (local driver vs RemoteWebDriver to LambdaTest)?
- Where do credentials/config come from (env vars, properties, CI secrets)?
- Target OS/browsers, expected concurrency, current run time (for the speed-up story).
- Does the app need a tunnel? Test data dependencies? Ordering dependencies between tests (breaks splitting)?
- Which report does the customer care about (Extent, Allure, Cucumber, JUnit)?

## $(…) in a command fails: "Only ${VARNAME} expansion is supported"
- HyperExecute expands `${VAR}` itself and rejects anything else starting with `$(`, even inside quotes or an awk program, so `export V=$(cat VERSION)` or `c=$(echo "$f" | sed …)` stop the stage with `env: Only ${VARNAME} expansion is supported`.
- Rewrite without command substitution: pipe into the next command, use `xargs`, or let awk compute the value (e.g. a class name from `FILENAME`). In awk, write `j=i+1; c=$j` instead of `c=$(i+1)`.
- Plain `$test`, `$tag` and `${VAR}` are fine. The validator rejects `$(` in pre, post, testDiscovery.command, testRunnerCommand and testSuites.

## Ruby 3 on HyperExecute VMs (rspec, cucumber, capybara)
- Linux VMs (Ubuntu 20.04): `runtime: {language: ruby, version: 3.x}` can't be installed. The Ruby builder has no Ubuntu 20.04 builds left (setup-runtime logs a 404), so the VM keeps Ruby 2.7, and bundle install then fails with "selenium-webdriver … depends on Ruby >= 3.0".
- macOS VMs (macOS 15): setup-runtime says "Unsupported platform macos-15" and the system Ruby 2.6 is used. Bundler also fails to activate the lock's version there.
- Windows VMs: the runtime installs the requested Ruby (verified with 3.0.2); bundle install and the tests run. Use `runson: win` for Ruby 3 projects; the generator does this unless runson is given.
- Use a full version (`3.0.2`), not `3.2`: a short version isn't installed.
- Don't `gem install bundler:<x>` in pre: system gem directories aren't writable (Gem::FilePermissionError).

## A sample repo with nothing to discover
- LambdaTest's hyperexecute-spock-sample has no Spock specification, only a Groovy class with `static void main` that drives the grid, so discovery returns 0 tests (ERR_TEST_DSC) whatever the YAML says.
- Before tuning discovery, check that the repo has real test classes (`@Test`, `extends Specification`, `*_test.py`, `.feature` files …). A script-only repo runs as one command (`testSuites` / matrix with its run command), not through autosplit discovery.

## Sample tests fail although the setup works (stale demo-page selectors)
- LambdaTest's public samples test demo pages that have changed. The setup is fine (pre, discovery and the runner all work, the grid session opens) but the scripts fail on missing elements:
  - To-Do app (lambdatest.github.io/sample-todo-app): the `li1` / `li2` inputs are missing. Seen in the JUnit, Cucumber Java, RSpec, Robot, Nightwatch and WebdriverIO-Cucumber samples.
  - Selenium Playground login: `#username` is missing (NUnit sample).
  - Form demo: the form-button XPath is missing (WebdriverIO sample).
  - Selenium timeouts and assertion failures in Behave, pytest, SpecFlow and Playwright-Jest samples.
- These are test failures (code), not YAML problems. Don't change the YAML or rerun for them; report them, and judge the setup by "tests discovered, ran and reported".
