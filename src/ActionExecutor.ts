import {
  Page,
  expect,
  FrameLocator
} from "@playwright/test";

import path from "path";

// ============================================================
// TEST STEP INTERFACE
// ============================================================

export interface TestStep {

  // ==========================================================
  // BASIC
  // ==========================================================

  action: string;

  selector?: string;

  locatorType?:
    | "css"
    | "xpath"
    | "text"
    | "label"
    | "placeholder"
    | "testid"
    | "role";

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


  // ==========================================================
  // ALERT / DIALOG
  // ==========================================================

  message?: string;

  promptText?: string;


  // ==========================================================
  // TAB / WINDOW
  // ==========================================================

  pageName?: string;
}


// ============================================================
// ACTION EXECUTOR
// ============================================================

export class ActionExecutor {

  // ==========================================================
  // CURRENT FRAME
  // ==========================================================

  private currentFrame: FrameLocator | null = null;


  // ==========================================================
  // ALL PAGES / TABS / WINDOWS
  // ==========================================================

  private pages: Map<string, Page> = new Map();


  // ==========================================================
  // CURRENT PAGE NAME
  // ==========================================================

  private currentPageName: string = "main";


  // ==========================================================
  // CONSTRUCTOR
  // ==========================================================

  constructor(
    private page: Page
  ) {

    this.pages.set(
      "main",
      page
    );
  }


  // ==========================================================
  // CURRENT PAGE (the tab that following steps act on)
  // ==========================================================

  get currentPage(): Page {

    return this.page;
  }


  // ==========================================================
  // EXECUTE
  // ==========================================================

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

      // ======================================================
      // NAVIGATION
      // ======================================================

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


      // ======================================================
      // CLICK
      // ======================================================

      case "click":

        await this.getLocator(step)
          .click();

        break;


      // ======================================================
      // DOUBLE CLICK
      // ======================================================

      case "double-click":

        await this.getLocator(step)
          .dblclick();

        break;


      // ======================================================
      // RIGHT CLICK
      // ======================================================

      case "right-click":

        await this.getLocator(step)
          .click({
            button: "right"
          });

        break;


      // ======================================================
      // FILL
      // ======================================================

      case "fill":

        await this.getLocator(step)
          .fill(
            step.value ?? ""
          );

        break;


      // ======================================================
      // TYPE
      // ======================================================

      case "type":

        await this.getLocator(step)
          .pressSequentially(
            step.value ?? "",
            {
              delay: 30
            }
          );

        break;


      // ======================================================
      // CLEAR
      // ======================================================

      case "clear":

        await this.getLocator(step)
          .fill("");

        break;


      // ======================================================
      // PRESS
      // ======================================================

      case "press":

        if (!step.key) {

          throw new Error(
            "key is required."
          );
        }

        await this.getLocator(step)
          .press(step.key);

        break;


      // ======================================================
      // KEYBOARD PRESS
      // ======================================================

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


      // ======================================================
      // SELECT
      // ======================================================

      case "select":

        await this.getLocator(step)
          .selectOption(
            step.value ?? ""
          );

        break;


      // ======================================================
      // CHECK
      // ======================================================

      case "check":

        await this.getLocator(step)
          .check();

        break;


      // ======================================================
      // UNCHECK
      // ======================================================

      case "uncheck":

        await this.getLocator(step)
          .uncheck();

        break;


      // ======================================================
      // HOVER
      // ======================================================

      case "hover":

        await this.getLocator(step)
          .hover();

        break;


      // ======================================================
      // FOCUS
      // ======================================================

      case "focus":

        await this.getLocator(step)
          .focus();

        break;


      // ======================================================
      // WAIT
      // ======================================================

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


      // ======================================================
      // WAIT FOR SELECTOR
      // ======================================================

      case "wait-for-selector":

        await this.getLocator(step)
          .waitFor({
            state:
              step.state ?? "visible",
            timeout:
              step.timeout ?? 30000
          });

        break;


      // ======================================================
      // WAIT FOR URL
      // ======================================================

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


      // ======================================================
      // URL MATCH
      // ======================================================

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


      // ======================================================
      // URL NOT MATCH
      // ======================================================

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


