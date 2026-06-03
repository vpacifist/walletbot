import { prisma } from "./db";

const AUTOPILOT_PAUSE_KEY = "autopilot-runtime-pause";

export async function isAutopilotRuntimePaused() {
  const event = await prisma.telegramEvent.findUnique({ where: { dedupeKey: AUTOPILOT_PAUSE_KEY } });
  return Boolean(event);
}

export async function pauseAutopilotRuntime(reason: string) {
  return prisma.telegramEvent.upsert({
    where: { dedupeKey: AUTOPILOT_PAUSE_KEY },
    update: {
      payload: {
        reason,
        pausedAt: new Date().toISOString()
      }
    },
    create: {
      alertType: "autopilot_pause",
      dedupeKey: AUTOPILOT_PAUSE_KEY,
      payload: {
        reason,
        pausedAt: new Date().toISOString()
      }
    }
  });
}

export async function resumeAutopilotRuntime() {
  await prisma.telegramEvent.deleteMany({ where: { dedupeKey: AUTOPILOT_PAUSE_KEY } });
}
