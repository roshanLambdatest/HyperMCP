# How real HyperExecute YAMLs are set up

Measured on 356 distinct YAMLs: 296 from LambdaTest's public sample repos and 60 from the team's field setups (gist pool), October 2026. Use these as the normal range when suggesting values; the optimizer's suggestions follow them.

## Defaults the field uses

| Setting | Most common | Also seen |
|---|---|---|
| concurrency | 2 (127 YAMLs) | 3–4 (89), 1 (43), 5–25 (25) |
| retryOnFailure / maxRetries | true / 1 (217) | false (54); maxRetries 5 (24) mostly in older samples |
| globalTimeout / testSuiteTimeout / testSuiteStep | 90 (≈170) | 150, the maximum (≈60) |
| mergeArtifacts + report | true together (134) | |
| runson | win (103), linux (78), mac (57) | `${matrix.os}` (73), ios (19), android (13), win11 (12) |

## Caching (what each stack caches)

- Node: `cacheKey: '{{ checksum "package-lock.json" }}'`, `cacheDirectories: [node_modules]` (109). Cypress adds the binary: `env CYPRESS_CACHE_FOLDER: cypressCache` and `cacheDirectories: [node_modules, cypressCache]`.
- Maven: `env CACHE_DIR: m2_cache_dir` with `-Dmaven.repo.local=$CACHE_DIR` on every mvn command, `cacheKey: '{{ checksum "pom.xml" }}'` (54).
- Python: `pip install … --cache-dir pip_cache`, `cacheKey` on requirements.txt (49).
- .NET: `NUGET_PACKAGES` / `NUGET_HTTP_CACHE_PATH` pointed at cached folders (17).
- Ruby: `bundle config set path vendor/bundle`, cache `vendor/bundle`, key on Gemfile.lock (18).
- v0.2 framework runners cache ~/.m2, ~/.gradle and ~/.nuget themselves; adding cacheKey + cacheDirectories turns that off.

## Settings the field uses that save time or money

- `background:` for an app server or database the tests need (`npm start`, `nx serve`, `static-server`). It starts with pre, stays up until post, and runs on every VM; a server started in `pre` either blocks pre or dies with it.
- `differentialUpload: {enabled: true, ttlHours: 100}` for large repos: only changed files are uploaded.
- `failFast: {maxNumberOfTests: N}` aborts a job after N consecutive failing tests across tasks (the last retry counts). Use on large jobs so a broken build doesn't run every unit.
- `skipArtifactStageIfNoTest: true` when filters (tags, grep) can leave a task with no tests: its artefact stage is skipped instead of failing the job.
- `captureScreenRecordingForScenarios: true` records the whole scenario for tests that drive a browser on the VM (Cypress, Playwright local, TestCafe). Keep the framework's own `video` capability off: both on together fails the tests.
- `frameworkStatusOnly: true` when tests set their status through lambda hooks: the scenario status follows the tests' status.
- `scenarioCommandStatusOnly: true` marks a scenario by the runner command's exit code alone (used with k6 and Playwright).
- `dynamicAllocation: true` appears in field setups for raw and app-testing frameworks.
- `tunnelOpts: {global: true}` shares one tunnel across the job's VMs; `{preOnly: true}` opens it only for the pre stage (private package registries).

## YAML v0.2 runners

Native runners (no testDiscovery/testRunnerCommand): maven/testng, maven/junit4, maven/junit5, maven/spock, gradle/testng, gradle/junit4, gradle/junit5, gradle/spock, dotnet/nunit, dotnet/mstest, and per the docs wdio/mocha and wdio/jasmine. App-testing runners keep their own fields: android/espresso and ios/xcui (framework.args with appPath/appId, testSuitePath/testSuiteAppId, devices, deviceSelectionStrategy, optional shards), appium and raw (these use testDiscovery + testRunnerCommand with runson android/ios).

Pitfalls seen in real jobs (suite-path properties, runners outside the source set, old Node) are in the troubleshooting notes.
