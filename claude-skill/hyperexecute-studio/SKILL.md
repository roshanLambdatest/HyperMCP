---
name: hyperexecute-studio
description: Use for anything about LambdaTest HyperExecute — creating, checking, optimizing or fixing a hyperexecute.yaml, running tests on HyperExecute, reading a failed HyperExecute job's logs, HyperExecute in CI, or LambdaTest grid capabilities. Drives the HyperExecute Studio MCP tools (server "hyperexecute") instead of hand-writing YAML.
---

# HyperExecute Studio

The `hyperexecute` MCP server has tested rules for HyperExecute; hand-written YAML from memory is where the expensive mistakes come from (jobs that run 0 tests, wrong runner, leaked keys). Use the tools, and use your judgment for the parts they can't know.

## Default flow

1. `analyze_repo`. Read `confidence`, `assumptions`, `questions` first. Not "high" → tell the user what was assumed and ask the questions before generating.
2. Repo already has a HyperExecute YAML (`existingHyperExecuteYamls`) → validate and optimize that one first; only generate a new one if the user wants it.
3. `scan_credentials_and_reporting`. Customer keys in code → offer `fix_hardcoded_credentials` (dry run first).
4. `generate_hyperexecute_yaml` with only the options the user asked for. It applies the user's learned usual settings; mention them.
5. `validate_hyperexecute_yaml`; for v0.1 also `dry_run_test_discovery` and compare the count with `analyze_repo`'s tests.
6. Write only after the user agrees. Offer `generate_ci_pipeline` (github, gitlab, jenkins, azure) for runs from CI.
7. `run_hyperexecute_job` → `get_hyperexecute_run` (waitSeconds) → follow `next`. `fix_and_rerun_hyperexecute` for fixable failures, at most 3 attempts. Never rerun test-failures (code bugs) or auth errors.

## Hard rules

- v0.2 (`framework:`) only for Maven/Gradle TestNG, JUnit 4/5, Spock and .NET NUnit/MSTest, and never with `testDiscovery` (0 tests). Everything else, and tags/files/features/scenarios/matrix, is v0.1.
- `runson`: linux, mac, mac13, win, win11.
- Values the tests read (BASE_URL, API URLs, test accounts) come from the user. Ask; never invent.
- A green run with `discoveryCheck.verdict: "zero-tests"` is not a pass.
- A failure no rule recognizes: read `logDigest`, propose the smallest YAML change, validate it, rerun with `yamlContent`. Tell the user it was saved for `review_diagnosis_feedback`.

## Getting better over time

- Passing runs are saved as accuracy cases (`~/.hyperexecute-studio/accuracy-cases`); `npm run accuracy` in the HyperMCP repo checks new versions against them.
- Unrecognized failures are saved (masked) for `review_diagnosis_feedback`. When the user asks to improve the rules, run it and turn recurring groups into rules in `src/doctor.js` with a smoke test.
