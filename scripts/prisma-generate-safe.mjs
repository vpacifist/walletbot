import { spawnSync } from "node:child_process";
import process from "node:process";

const noRestart = process.argv.includes("--no-restart");

if (process.platform === "win32") {
  const args = [
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    "./scripts/prisma-generate-safe.ps1"
  ];

  if (noRestart) args.push("-NoRestart");

  const result = spawnSync("powershell", args, { stdio: "inherit", shell: false });
  process.exit(result.status ?? 1);
}

const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
const result = spawnSync(pnpm, ["exec", "prisma", "generate"], { stdio: "inherit", shell: false });
process.exit(result.status ?? 1);
