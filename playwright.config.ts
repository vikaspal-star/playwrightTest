import {
  defineConfig,
  devices
} from "@playwright/test";

export default defineConfig({

  testDir: "./tests",

  fullyParallel: false,

  timeout: 120000,

  expect: {
    timeout: 30000
  },

  reporter: [
    ["list"],
    ["html", { open: "never" }]
  ],

  use: {

    browserName: "chromium",

    headless: false,

    screenshot: "only-on-failure",

    video: "retain-on-failure",

    trace: "retain-on-failure",

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