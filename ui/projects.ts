import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DATA_DIR } from "./config";
import { readJson, writeJson } from "./storage";

export interface Environment { id: string; name: string; type: "sandbox" | "production"; url: string }
export interface Project { id: string; name: string; environments: Environment[] }
export interface Assignment { projectId: string; environmentId: string }
export interface ProjectStore { version: 1; projects: Project[]; assignments: Record<string, Assignment> }
export interface MigrationTest { file: string; folder?: string; steps: Record<string, unknown>[] }
export const PROJECTS_FILE = path.join(DATA_DIR, "projects.json");

export function loadProjects(): ProjectStore {
  const store = readJson<ProjectStore>(PROJECTS_FILE, { version: 1, projects: [], assignments: {} });
  if (store.version !== 1 || !Array.isArray(store.projects) || !store.assignments || typeof store.assignments !== "object") throw new Error("Invalid project storage. Restore a valid backup.");
  return store;
}
export function saveProjects(store: ProjectStore): void { writeJson(PROJECTS_FILE, store); }
export function projectName(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.trim().length > 80 || /[\x00-\x1f/\\]/.test(value)) throw new Error("Use a name between 1 and 80 characters, without slashes.");
  return value.trim().replace(/\s+/g, " ");
}
export function environmentUrl(value: unknown): string {
  if (value === "" || value === undefined) return "";
  if (typeof value !== "string" || value.length > 2048) throw new Error("Enter a valid environment URL.");
  const url = new URL(value);
  if (!/^https?:$/.test(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error("Use an HTTP or HTTPS base URL without credentials, query parameters or a fragment.");
  return url.href;
}
export function addProject(store: ProjectStore, rawName: unknown): Project {
  const name = projectName(rawName);
  if (store.projects.some(p => p.name.toLowerCase() === name.toLowerCase())) throw new Error("A project with this name already exists. Open it or choose another name.");
  const project: Project = { id: crypto.randomUUID(), name, environments: [] };
  store.projects.push(project);
  return project;
}
export function addEnvironment(project: Project, input: { name?: unknown; type?: unknown; url?: unknown }): Environment {
  if (input.type !== "sandbox" && input.type !== "production") throw new Error("Choose Sandbox or Production.");
  const name = projectName(input.name || (input.type === "sandbox" ? "Sandbox" : "Production"));
  if (project.environments.some(e => e.name.toLowerCase() === name.toLowerCase())) throw new Error("This environment name already exists in the project.");
  const environment: Environment = { id: crypto.randomUUID(), name, type: input.type, url: environmentUrl(input.url) };
  project.environments.push(environment);
  return environment;
}
export function destination(store: ProjectStore, projectId: unknown, environmentId: unknown): { project: Project; environment: Environment } {
  const project = store.projects.find(p => p.id === projectId);
  const environment = project?.environments.find(e => e.id === environmentId);
  if (!project || !environment) throw new Error("Choose an existing project and one of its environments.");
  return { project, environment };
}
function firstUrl(steps: Record<string, unknown>[]): URL | undefined {
  const step = steps.find(s => ["navigate", "goto", "open-url"].includes(String(s.action)) && typeof s.url === "string");
  try { const url = new URL(String(step?.url)); return /^https?:$/.test(url.protocol) ? url : undefined; } catch { return undefined; }
}
/** Additive migration: original folders, metadata, JSON tests and history are untouched. */
export function reconcileProjects(tests: MigrationTest[], folders: string[]): ProjectStore {
  const store = loadProjects();
  const before = JSON.stringify(store);
  const title = (value: string) => value.slice(0, 1).toUpperCase() + value.slice(1);
  const projectFor = (name: string) => store.projects.find(p => p.name.toLowerCase() === name.toLowerCase()) || addProject(store, name);
  for (const folder of folders) {
    const name = folder.split("/")[0].replace(/\s+(sandbox|production)$/i, "").trim();
    if (name) projectFor(name);
  }
  for (const test of tests) {
    if (store.assignments[test.file]) continue;
    const url = firstUrl(test.steps);
    const folderName = test.folder?.split("/")[0].replace(/\s+(sandbox|production)$/i, "").trim();
    const project = projectFor(folderName || (url ? title(url.hostname.split(".")[0]) : "General"));
    const type = /sandbox|(^|[. /-])(sb|dvl|dev|test|localhost|127)([. /-]|$)/i.test(`${test.folder || ""} ${url?.hostname || ""}`) || !url ? "sandbox" : "production";
    const baseUrl = url ? `${url.origin}/` : "";
    let environment = project.environments.find(e => e.type === type && e.url === baseUrl);
    if (!environment) {
      const label = type === "sandbox" ? "Sandbox" : "Production";
      let name = label;
      let suffix = 2;
      while (project.environments.some(e => e.name === name)) name = `${label} ${suffix++}`;
      environment = addEnvironment(project, { name, type, url: baseUrl });
    }
    store.assignments[test.file] = { projectId: project.id, environmentId: environment.id };
  }
  if (JSON.stringify(store) !== before || !fs.existsSync(PROJECTS_FILE)) saveProjects(store);
  return store;
}

export interface MoveChange { step: number; field: string; before: string; after: string }
export function adaptationPlan(steps: Record<string, unknown>[], sourceUrl: string, target: Environment) {
  const changes: MoveChange[] = [];
  const review: string[] = [];
  let source: URL | undefined;
  let targetUrl: URL | undefined;
  try { source = new URL(sourceUrl); } catch { source = firstUrl(steps); }
  const recorded = firstUrl(steps);
  if (recorded && source && recorded.origin !== source.origin) {
    source = new URL(`${recorded.origin}/`);
    review.push("The saved test still uses another environment URL. The preview is based on its recorded origin.");
  }
  try { targetUrl = new URL(target.url); } catch { /* configuration is required */ }
  const nextSteps = structuredClone(steps);
  if (!targetUrl) review.push("Set the destination environment URL before adapting URLs.");
  if (!source) review.push("No starting URL was found. Add a navigation step for this environment.");
  const sourcePath = source?.pathname.replace(/\/$/, "") || "";
  const targetPath = targetUrl?.pathname.replace(/\/$/, "") || "";
  steps.forEach((step, i) => {
    if (typeof step.url !== "string") return;
    let url: URL;
    try { url = new URL(step.url); } catch { review.push(`Step ${i + 1}: check the relative or dynamic URL manually.`); return; }
    if (!source || !targetUrl) return;
    if (url.origin !== source.origin) { review.push(`Step ${i + 1}: external URL retained; review SSO or third-party navigation.`); return; }
    if (sourcePath && url.pathname !== sourcePath && !url.pathname.startsWith(`${sourcePath}/`)) {
      review.push(`Step ${i + 1}: URL is outside the source base path; review it manually.`); return;
    }
    if (url.username || url.password || url.search) { review.push(`Step ${i + 1}: URL contains credentials or query parameters; review it manually.`); return; }
    const suffix = url.pathname.slice(sourcePath.length);
    const after = `${targetUrl.origin}${targetPath}${suffix || "/"}${url.hash}`;
    if (after !== step.url) { changes.push({ step: i + 1, field: "url", before: step.url, after }); nextSteps[i].url = after; }
  });
  if (steps.some(s => s.selector)) review.push("Check selectors and assertions against the destination screen; URL adaptation does not prove they match.");
  if (steps.some(s => s.value !== undefined || s.text !== undefined)) review.push("Review input data, account permissions and expected text for this environment. These values are retained.");
  if (target.type === "production") review.push("Production selected. Review steps that create, update or delete data before running.");
  return { changes, review, nextSteps };
}
export function revision(value: unknown): string { return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex"); }
