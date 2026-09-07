import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { AgentPlan, AgentRun, applyAiChecks, evaluateRules, executeAgentRun, renderBody, sendAgentMessage, validatePlan, verdict } from "../../ui/agentTesting";

const plan = (): AgentPlan => validatePlan({ name: "Support agent", projectId: "project", environmentId: "sandbox", requirements: "Remember the customer's name. Refunds take 5 days.", endpoint: "http://127.0.0.1:4188/chat", headersEnv: "", body: { messages: "{{messages}}", message: "{{message}}", sessionId: "{{sessionId}}", enabled: "{{profile.enabled}}" }, responsePath: "reply", profile: { enabled: true }, iterations: 1, timeoutMs: 1000, scenarios: [{ name: "Context", persona: "A new customer", goal: "Remember my name", mode: "scripted", maxTurns: 3, messages: ["My name is Ana", "What is my name?"], criteria: [{ name: "Remembers name", kind: "contains", value: "Ana", critical: true, threshold: 0.8 }] }] });
const record = (p = plan()): AgentRun => ({ id: "run", planId: "plan", owner: "owner", startedAt: new Date().toISOString(), status: "running", results: [], plan: p });

test("agent plans reject unsafe URLs, unknown variables and unbounded execution", () => {
  for (const patch of [{ endpoint: "file:///etc/passwd" }, { endpoint: "http://example.com/chat" }, { endpoint: "https://user:secret@example.com/chat" }, { endpoint: "https://example.com/chat?key=secret" }, { iterations: 20 }, { timeoutMs: 0 }, { headersEnv: "ANTHROPIC_API_KEY" }, { responsePath: "constructor.prototype" }, { body: { message: "{{unknown}}" } }, { profile: null }, { scenarios: [] }]) assert.throws(() => validatePlan({ ...plan(), ...patch }));
  const p = plan(); p.scenarios[0].maxTurns = 1; assert.throws(() => validatePlan(p), /every scripted message/);
  const body = renderBody({ message: "{{message}}", messages: "{{messages}}", enabled: "{{profile.enabled}}" }, { message: 'quotes " and ${code}', messages: [{ role: "user", content: "hi" }], profile: { enabled: true } }) as Record<string, unknown>;
  assert.equal(body.enabled, true); assert.ok(Array.isArray(body.messages)); assert.equal(body.message, 'quotes " and ${code}');
});

test("agent evaluation never passes fabricated, missing, duplicated or low-confidence evidence", () => {
  const p = plan(), s = p.scenarios[0]; s.criteria[0].kind = "ai";
  const transcript = [{ role: "user" as const, content: "Say Ana", at: "now" }, { role: "assistant" as const, content: "Your name is Ana.", at: "now" }];
  const valid = { index: 0, score: 0.9, confidence: "high", turn: 2, evidence: "Your name is Ana.", reason: "Name retained." };
  for (const raw of [{ checks: [] }, { checks: [{ ...valid, evidence: "Invented quote" }] }, { checks: [{ ...valid, turn: 1 }] }, { checks: [{ ...valid, score: 5 }] }, { checks: [{ ...valid, confidence: "low" }] }, { checks: [valid, valid] }]) {
    const checks = evaluateRules(s, transcript); applyAiChecks(checks, s, transcript, raw); assert.equal(verdict(checks), "review");
  }
  const checks = evaluateRules(s, transcript); applyAiChecks(checks, s, transcript, { checks: [valid] }); assert.equal(verdict(checks), "passed");
  applyAiChecks(checks, s, transcript, { checks: [{ ...valid, score: 0.1 }] }); assert.equal(verdict(checks), "failed");
  checks[0].critical = false; assert.equal(verdict(checks), "review");
});

test("agent runs preserve multi-turn history, isolate iteration sessions and keep historical snapshots", async () => {
  const p = plan(); p.iterations = 2;
  const run = record(p), sessions: string[] = [], historyLengths: number[] = [], snapshots: AgentRun[] = [];
  await executeAgentRun(run, new AbortController().signal, { reply: async (_plan, messages, sessionId) => { sessions.push(sessionId); historyLengths.push(messages.length); return "Your name is Ana."; }, ai: async () => { throw new Error("Scripted text checks must not call AI"); }, save: r => snapshots.push(structuredClone(r)) });
  assert.equal(run.status, "passed"); assert.deepEqual(historyLengths, [1, 3, 1, 3]); assert.equal(sessions[0], sessions[1]); assert.notEqual(sessions[0], sessions[2]);
  assert.equal(run.results.length, 2); assert.equal(run.results[0].transcript.length, 4); assert.ok(snapshots.length > 5); assert.ok(run.finishedAt);
});

test("adaptive agent conversations stop at the configured turn limit and cancellation cannot pass", async () => {
  const p = plan(); p.scenarios[0].mode = "adaptive"; p.scenarios[0].maxTurns = 2;
  const run = record(p); let calls = 0;
  await executeAgentRun(run, new AbortController().signal, { reply: async () => { calls++; return "Ana"; }, ai: async () => ({ done: false, message: "Tell me more" }), save: () => {} });
  assert.equal(calls, 2); assert.equal(run.status, "passed");
  const controller = new AbortController(), cancelled = record();
  await executeAgentRun(cancelled, controller.signal, { reply: async () => { controller.abort(); return "Ana"; }, ai: async () => ({}), save: () => {} });
  assert.equal(cancelled.status, "cancelled"); assert.equal(cancelled.results[0].status, "cancelled"); assert.equal(cancelled.results[0].transcript.length, 1);
  const failed = record();
  await executeAgentRun(failed, new AbortController().signal, { reply: async () => { throw new Error("HTTP 401"); }, ai: async () => ({}), save: () => {} });
  assert.equal(failed.status, "error"); assert.equal(failed.results[0].checks.length, 0);
});

test("chat transport sends typed templates and server headers, rejects redirects and oversized responses", async () => {
  const requests: Record<string, unknown>[] = [];
  const server = http.createServer(async (req, res) => {
    if (req.url === "/redirect") { res.writeHead(302, { Location: "/chat" }); res.end(); return; }
    if (req.url === "/large") { res.end("x".repeat(256001)); return; }
    let body = ""; for await (const chunk of req) body += chunk;
    requests.push(JSON.parse(body));
    assert.equal(req.headers["x-test-key"], "fixture-only");
    res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify({ output: [{ content: "Hello Ana" }] }));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as import("node:net").AddressInfo).port;
  process.env.MMQA_AGENT_UNIT_HEADERS = '{"x-test-key":"fixture-only"}';
  try {
    const p = plan(); p.endpoint = `http://127.0.0.1:${port}/chat`; p.headersEnv = "MMQA_AGENT_UNIT_HEADERS"; p.responsePath = "output.0.content";
    const messages = [{ role: "user" as const, content: "Hello", at: "now" }], signal = new AbortController().signal;
    assert.equal(await sendAgentMessage(p, messages, "session", signal), "Hello Ana");
    assert.equal(requests[0].enabled, true); assert.equal(requests[0].sessionId, "session"); assert.deepEqual(requests[0].messages, [{ role: "user", content: "Hello" }]);
    p.endpoint = `http://127.0.0.1:${port}/redirect`; await assert.rejects(sendAgentMessage(p, messages, "session", signal), /redirected/);
    p.endpoint = `http://127.0.0.1:${port}/large`; await assert.rejects(sendAgentMessage(p, messages, "session", signal), /256 KB/);
  } finally { delete process.env.MMQA_AGENT_UNIT_HEADERS; server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});
