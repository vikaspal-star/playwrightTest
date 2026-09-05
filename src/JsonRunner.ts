import fs from "fs";
import path from "path";
import { validateTest } from "./validation";

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


// ============================================================
// RUN EVENTS
// ------------------------------------------------------------
// When RUN_DIR is set (the UI sets it), the runner writes a
// viewport screenshot after every step into that directory and
// prints machine-readable "@@TEST {...}" / "@@STEP {...}" lines
// that the UI server parses for live progress. Plain CLI runs
// are unaffected.
// ============================================================

const RUN_DIR = process.env.RUN_DIR;

function emit(
  type: "TEST" | "STEP",
  payload: Record<string, unknown>
): void {

  if (!RUN_DIR) {
    return;
  }

  console.log(
    `@@${type} ${JSON.stringify(payload)}`
  );
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

      testCase = JSON.parse(content);

    } catch {

      throw new Error(
        `Invalid JSON file: ${jsonPath}`
      );

    }


    // ======================================
    // VALIDATE STEPS
    // ======================================

    testCase = validateTest(testCase, true) as unknown as TestCase;


    console.log(
      `Test: ${testCase.name ?? "Unnamed Test"}`
    );

    console.log(
      `Steps: ${testCase.steps.length}`
    );

    emit("TEST", {
      file: path.basename(jsonPath),
      name: testCase.name ?? "Unnamed Test",
      steps: testCase.steps.length
    });


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

      const index = i + 1;

      const startedAt = Date.now();


      console.log("");

      console.log(
        `STEP ${index}/${testCase.steps.length}`
      );

      console.log(
        `ACTION: ${step.action}`
      );


      try {

        await this.executor.execute(
          step
        );

        const screenshot =
          await this.captureStep(index);

        console.log(
          `✓ Step ${index} Passed`
        );

        emit("STEP", {
          index,
          action: step.action,
          status: "passed",
          durationMs: Date.now() - startedAt,
          screenshot
        });

      } catch (error) {

        const message =
          error instanceof Error
            ? error.message
            : String(error);

        const screenshot =
          await this.captureStep(index);

        console.error(
          `✗ Step ${index} Failed`
        );

        console.error(
          message
        );

        emit("STEP", {
          index,
          action: step.action,
          status: "failed",
          durationMs: Date.now() - startedAt,
          screenshot,
          error: message
        });

        throw error;
      }
    }


    console.log("");

    console.log(
      `✓ COMPLETED: ${jsonPath}`
    );
  }


  // ======================================
  // STEP SCREENSHOT (UI runs only)
  // ======================================

  private async captureStep(
    index: number
  ): Promise<string | undefined> {

    if (!RUN_DIR) {
      return undefined;
    }

    const file = `step-${index}.png`;

    try {

      fs.mkdirSync(RUN_DIR, { recursive: true });

      await this.executor.currentPage.screenshot({
        path: path.join(RUN_DIR, file),
        fullPage: false
      });

      return file;

    } catch {

      // A screenshot must never fail the test itself.
      return undefined;
    }
  }
}
