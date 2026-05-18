export function jsonSafe(value: unknown): unknown {
  return JSON.parse(
    JSON.stringify(value, (_key, nested) => (typeof nested === "bigint" ? nested.toString() : nested))
  );
}
