import {
  test
} from "@playwright/test";

import fs from "fs";
import path from "path";

import {
  JsonRunner
} from "../src/JsonRunner";


const jsonFolder =
  path.resolve("./json");


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
    async ({ page }) => {

      const jsonPath =
        path.join(
          jsonFolder,
          jsonFile
        );

      const runner =
        new JsonRunner(page);

      await runner.run(
        jsonPath
      );
    }
  );

}