# Troubleshooting & solution-engineering checklist

## Discovery finds 0 tests
- Run the command locally from the repo root (`dry_run_test_discovery`). Paths are relative to the repo root that the CLI uploads.
- With `mode: remote` the command runs on the VM OS — Windows VMs may not have grep/sed/awk; use `mode: local` or a PowerShell command.
- Check the pattern matches (e.g. `*.spec.ts` vs `*.test.ts`, `src/test/java` in multi-module repos).

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