      // ======================================================
      // URL CONTAINS
      // ======================================================

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


      // ======================================================
      // TEXT VISIBLE
      // ======================================================

      case "text-visible":

        if (!step.text) {

          throw new Error(
            "text is required."
          );
        }

        await expect(
          this.getScope()
            .getByText(step.text)
        ).toBeVisible({
          timeout:
            step.timeout ?? 30000
        });

        break;


      // ======================================================
      // TEXT NOT VISIBLE
      // ======================================================

      case "text-not-visible":

        if (!step.text) {

          throw new Error(
            "text is required."
          );
        }

        await expect(
          this.getScope()
            .getByText(step.text)
        ).not.toBeVisible({
          timeout:
            step.timeout ?? 5000
        });

        break;


      // ======================================================
      // VISIBLE
      // ======================================================

      case "visible":

        await expect(
          this.getLocator(step)
        ).toBeVisible({
          timeout:
            step.timeout ?? 30000
        });

        break;


      // ======================================================
      // HIDDEN
      // ======================================================

      case "hidden":

        await expect(
          this.getLocator(step)
        ).toBeHidden({
          timeout:
            step.timeout ?? 30000
        });

        break;


      // ======================================================
      // EXISTS
      // ======================================================

      case "exists":

        await expect(
          this.getLocator(step)
        ).toBeAttached({
          timeout:
            step.timeout ?? 30000
        });

        break;


      // ======================================================
      // NOT EXISTS
      // ======================================================

      case "not-exists":

        await expect(
          this.getLocator(step)
        ).not.toBeAttached({
          timeout:
            step.timeout ?? 5000
        });

        break;


      // ======================================================
      // VERIFY VALUE
      // ======================================================

      case "verify-value":

        await expect(
          this.getLocator(step)
        ).toHaveValue(
          step.value ?? "",
          {
            timeout:
              step.timeout ?? 30000
          }
        );

        break;


      // ======================================================
      // CHECKED
      // ======================================================

      case "verify-checked":

        await expect(
          this.getLocator(step)
        ).toBeChecked({
          timeout:
            step.timeout ?? 30000
        });

        break;


      // ======================================================
      // NOT CHECKED
      // ======================================================

      case "verify-not-checked":

        await expect(
          this.getLocator(step)
        ).not.toBeChecked({
          timeout:
            step.timeout ?? 30000
        });

        break;


      // ======================================================
      // ELEMENT TEXT
      // ======================================================

      case "element-text":

        await expect(
          this.getLocator(step)
        ).toHaveText(
          step.text ?? "",
          {
            timeout:
              step.timeout ?? 30000
          }
        );

        break;


      // ======================================================
      // ELEMENT TEXT CONTAINS
      // ======================================================

      case "element-text-contains":

        await expect(
          this.getLocator(step)
        ).toContainText(
          step.text ?? "",
          {
            timeout:
              step.timeout ?? 30000
          }
        );

        break;


      // ======================================================
      // ENABLED
      // ======================================================

      case "enabled":

        await expect(
          this.getLocator(step)
        ).toBeEnabled({
          timeout:
            step.timeout ?? 30000
        });

        break;


      // ======================================================
      // DISABLED
      // ======================================================

      case "disabled":

        await expect(
          this.getLocator(step)
        ).toBeDisabled({
          timeout:
            step.timeout ?? 30000
        });

        break;


      // ======================================================
      // UPLOAD
      // ======================================================

      case "upload":

        if (!step.filePath) {

          throw new Error(
            "filePath is required."
          );
        }

        await this.getLocator(step)
          .setInputFiles(
            path.resolve(
              step.filePath
            )
          );

        break;


      // ======================================================
      // DRAG AND DROP
      // ======================================================

      case "drag-and-drop":

        this.requireSelector(step);

        if (!step.value) {

          throw new Error(
            "value must contain target selector."
          );
        }

        await this.getLocator(step)
          .dragTo(
            this.getLocator({
              action: "locator",
              selector: step.value,
              locatorType:
                step.locatorType
            })
          );

        break;


      // ======================================================
      // SCROLL ELEMENT
      // ======================================================

      case "scroll-into-view":

