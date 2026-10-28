const start = Date.now();

function stamp(): string {
  const s = ((Date.now() - start) / 1000).toFixed(1).padStart(7);
  return `[${s}s]`;
}

export const log = {
  info: (...args: unknown[]) => console.log(stamp(), ...args),
  warn: (...args: unknown[]) => console.warn(stamp(), "WARN", ...args),
  error: (...args: unknown[]) => console.error(stamp(), "ERROR", ...args),
};
