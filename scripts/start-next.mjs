import { spawn } from "node:child_process";
import process from "node:process";

const port = process.env.PORT || "3000";
const nextBin = process.platform === "win32" ? "next.cmd" : "next";
const child = spawn(nextBin, ["start", "-H", "0.0.0.0", "-p", port], {
  stdio: "inherit",
  shell: false
});

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 0);
});
