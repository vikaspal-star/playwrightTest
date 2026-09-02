import {
  Page,
  expect
} from "@playwright/test";

import path from "path";

export interface TestStep {

  action: string;

  selector?: string;

  value?: string;

  text?: string;

  url?: string;

  timeout?: number;

  key?: string;

  filePath?: string;

  screenshot?: string;

  state?:
    | "visible"
    | "hidden"
    | "attached"
    | "detached";

  x?: number;

  y?: number;
}

export class ActionExecutor {

  constructor(
    private page: Page
  ) {}

  async execute(
    step: TestStep
  ): Promise<void> {

    const action =
      step.action?.toLowerCase();

    if (!action) {
      throw new Error(
        "Action is missing."
      );
    }

    switch (action) {

      // ======================================
      // NAVIGATION
      // ======================================

      case "navigate":
      case "goto":
      case "open-url":

        this.requireUrl(step);

        await this.page.goto(
          step.url!,
          {
            waitUntil: "domcontentloaded"
          }
        );

        break;


      // ======================================
      // CLICK
      // ======================================

      case "click":

        this.requireSelector(step);

        await this.page
          .locator(step.selector!)
          .click();

        break;


      // ======================================
      // DOUBLE CLICK
      // ======================================

      case "double-click":

        this.requireSelector(step);

        await this.page
          .locator(step.selector!)
          .dblclick();

        break;


      // ======================================
      // RIGHT CLICK
      // ======================================

      case "right-click":

        this.requireSelector(step);

        await this.page
          .locator(step.selector!)
          .click({
            button: "right"
          });

        break;


      // ======================================
      // FILL
      // ======================================

      case "fill":

        this.requireSelector(step);

        await this.page
          .locator(step.selector!)
          .fill(
            step.value ?? ""
          );

        break;


      // ======================================
      // TYPE
      // ======================================

      case "type":

        this.requireSelector(step);

        await this.page
          .locator(step.selector!)
          .pressSequentially(
            step.value ?? "",
            {
              delay: 30
            }
          );

        break;


      // ======================================
      // CLEAR
      // ======================================

      case "clear":

        this.requireSelector(step);

        await this.page
          .locator(step.selector!)
          .fill("");

        break;


      // ======================================
      // PRESS
      // ======================================

      case "press":

        this.requireSelector(step);

        if (!step.key) {
          throw new Error(
            "key is required."
          );
        }

        await this.page
          .locator(step.selector!)
          .press(step.key);

        break;


      // ======================================
      // KEYBOARD
      // ======================================

      case "keyboard-press":

        if (!step.key) {
          throw new Error(
            "key is required."
          );
        }

        await this.page.keyboard.press(
          step.key
        );

        break;


      // ======================================
      // SELECT
      // ======================================

      case "select":

        this.requireSelector(step);

        await this.page
          .locator(step.selector!)
          .selectOption(
            step.value ?? ""
          );

        break;


      // ======================================
      // CHECK
      // ======================================

      case "check":

        this.requireSelector(step);

        await this.page
          .locator(step.selector!)
          .check();

        break;


      // ======================================
      // UNCHECK
      // ======================================

      case "uncheck":

        this.requireSelector(step);

        await this.page
          .locator(step.selector!)
          .uncheck();

        break;


      // ======================================
      // HOVER
      // ======================================

      case "hover":

        this.requireSelector(step);

        await this.page
          .locator(step.selector!)
          .hover();

        break;


      // ======================================
      // FOCUS
      // ======================================

      case "focus":

        this.requireSelector(step);

        await this.page
          .locator(step.selector!)
          .focus();

        break;


      // ======================================
      // WAIT
      // ======================================

      case "wait":

        if (
          step.timeout === undefined
        ) {
          throw new Error(
            "timeout is required."
          );
        }

        await this.page.waitForTimeout(
          step.timeout
        );

        break;


      // ======================================
      // WAIT SELECTOR
      // ======================================

      case "wait-for-selector":

        this.requireSelector(step);

        await this.page
          .locator(step.selector!)
          .waitFor({
            state:
              step.state ?? "visible",

            timeout:
              step.timeout ?? 30000
          });

        break;


      // ======================================
      // WAIT URL
      // ======================================

      case "wait-for-url":

        this.requireUrl(step);

        await this.page.waitForURL(
          step.url!,
          {
            timeout:
              step.timeout ?? 30000
          }
        );

        break;


      // ======================================
      // URL MATCH
      // ======================================

      case "browser-url-changed":
      case "url-validation":

        this.requireUrl(step);

        await expect(
          this.page
        ).toHaveURL(
          step.url!,
          {
            timeout:
              step.timeout ?? 30000
          }
        );

        break;


      // ======================================
      // URL NOT MATCH
      // ======================================

      case "url-not-match":

        this.requireUrl(step);

        await expect(
          this.page
        ).not.toHaveURL(
          step.url!,
          {
            timeout:
              step.timeout ?? 5000
          }
        );

        break;


      // ======================================
      // URL CONTAINS
      // ======================================

      case "url-contains":

        this.requireUrl(step);

        await expect(
          this.page
        ).toHaveURL(
          new RegExp(
            this.escapeRegex(
              step.url!
            )
          ),
          {
            timeout:
              step.timeout ?? 30000
          }
        );

        break;


      // ======================================
      // TEXT VISIBLE
      // ======================================

      case "text-visible":

        if (!step.text) {
          throw new Error(
            "text is required."
          );
        }

        await expect(
          this.page.getByText(
            step.text
          )
        ).toBeVisible({
          timeout:
            step.timeout ?? 30000
        });

        break;


      // ======================================
      // TEXT NOT VISIBLE
      // ======================================

      case "text-not-visible":

        if (!step.text) {
          throw new Error(
            "text is required."
          );
        }

        await expect(
          this.page.getByText(
            step.text
          )
        ).not.toBeVisible({
          timeout:
            step.timeout ?? 5000
        });

        break;


      // ======================================
      // VISIBLE
      // ======================================

      case "visible":

        this.requireSelector(step);

        await expect(
          this.page.locator(
            step.selector!
          )
        ).toBeVisible({
          timeout:
            step.timeout ?? 30000
        });

        break;


      // ======================================
      // HIDDEN
      // ======================================

      case "hidden":

        this.requireSelector(step);

        await expect(
          this.page.locator(
            step.selector!
          )
        ).toBeHidden({
          timeout:
            step.timeout ?? 30000
        });

        break;


      // ======================================
      // EXISTS
      // ======================================

      case "exists":

        this.requireSelector(step);

        await expect(
          this.page.locator(
            step.selector!
          )
        ).toBeAttached({
          timeout:
            step.timeout ?? 30000
        });

        break;


      // ======================================
      // NOT EXISTS
      // ======================================

      case "not-exists":

        this.requireSelector(step);

        await expect(
          this.page.locator(
            step.selector!
          )
        ).not.toBeAttached({
          timeout:
            step.timeout ?? 5000
        });

        break;


      // ======================================
      // VALUE VALIDATION
      // ======================================

      case "verify-value":

        this.requireSelector(step);

        await expect(
          this.page.locator(
            step.selector!
          )
        ).toHaveValue(
          step.value ?? "",
          {
            timeout:
              step.timeout ?? 30000
          }
        );

        break;


      // ======================================
      // CHECKED
      // ======================================

      case "verify-checked":

        this.requireSelector(step);

        await expect(
          this.page.locator(
            step.selector!
          )
        ).toBeChecked({
          timeout:
            step.timeout ?? 30000
        });

        break;


      // ======================================
      // NOT CHECKED
      // ======================================

      case "verify-not-checked":

        this.requireSelector(step);

        await expect(
          this.page.locator(
            step.selector!
          )
        ).not.toBeChecked({
          timeout:
            step.timeout ?? 30000
        });

        break;


      // ======================================
      // ELEMENT TEXT
      // ======================================

      case "element-text":

        this.requireSelector(step);

        await expect(
          this.page.locator(
            step.selector!
          )
        ).toHaveText(
          step.text ?? "",
          {
            timeout:
              step.timeout ?? 30000
          }
        );

        break;


      // ======================================
      // ELEMENT TEXT CONTAINS
      // ======================================

      case "element-text-contains":

        this.requireSelector(step);

        await expect(
          this.page.locator(
            step.selector!
          )
        ).toContainText(
          step.text ?? "",
          {
            timeout:
              step.timeout ?? 30000
          }
        );

        break;


      // ======================================
      // ENABLED
      // ======================================

      case "enabled":

        this.requireSelector(step);

        await expect(
          this.page.locator(
            step.selector!
          )
        ).toBeEnabled({
          timeout:
            step.timeout ?? 30000
        });

        break;


      // ======================================
      // DISABLED
      // ======================================

      case "disabled":

        this.requireSelector(step);

        await expect(
          this.page.locator(
            step.selector!
          )
        ).toBeDisabled({
          timeout:
            step.timeout ?? 30000
        });

        break;


      // ======================================
      // UPLOAD
      // ======================================

      case "upload":

        this.requireSelector(step);

        if (!step.filePath) {
          throw new Error(
            "filePath is required."
          );
        }

        await this.page
          .locator(step.selector!)
          .setInputFiles(
            path.resolve(
              step.filePath
            )
          );

        break;


      // ======================================
      // DRAG DROP
      // ======================================

      case "drag-and-drop":

        this.requireSelector(step);

        if (!step.value) {
          throw new Error(
            "value must contain target selector."
          );
        }

        await this.page
          .locator(step.selector!)
          .dragTo(
            this.page.locator(
              step.value
            )
          );

        break;


      // ======================================
      // SCROLL ELEMENT
      // ======================================

      case "scroll-into-view":

        this.requireSelector(step);

        await this.page
          .locator(step.selector!)
          .scrollIntoViewIfNeeded();

        break;


      // ======================================
      // SCROLL PAGE
      // ======================================

      case "scroll":

        await this.page.evaluate(
          ({ x, y }) => {
            window.scrollTo(x, y);
          },
          {
            x: step.x ?? 0,
            y: step.y ?? 500
          }
        );

        break;


      // ======================================
      // RELOAD
      // ======================================

      case "reload":

        await this.page.reload({
          waitUntil:
            "domcontentloaded"
        });

        break;


      // ======================================
      // BACK
      // ======================================

      case "back":

        await this.page.goBack({
          waitUntil:
            "domcontentloaded"
        });

        break;


      // ======================================
      // FORWARD
      // ======================================

      case "forward":

        await this.page.goForward({
          waitUntil:
            "domcontentloaded"
        });

        break;


      // ======================================
      // TITLE
      // ======================================

      case "verify-title":

        await expect(
          this.page
        ).toHaveTitle(
          step.value ?? "",
          {
            timeout:
              step.timeout ?? 30000
          }
        );

        break;


      // ======================================
      // SCREENSHOT
      // ======================================

      case "screenshot":

        await this.page.screenshot({
          path:
            step.screenshot ??
            `screenshots/${Date.now()}.png`,

          fullPage: true
        });

        break;


      // ======================================
      // UNKNOWN ACTION
      // ======================================

      default:

        throw new Error(
          `Unknown action: ${step.action}`
        );
    }
  }


  // ============================================
  // VALIDATION HELPERS
  // ============================================

  private requireSelector(
    step: TestStep
  ): void {

    if (!step.selector) {
      throw new Error(
        `selector is required for action: ${step.action}`
      );
    }
  }


  private requireUrl(
    step: TestStep
  ): void {

    if (!step.url) {
      throw new Error(
        `url is required for action: ${step.action}`
      );
    }
  }


  private escapeRegex(
    value: string
  ): string {

    return value.replace(
      /[.*+?^${}()|[\]\\]/g,
      "\\$&"
    );
  }
}