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
  globalSetup: "./tests/studio/setup.ts"
});
