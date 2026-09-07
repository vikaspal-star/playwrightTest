import {
  test, devices
} from "@playwright/test";

import fs from "fs";
import path from "path";

import {
  JsonRunner
} from "../src/JsonRunner";


const jsonFolder =
  path.resolve(process.env.TEST_JSON_DIR || path.join(process.env.STUDIO_WORKSPACE || ".", "json"));


const jsonFiles =
  fs
    .readdirSync(jsonFolder)
    .filter(
      file =>
        file
          .toLowerCase()
          .endsWith(".json")
    )
    .sort();


if (jsonFiles.length === 0) {

  throw new Error(
    `No JSON files found in ${jsonFolder}`
  );

}


for (const jsonFile of jsonFiles) {

  test(
    `Installation: ${jsonFile}`,
    async ({ page, browser }) => {

      const jsonPath =
        path.join(
          jsonFolder,
          jsonFile
        );

      // Studio retains successful-run video too. Plain CLI behavior is unchanged.
      const capture = JSON.parse(process.env.RUN_CAPTURE || "{}");
      const context = process.env.RUN_DIR ? await browser.newContext({ ...devices["Desktop Chrome"], ...(capture.video !== false ? { recordVideo: { dir: path.join(process.env.RUN_DIR, "media"), size: { width: 1280, height: 720 } } } : {}) }) : null;
      try { await new JsonRunner(context ? await context.newPage() : page).run(jsonPath); }
      finally { await context?.close(); }
    }
  );

}
