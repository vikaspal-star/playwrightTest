import { defineConfig } from "@playwright/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const workspace = process.env.STUDIO_TEST_WORKSPACE || fs.mkdtempSync(path.join(os.tmpdir(), "mmqa-studio-"));
process.env.STUDIO_TEST_WORKSPACE = workspace;

export default defineConfig({
  testDir: "./tests/studio",
  workers: 1,
  fullyParallel: false,
  timeout: 60000,
  expect: { timeout: 10000 },
  outputDir: "test-results/studio",
  reporter: [["list"], ["html", { outputFolder: "playwright-report/studio", open: "never" }]],
  use: { baseURL: "http://127.0.0.1:4187", headless: true, screenshot: "only-on-failure", trace: "retain-on-failure" },
  webServer: {
    command: "node --import tsx ui/server.ts",
    url: "http://127.0.0.1:4187/api/health",
    reuseExistingServer: false,
    env: { STUDIO_WORKSPACE: workspace, PORT: "4187", HOST: "127.0.0.1", DB_DISABLED: "1", RECORDER_HEADLESS: "1" }
  }
});
