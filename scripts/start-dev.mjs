import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import process from "node:process";

const isWindows = process.platform === "win32";
const postgresService = "postgres";
const dockerDaemonTimeoutMs = 180_000;
const postgresHealthTimeoutMs = 90_000;
const pollMs = 2_000;

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

function runDockerStep(label, args) {
  console.log(`[dev] ${label}`);
  const result = spawnSync("docker", args, { stdio: "inherit", shell: false });
  if (result.error) {
    console.error(`[dev] Failed to run Docker: ${result.error.message}`);
    process.exit(1);
  }
  if (result.status !== 0) process.exit(result.status ?? 1);
}

function readDockerOutput(args) {
  return spawnSync("docker", args, { encoding: "utf8", shell: false });
}

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function hasDockerCli() {
  const result = readDockerOutput(["--version"]);
  if (!result.error && result.status === 0) return true;

  console.error("[dev] Docker CLI is not available.");
  const details = result.error?.message || result.stderr || result.stdout;
  if (details) console.error(String(details).trim());
  return false;
}

function dockerDaemonIsReady() {
  return readDockerOutput(["info"]).status === 0;
}

function dockerDesktopPaths() {
  return [
    process.env.ProgramFiles ? `${process.env.ProgramFiles}\\Docker\\Docker\\Docker Desktop.exe` : "",
    process.env["ProgramFiles(x86)"] ? `${process.env["ProgramFiles(x86)"]}\\Docker\\Docker\\Docker Desktop.exe` : "",
  ].filter(Boolean);
}

function startDockerDesktop() {
  if (!isWindows) {
    console.error("[dev] Docker daemon is not running. Start Docker and retry.");
    return false;
  }

  console.log("[dev] Docker daemon is not running; starting Docker Desktop");

  const desktopStart = spawnSync("docker", ["desktop", "start"], { stdio: "inherit", shell: false });
  if (!desktopStart.error && desktopStart.status === 0) return true;

  for (const dockerDesktopPath of dockerDesktopPaths()) {
    if (!existsSync(dockerDesktopPath)) continue;

    const child = spawn(dockerDesktopPath, [], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
    child.unref();
    return true;
  }

  console.error("[dev] Could not start Docker Desktop automatically. Start Docker Desktop and retry.");
  return false;
}

function waitForDockerDaemon() {
  const startedAt = Date.now();
  while (Date.now() - startedAt < dockerDaemonTimeoutMs) {
    if (dockerDaemonIsReady()) {
      console.log("[dev] Docker daemon is ready");
      return true;
    }
    sleep(pollMs);
  }

  console.error("[dev] Timed out waiting for Docker daemon to become ready.");
  return false;
}

function composePostgresContainerId() {
  const result = readDockerOutput(["compose", "ps", "-q", postgresService]);
  if (result.status !== 0) {
    console.error((result.stderr || result.stdout || `Failed to inspect ${postgresService} compose service.`).trim());
    process.exit(result.status ?? 1);
  }
  return result.stdout.trim().split(/\r?\n/).filter(Boolean)[0] ?? "";
}

function inspectContainerState(containerId) {
  const result = readDockerOutput([
    "inspect",
    "--format={{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}",
    containerId,
  ]);
  if (result.status !== 0) return "";
  return result.stdout.trim();
}

function waitForPostgresHealth() {
  const startedAt = Date.now();
  let lastState = "unknown";

  while (Date.now() - startedAt < postgresHealthTimeoutMs) {
    const containerId = composePostgresContainerId();
    if (containerId) {
      lastState = inspectContainerState(containerId) || lastState;
      if (lastState === "healthy" || lastState === "running") {
        console.log(`[dev] Compose ${postgresService} service is ${lastState}`);
        return true;
      }
    }
    sleep(pollMs);
  }

  console.error(`[dev] Timed out waiting for Compose ${postgresService} service to become healthy. Last state: ${lastState}`);
  return false;
}

function ensureLocalPostgres() {
  if (process.env.WALLETBOT_DEV_DOCKER === "0") {
    console.log("[dev] Skipping Docker Compose postgres startup because WALLETBOT_DEV_DOCKER=0");
    return;
  }

  if (!hasDockerCli()) process.exit(1);

  if (!dockerDaemonIsReady() && (!startDockerDesktop() || !waitForDockerDaemon())) {
    process.exit(1);
  }

  runDockerStep("Starting Docker Compose postgres service", ["compose", "up", "-d", postgresService]);
  if (!waitForPostgresHealth()) process.exit(1);
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

ensureLocalPostgres();

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
