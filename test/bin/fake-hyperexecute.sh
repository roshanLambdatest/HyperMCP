#!/bin/bash
# Simulated HyperExecute CLI: fails with a DNS error until the YAML enables the tunnel.
# "analyze": the real analyzer's table for a Maven + TestNG/Cucumber repo (HE_FAKE_ANALYZE=python: unsupported).
# Like the real one, it writes hyperexecute-analyze.log into the repo. FAKE_ANALYZE_LOG records each call.
for arg in "$@"; do if [ "$arg" = "analyze" ]; then
  echo "{\"msg\":\"analyze\"}" > hyperexecute-analyze.log
  [ -n "$FAKE_ANALYZE_LOG" ] && echo "user=$LT_USERNAME" >> "$FAKE_ANALYZE_LOG"
  if [ "$HE_FAKE_ANALYZE" = "python" ]; then echo "Analyzer currently does not support language Python"; echo "2026-01-01T00:00:00Z    error    error while running analyze Unsupported Language"; exit 0; fi
  cat "$(dirname "$0")/../cli-analyze/maven-cucumber.txt"; exit 0
fi; done
cfg="hyperexecute.yaml"; while [ $# -gt 0 ]; do [ "$1" = "--config" ] && cfg="$2"; shift; done
echo "Job Link: https://hyperexecute.lambdatest.com/hyperexecute/task?jobId=1b2c3d4e-1111-2222-3333-444455556666"
echo "user=$LT_USERNAME key=$LT_ACCESS_KEY"
mkdir -p hyperexecute-logs
if [ "$HE_FAKE" = "unknown" ]; then echo "[pre] Starting app under test: ./scripts/start-server.sh"; echo "./scripts/start-server.sh: line 4: wait-for-it.sh: command not found"; echo "[pre] app did not become healthy on http://localhost:8080 within 120s"; echo "Job failed"; exit 1; fi
if [ "$HE_FAKE" = "zero" ]; then echo "[discovery] 0 tests discovered"; echo "Job completed"; exit 0; fi
if grep -q '^tunnel: true' "$cfg"; then echo "Job completed. Tests run: 3, Failures: 0"; exit 0; fi
echo "org.openqa.selenium.WebDriverException: unknown error: net::ERR_NAME_NOT_RESOLVED (https://staging.acme.internal)" > hyperexecute-logs/scenario-1.log
echo "Job failed"; exit 1
