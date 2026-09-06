import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { chromium, Browser, Page } from "playwright";
import { proposeRepair } from "../../ui/agent/heal";

// The page as it is *now*: the login button's id and the field ids have drifted
// away from what a recorder captured earlier. This is the ordinary cause of a
// broken selector, and what a repair proposal has to cope with.
const HTML = `<!doctype html><html><body>
  <form id="loginForm" onsubmit="return false">
    <input id="emailField" name="email" placeholder="Email">
    <input id="passwordField" type="password" placeholder="Password">
    <button type="button" id="submitLogin" class="primary-action">Sign in</button>
    <a class="nav-dashboard" href="javascript:void(0)">Dashboard</a>
  </form>
  <button type="button" class="ghost">Cancel</button>
</body></html>`;

async function withPage(run: (page: Page) => Promise<void>): Promise<void> {
  const server = http.createServer((_request, response) => {
    response.writeHead(200, { "Content-Type": "text/html" });
    response.end(HTML);
  });
  await new Promise<void>(resolve => server.listen(0, resolve));
  const port = (server.address() as { port: number }).port;

  let browser: Browser | undefined;
  try {
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    await page.goto(`http://localhost:${port}/`);
    await run(page);
  } finally {
    if (browser) await browser.close();
    server.close();
  }
}

test("a drifted selector is repaired to the right element, with reasons", { timeout: 60000 }, async () => {
  await withPage(async page => {
    const proposal = await proposeRepair(page, {
      stepIndex: 5,
      action: "click",
      selector: "#btnLogin",
      description: 'Click button "Sign in"'
    });

    assert.ok(proposal, "a missing selector should produce a proposal");
    assert.equal(proposal.failure, "not-found");
    assert.equal(proposal.matchCount, 0);

    const best = proposal.candidates[0];
    assert.equal(best.selector, "#submitLogin");
    assert.ok(best.confidence >= 80, `expected high confidence, got ${best.confidence}`);
    assert.ok(best.reasons.length, "a proposal must explain itself");

    // The other button on the page must not outrank the real match.
    const cancel = proposal.candidates.find(c => c.selector.includes("ghost"));
    if (cancel) assert.ok(cancel.confidence < best.confidence);
  });
});

test("a typing step is repaired to the matching field, not just any input", { timeout: 60000 }, async () => {
  await withPage(async page => {
    const proposal = await proposeRepair(page, {
      stepIndex: 2,
      action: "fill",
      selector: "#email",
      description: "Fill input"
    });

    assert.ok(proposal);
    assert.equal(proposal.candidates[0].selector, "#emailField", "the email field should outrank the password field");
  });
});

test("a selector that already resolves is never rewritten", { timeout: 60000 }, async () => {
  await withPage(async page => {
    // Proposing here would let the agent quietly click something else and turn a
    // real product failure into a green run, which is worse than failing.
    const proposal = await proposeRepair(page, {
      stepIndex: 5,
      action: "click",
      selector: "#submitLogin",
      description: 'Click button "Sign in"'
    });
    assert.equal(proposal, null);
  });
});

test("a known alias that still resolves is preferred over inference", { timeout: 60000 }, async () => {
  await withPage(async page => {
    const proposal = await proposeRepair(page, {
      stepIndex: 5,
      action: "click",
      selector: "#btnLogin",
      description: 'Click button "Sign in"',
      aliases: ["#submitLogin"]
    });

    assert.ok(proposal);
    assert.equal(proposal.candidates[0].selector, "#submitLogin");
    assert.match(proposal.candidates[0].reasons[0], /already known/);
  });
});
