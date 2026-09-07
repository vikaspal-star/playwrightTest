import test from "node:test";
import assert from "node:assert/strict";
import { adaptationPlan, addProject, addEnvironment, destination, environmentUrl, ProjectStore } from "../../ui/projects";

test("environment adaptation changes matching URL fields and retains selectors, input data and external URLs", () => {
  const steps = [
    { action: "navigate", url: "https://sandbox.example/app/login" },
    { action: "browser-url-changed", url: "https://sandbox.example/app/dashboard" },
    { action: "fill", selector: "#email", value: "person@example.test" },
    { action: "navigate", url: "https://sso.example/login" },
    { action: "navigate", url: "https://sandbox.example/app/callback?token=private" },
    { action: "navigate", url: "https://sandbox.example/application" }
  ];
  const original = structuredClone(steps);
  const result = adaptationPlan(steps, "https://sandbox.example/app/", { id: "production", type: "production", name: "Production", url: "https://production.example/portal/" });
  assert.deepEqual(result.changes.map(c => c.after), ["https://production.example/portal/login", "https://production.example/portal/dashboard"]);
  assert.deepEqual(result.nextSteps.slice(2), original.slice(2));
  assert.deepEqual(steps, original);
  assert.match(result.review.join(" "), /external URL/);
  assert.match(result.review.join(" "), /query parameters/);
  assert.match(result.review.join(" "), /outside the source base path/);
  assert.match(result.review.join(" "), /Production selected/);
});

test("projects have one environment level with scoped IDs and validated base URLs", () => {
  const store: ProjectStore = { version: 1, projects: [], assignments: {} };
  const first = addProject(store, "Coro");
  const second = addProject(store, "Anomali");
  const environment = addEnvironment(first, { type: "sandbox", url: "https://sandbox.example" });
  assert.equal(environment.url, "https://sandbox.example/");
  assert.equal(destination(store, first.id, environment.id).environment, environment);
  assert.throws(() => destination(store, second.id, environment.id));
  assert.throws(() => addProject(store, "coro"), /already exists/);
  assert.throws(() => addEnvironment(first, { type: "folder" }));
  assert.throws(() => addEnvironment(first, { type: "sandbox", name: "Nested/Folder" }));
  assert.throws(() => environmentUrl("https://user:password@example.com"));
  assert.throws(() => environmentUrl("https://example.com/?token=secret"));
  assert.throws(() => environmentUrl("file:///private"));
});
