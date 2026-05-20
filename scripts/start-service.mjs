import { spawn, spawnSync } from "node:child_process";
import process from "node:process";

const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
const command = process.env.WALLETBOT_PROCESS === "worker" ? "worker" : "start";

if (command === "start") {
  const migration = spawnSync(pnpm, ["db:deploy"], { stdio: "inherit", shell: false });
  if (migration.status !== 0) process.exit(migration.status ?? 1);
}

const child = spawn(pnpm, [command], { stdio: "inherit", shell: false });

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 0);
});
