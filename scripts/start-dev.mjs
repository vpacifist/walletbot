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

runPnpmStep("Applying database migrations", ["db:deploy"]);

if (process.env.WALLETBOT_DEV_SYNC !== "0") {
  runPnpmStep("Refreshing wallet data", ["sync:once"]);
} else {
  console.log("[dev] Skipping wallet data refresh because WALLETBOT_DEV_SYNC=0");
}

const devCommand = commandForPnpm(["exec", "next", "dev", "--hostname", "127.0.0.1", "--port", "3000"]);
const child = spawn(devCommand.command, devCommand.args, { stdio: "inherit", shell: false });

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 0);
});
