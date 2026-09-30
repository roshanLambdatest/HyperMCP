#!/bin/bash
# Simulated HyperExecute CLI: fails with a DNS error until the YAML enables the tunnel.
cfg="hyperexecute.yaml"; while [ $# -gt 0 ]; do [ "$1" = "--config" ] && cfg="$2"; shift; done
echo "Job Link: https://hyperexecute.lambdatest.com/hyperexecute/task?jobId=1b2c3d4e-1111-2222-3333-444455556666"
echo "user=$LT_USERNAME key=$LT_ACCESS_KEY"
mkdir -p hyperexecute-logs
if [ "$HE_FAKE" = "unknown" ]; then echo "[pre] Starting app under test: ./scripts/start-server.sh"; echo "./scripts/start-server.sh: line 4: wait-for-it.sh: command not found"; echo "[pre] app did not become healthy on http://localhost:8080 within 120s"; echo "Job failed"; exit 1; fi
if [ "$HE_FAKE" = "zero" ]; then echo "[discovery] 0 tests discovered"; echo "Job completed"; exit 0; fi
if grep -q '^tunnel: true' "$cfg"; then echo "Job completed. Tests run: 3, Failures: 0"; exit 0; fi
echo "org.openqa.selenium.WebDriverException: unknown error: net::ERR_NAME_NOT_RESOLVED (https://staging.acme.internal)" > hyperexecute-logs/scenario-1.log
echo "Job failed"; exit 1
