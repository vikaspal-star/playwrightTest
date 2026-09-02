import fs from "fs";

import {
  Page
} from "@playwright/test";

import {
  ActionExecutor,
  TestStep
} from "./ActionExecutor";


export interface TestCase {

  name?: string;

  description?: string;

  steps: TestStep[];
}


export class JsonRunner {

  private executor: ActionExecutor;


  constructor(
    private page: Page
  ) {

    this.executor =
      new ActionExecutor(page);

  }


  async run(
    jsonPath: string
  ): Promise<void> {

    console.log("");
    console.log(
      "========================================"
    );

    console.log(
      `JSON FILE: ${jsonPath}`
    );

    console.log(
      "========================================"
    );


    // ======================================
    // CHECK FILE
    // ======================================

    if (!fs.existsSync(jsonPath)) {

      throw new Error(
        `JSON file does not exist: ${jsonPath}`
      );

    }


    // ======================================
    // READ JSON
    // ======================================

    const content =
      fs.readFileSync(
        jsonPath,
        "utf-8"
      );


    // ======================================
    // PARSE JSON
    // ======================================

    let testCase: TestCase;

    try {

      testCase =
        JSON.parse(content);

    } catch {

      throw new Error(
        `Invalid JSON file: ${jsonPath}`
      );

    }


    // ======================================
    // VALIDATE STEPS
    // ======================================

    if (
      !testCase.steps ||
      !Array.isArray(testCase.steps)
    ) {

      throw new Error(
        `No valid "steps" array found in ${jsonPath}`
      );

    }


    console.log(
      `Test: ${testCase.name ?? "Unnamed Test"}`
    );

    console.log(
      `Steps: ${testCase.steps.length}`
    );


    // ======================================
    // RUN STEPS
    // ======================================

    for (
      let i = 0;
      i < testCase.steps.length;
      i++
    ) {

      const step =
        testCase.steps[i];


      console.log("");

      console.log(
        `STEP ${i + 1}/${testCase.steps.length}`
      );

      console.log(
        `ACTION: ${step.action}`
      );


      try {

        await this.executor.execute(
          step
        );

        console.log(
          `✓ Step ${i + 1} Passed`
        );

      } catch (error) {

        console.error(
          `✗ Step ${i + 1} Failed`
        );

        throw error;
      }
    }


    console.log("");

    console.log(
      `✓ COMPLETED: ${jsonPath}`
    );
  }
}