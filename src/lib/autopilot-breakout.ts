export type AutopilotRangeBoundary = {
  lowerTick: number;
  upperTick: number;
};

export function autopilotBreakoutSide(tick: number, range: AutopilotRangeBoundary) {
  if (tick < range.lowerTick) return "below" as const;
  if (tick >= range.upperTick) return "above" as const;
  return null;
}

export function autopilotBreakoutDepthTicks(tick: number, range: AutopilotRangeBoundary) {
  if (tick < range.lowerTick) return range.lowerTick - tick;
  if (tick >= range.upperTick) return tick - range.upperTick + 1;
  return 0;
}
