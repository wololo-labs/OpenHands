import { defineConfig, devices } from "@playwright/test";

import { readRigState } from "./tests/e2e/live/fleet-registry/rig-state";

/**
 * Live fleet-registry validation. Points at a rig that is already running:
 *
 *   node tests/e2e/live/fleet-registry/rig.mjs up
 *   npm run test:e2e:fleet-registry
 *   node tests/e2e/live/fleet-registry/rig.mjs down
 *
 * There is deliberately no `webServer` here. The rig spans two machines and
 * an SSH tunnel, and on a failure it has to stay standing so the failure can
 * be read; a Playwright-managed server would tear it down on the way out.
 */
const rig = readRigState();

export default defineConfig({
  testDir: "./tests/e2e/live/fleet-registry",
  testMatch: /.*\.spec\.ts/,
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: 0,
  workers: 1,
  timeout: 120_000,
  reporter: [
    ["line"],
    ["json", { outputFile: "test-results-fleet-registry/results.json" }],
  ],
  outputDir: "test-results-fleet-registry",
  use: {
    baseURL: rig.baseUrl,
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
    video: "off",
  },
  // Two ordered projects rather than alphabetical luck. Both files are
  // stateful against one live fleet — the registry's loop under test *is* a
  // state machine — and falsification revokes entries, so it has to run after
  // the assertions that need them active. `dependencies` says that out loud.
  projects: [
    {
      name: "fleet",
      testMatch: /fleet-registry\.spec\.ts/,
      use: { ...devices["Desktop Chrome"] },
    },
    {
      name: "falsification",
      testMatch: /falsification\.spec\.ts/,
      dependencies: ["fleet"],
      use: { ...devices["Desktop Chrome"] },
    },
  ],
});