        await this.getLocator(step)
          .scrollIntoViewIfNeeded();

        break;


      // ======================================================
      // SCROLL PAGE
      // ======================================================

      case "scroll":

        await this.page.evaluate(
          ({ x, y }) => {

            window.scrollTo(
              x,
              y
            );

          },
          {
            x: step.x ?? 0,
            y: step.y ?? 500
          }
        );

        break;


      // ======================================================
      // RELOAD
      // ======================================================

      case "reload":

        await this.page.reload({
          waitUntil:
            "domcontentloaded"
        });

        break;


      // ======================================================
      // BACK
      // ======================================================

      case "back":

        await this.page.goBack({
          waitUntil:
            "domcontentloaded"
        });

        break;


      // ======================================================
      // FORWARD
      // ======================================================

      case "forward":

        await this.page.goForward({
          waitUntil:
            "domcontentloaded"
        });

        break;


      // ======================================================
      // TITLE
      // ======================================================

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


      // ======================================================
      // SCREENSHOT
      // ======================================================

      case "screenshot":

        await this.page.screenshot({
          path:
            step.screenshot ??
            `screenshots/${Date.now()}.png`,
          fullPage: true
        });

        break;


      // ======================================================
      // FRAME / IFRAME
      // ======================================================

      case "switch-frame":

        await this.switchFrame(step);

        break;


      // ======================================================
      // SWITCH MAIN FRAME
      // ======================================================

      case "switch-main-frame":
      case "switch-default-content":

        this.currentFrame =
          null;

        console.log(
          "Switched to main frame."
        );

        break;


      // ======================================================
      // NEW TAB
      // ======================================================

      case "new-tab":

        await this.newTab(step);

        break;


      // ======================================================
      // SWITCH TAB
      // ======================================================

      case "switch-tab":
      case "switch-window":

        await this.switchPage(step);

        break;


      // ======================================================
      // SWITCH PAGE BY URL
      // ======================================================

      case "switch-page-by-url":

        await this.switchPageByUrl(step);

        break;


      // ======================================================
      // CLICK AND SWITCH NEW WINDOW
      // ======================================================

      case "click-and-switch-window":

        await this.clickAndSwitchWindow(step);

        break;


      // ======================================================
      // CLOSE TAB / WINDOW
      // ======================================================

      case "close-tab":
      case "close-window":

        await this.closeCurrentPage();

        break;


      // ======================================================
      // ACCEPT ALERT
      // ======================================================

      case "accept-alert":

        await this.setupDialog(
          "accept",
          step
        );

        break;


      // ======================================================
      // DISMISS ALERT
      // ======================================================

      case "dismiss-alert":

        await this.setupDialog(
          "dismiss",
          step
        );

        break;


      // ======================================================
      // HANDLE ALERT / CONFIRM
      // ======================================================

      case "handle-alert":

        await this.setupDialog(
          step.value === "dismiss"
            ? "dismiss"
            : "accept",
          step
        );

        break;


      // ======================================================
      // HANDLE PROMPT
      // ======================================================

      case "handle-prompt":

        await this.setupPrompt(step);

        break;


      // ======================================================
      // UNKNOWN ACTION
      // ======================================================

      default:

