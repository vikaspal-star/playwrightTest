import {
  defineConfig,
  devices
} from "@playwright/test";

export default defineConfig({

  testDir: "./tests",
  testMatch: "json-runner.spec.ts",
  forbidOnly: !!process.env.CI,

  fullyParallel: false,

  timeout: 120000,

  expect: {
    timeout: 30000
  },

  reporter: [
    ["list"],
    ['allure-playwright'],
    ["html", { open: "never" }]
  ],

  use: {

    browserName: "chromium",

    headless: true,

    screenshot: "only-on-failure",

    video: "retain-on-failure",

    trace: "on-first-retry",

    actionTimeout: 30000,

    navigationTimeout: 60000
  },

  projects: [

    {
      name: "chromium",

      use: {
        ...devices["Desktop Chrome"]
      }
    }

  ]
});
