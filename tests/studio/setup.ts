import { spawn } from "node:child_process";
import { once } from "node:events";
import path from "node:path";

/** A direct child avoids Windows shell/taskkill hangs when Playwright closes its webServer. */
export default async function setup() {
  const workspace = process.env.STUDIO_TEST_WORKSPACE;
  if (!workspace) throw new Error("A disposable Studio workspace is required.");
  const server = spawn(process.execPath, ["--import", "tsx", "ui/server.ts"], {
    cwd: path.resolve(__dirname, "../.."), windowsHide: true,
    env: { ...process.env, STUDIO_WORKSPACE: workspace, PORT: "4187", HOST: "127.0.0.1", DB_DISABLED: "1", RECORDER_HEADLESS: "1" },
    stdio: ["ignore", "pipe", "pipe"]
  });
  const stop = async () => {
    if (server.exitCode !== null) return;
    const exited = once(server, "exit");
    server.kill();
    const force = setTimeout(() => server.kill("SIGKILL"), 12000);
    try { await exited; } finally { clearTimeout(force); }
  };
  try {
    await new Promise<void>((resolve, reject) => {
      let output = "";
      const timer = setTimeout(() => reject(new Error("Studio startup timed out.")), 20000);
      server.stdout.on("data", chunk => {
        output += chunk;
        if (output.includes("MMQA Studio running at http://127.0.0.1:4187")) { clearTimeout(timer); resolve(); }
      });
      server.stderr.on("data", chunk => { output += chunk; });
      server.once("error", error => { clearTimeout(timer); reject(error); });
      server.once("exit", () => { clearTimeout(timer); reject(new Error(output)); });
    });
  } catch (error) { await stop(); throw error; }
  return stop;
}