        throw new Error(
          `Unknown action: ${step.action}`
        );
    }
  }


  // ==========================================================
  // GET CURRENT SCOPE
  // ==========================================================

  private getScope():
    Page | FrameLocator {

    if (
      this.currentFrame
    ) {

      return this.currentFrame;
    }

    return this.page;
  }


  // ==========================================================
  // GET LOCATOR
  // ==========================================================

  private getLocator(
    step: TestStep
  ) {

    this.requireSelector(step);

    const scope =
      this.getScope();

    const selector =
      step.selector!;


    // ========================================================
    // XPATH
    // ========================================================

    if (
      step.locatorType === "xpath"
    ) {

      return scope.locator(
        `xpath=${selector}`
      );
    }


    // ========================================================
    // AUTO DETECT XPATH
    // ========================================================

    if (
      selector.startsWith("//") ||
      selector.startsWith("(//") ||
      selector.startsWith("./")
    ) {

      return scope.locator(
        `xpath=${selector}`
      );
    }


    // ========================================================
    // TEXT
    // ========================================================

    if (
      step.locatorType === "text"
    ) {

      return scope.getByText(
        selector
      );
    }


    // ========================================================
    // LABEL
    // ========================================================

    if (
      step.locatorType === "label"
    ) {

      return scope.getByLabel(
        selector
      );
    }


    // ========================================================
    // PLACEHOLDER
    // ========================================================

    if (
      step.locatorType === "placeholder"
    ) {

      return scope.getByPlaceholder(
        selector
      );
    }


    // ========================================================
    // TEST ID
    // ========================================================

    if (
      step.locatorType === "testid"
    ) {

      return scope.getByTestId(
        selector
      );
    }


    // ========================================================
    // ROLE
    // ========================================================

    if (
    step.locatorType === "role"
    ) {

    return scope.getByRole(
        selector as any
    );
    }

    // ========================================================
    // CSS DEFAULT
    // ========================================================

    return scope.locator(
      selector
    );
  }


  // ==========================================================
  // SWITCH FRAME
  // ==========================================================

  private async switchFrame(
    step: TestStep
  ): Promise<void> {

    this.requireSelector(step);

    const FrameLocator =
      this.getLocator(step);

    await FrameLocator.waitFor({
      state: "visible",
      timeout:
        step.timeout ?? 30000
    });

    const frame =
      await FrameLocator.contentFrame();

    if (!frame) {

      throw new Error(
        `Unable to switch to iframe: ${step.selector}`
      );
    }

    this.currentFrame =
      frame;

    console.log(
      `Switched to iframe: ${step.selector}`
    );
  }


  // ==========================================================
  // NEW TAB
  // ==========================================================

  private async newTab(
    step: TestStep
  ): Promise<void> {

    const name =
      step.pageName ??
      step.value ??
      `tab-${this.pages.size}`;

    const newPage =
      await this.page
        .context()
        .newPage();

    this.pages.set(
      name,
      newPage
    );

    this.page =
      newPage;

    this.currentPageName =
      name;

    this.currentFrame =
      null;

    console.log(
      `New tab created: ${name}`
    );
  }


  // ==========================================================
  // SWITCH TAB / WINDOW
  // ==========================================================

  private async switchPage(
    step: TestStep
  ): Promise<void> {

    const name =
      step.pageName ??
      step.value;

    if (!name) {

      throw new Error(
        "pageName or value is required for switch-tab."
      );
    }

    const targetPage =
      this.pages.get(name);

    if (!targetPage) {

      throw new Error(
        `Tab/window "${name}" does not exist.`
      );
    }

    if (
      targetPage.isClosed()
    ) {

      throw new Error(
        `Tab/window "${name}" is already closed.`
      );
    }

    this.page =
      targetPage;

    this.currentPageName =
      name;

    this.currentFrame =
      null;

    console.log(
      `Switched to tab/window: ${name}`
    );
  }


  // ==========================================================
  // SWITCH PAGE BY URL
  // ==========================================================

  private async switchPageByUrl(
    step: TestStep
  ): Promise<void> {

    this.requireUrl(step);

    const pages =
      this.page
        .context()
        .pages();

    const targetPage =
      pages.find(
        page =>
          page.url().includes(
            step.url!
          )
      );

    if (!targetPage) {

      throw new Error(
        `No tab/window found containing URL: ${step.url}`
      );
    }

    this.page =
      targetPage;

    this.currentFrame =
      null;

    for (
      const [
        name,
        page
      ] of this.pages
    ) {

      if (
        page === targetPage
      ) {

        this.currentPageName =
          name;

        break;
      }
    }

    console.log(
      `Switched to page: ${targetPage.url()}`
    );
  }


  // ==========================================================
  // CLICK AND SWITCH NEW WINDOW
  // ==========================================================

  private async clickAndSwitchWindow(
    step: TestStep
  ): Promise<void> {

    this.requireSelector(step);

    const windowName =
      step.pageName ??
      step.value ??
      `window-${this.pages.size}`;

    const [
      newPage
    ] = await Promise.all([

      this.page
        .context()
        .waitForEvent(
          "page",
          {
            timeout:
              step.timeout ?? 30000
          }
        ),

      this.getLocator(step)
        .click()

    ]);

    await newPage.waitForLoadState(
      "domcontentloaded"
    );

    this.pages.set(
      windowName,
      newPage
    );

    this.page =
      newPage;

    this.currentPageName =
      windowName;

    this.currentFrame =
      null;

    console.log(
      `Switched to new window: ${windowName}`
    );
  }


  // ==========================================================
  // CLOSE CURRENT PAGE
  // ==========================================================

  private async closeCurrentPage():
    Promise<void> {

    if (
      this.currentPageName === "main"
    ) {

      throw new Error(
        "Cannot close the main page."
      );
    }

    const closingPageName =
      this.currentPageName;

    await this.page.close();

    this.pages.delete(
      closingPageName
    );

    const mainPage =
      this.pages.get("main");

    if (!mainPage) {

      throw new Error(
        "Main page does not exist."
      );
    }

    this.page =
      mainPage;

    this.currentPageName =
      "main";

    this.currentFrame =
      null;

    console.log(
      `Closed page: ${closingPageName}`
    );
  }


  // ==========================================================
  // SETUP ALERT / CONFIRM
  // ==========================================================

  private async setupDialog(
    action:
      | "accept"
      | "dismiss",
    step: TestStep
  ): Promise<void> {

    this.page.once(
      "dialog",
      async dialog => {

        console.log(
          `Dialog type: ${dialog.type()}`
        );

        console.log(
          `Dialog message: ${dialog.message()}`
        );


        // ====================================================
        // VALIDATE MESSAGE
        // ====================================================

        if (
          step.message !== undefined
        ) {

          if (
            dialog.message() !==
            step.message
          ) {

            throw new Error(
              `Dialog message mismatch.
Expected: ${step.message}
Actual: ${dialog.message()}`
            );
          }
        }


        // ====================================================
        // ACCEPT
        // ====================================================

        if (
          action === "accept"
        ) {

          await dialog.accept();

          return;
        }


        // ====================================================
        // DISMISS
        // ====================================================

        if (
          action === "dismiss"
        ) {

          await dialog.dismiss();

          return;
        }
      }
    );

    console.log(
      `Dialog handler registered: ${action}`
    );
  }


  // ==========================================================
  // SETUP PROMPT
  // ==========================================================

  private async setupPrompt(
    step: TestStep
  ): Promise<void> {

    this.page.once(
      "dialog",
      async dialog => {

        console.log(
          `Dialog type: ${dialog.type()}`
        );

        console.log(
          `Dialog message: ${dialog.message()}`
        );


        // ====================================================
        // CHECK PROMPT
        // ====================================================

        if (
          dialog.type() !== "prompt"
        ) {

          throw new Error(
            `Expected prompt dialog but received: ${dialog.type()}`
          );
        }


        // ====================================================
        // VALIDATE MESSAGE
        // ====================================================

        if (
          step.message !== undefined
        ) {

          if (
            dialog.message() !==
            step.message
          ) {

            throw new Error(
              `Prompt message mismatch.
Expected: ${step.message}
Actual: ${dialog.message()}`
            );
          }
        }


        // ====================================================
        // ACCEPT PROMPT
        // ====================================================

        await dialog.accept(
          step.promptText ?? ""
        );
      }
    );

    console.log(
      "Prompt handler registered."
    );
  }


  // ==========================================================
  // REQUIRE SELECTOR
  // ==========================================================

  private requireSelector(
    step: TestStep
  ): void {

    if (
      !step.selector
    ) {

      throw new Error(
        `selector is required for action: ${step.action}`
      );
    }
  }


  // ==========================================================
  // REQUIRE URL
  // ==========================================================

  private requireUrl(
    step: TestStep
  ): void {

    if (
      !step.url
    ) {

      throw new Error(
        `url is required for action: ${step.action}`
      );
    }
  }


  // ==========================================================
  // ESCAPE REGEX
  // ==========================================================

  private escapeRegex(
    value: string
  ): string {

    return value.replace(
      /[.*+?^${}()|[\]\\]/g,
      "\\$&"
    );
  }
}