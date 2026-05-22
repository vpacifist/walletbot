import { spawn, spawnSync } from "node:child_process";
import process from "node:process";

const isWindows = process.platform === "win32";

function commandForPnpm(args) {
  if (!isWindows) return { command: "pnpm", args };
  return { command: "cmd.exe", args: ["/d", "/s", "/c", ["pnpm.cmd", ...args].join(" ")] };
}

function runPnpmStep(label, args) {
  console.log(`[dev] ${label}`);
  const command = commandForPnpm(args);
  const result = spawnSync(command.command, command.args, { stdio: "inherit", shell: false });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

function spawnPnpm(label, args) {
  console.log(`[dev] Starting ${label}`);
  const command = commandForPnpm(args);
  const child = spawn(command.command, command.args, { stdio: "inherit", shell: false });
  child.on("exit", (code, signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[dev] ${label} exited${signal ? ` with ${signal}` : ` with code ${code ?? 0}`}`);
    stopChildren(child);
    process.exit(code ?? (signal ? 1 : 0));
  });
  return child;
}

function stopProcess(child) {
  if (child.exitCode !== null || child.killed) return;
  if (isWindows) {
    spawnSync("taskkill.exe", ["/pid", String(child.pid), "/t", "/f"], { stdio: "ignore", shell: false });
    return;
  }
  child.kill("SIGTERM");
}

function stopChildren(except) {
  for (const child of children) {
    if (child !== except) stopProcess(child);
  }
}

let shuttingDown = false;
const children = [];

runPnpmStep("Applying database migrations", ["db:deploy"]);

if (process.env.WALLETBOT_DEV_SYNC !== "0") {
  runPnpmStep("Refreshing wallet data", ["sync:once"]);
} else {
  console.log("[dev] Skipping wallet data refresh because WALLETBOT_DEV_SYNC=0");
}

children.push(spawnPnpm("Next dev server", ["exec", "next", "dev", "--hostname", "127.0.0.1", "--port", "3000"]));

if (process.env.WALLETBOT_DEV_WORKER !== "0") {
  children.push(spawnPnpm("sync worker", ["worker"]));
} else {
  console.log("[dev] Skipping sync worker because WALLETBOT_DEV_WORKER=0");
}

const shutdown = () => {
  if (shuttingDown) return;
  shuttingDown = true;
  stopChildren();
  process.exit(0);
};

process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);

process.once("exit", () => {
  stopChildren();
});
