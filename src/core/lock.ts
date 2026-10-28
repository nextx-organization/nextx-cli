// Cross-process lock around token refresh. The server already tolerates concurrent refreshes of the same
// token (30 s grace + 7 day previous-token window), so this only avoids redundant calls: the process that
// waits re-reads the stored session instead of refreshing again.
import { openSync, closeSync, unlinkSync, statSync, writeSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";

const STALE_MS = 30_000;

export async function withFileLock<T>(path: string, fn: () => Promise<T>, timeoutMs = 20_000): Promise<T> {
  const started = Date.now();
  let fd: number | undefined;
  while (fd === undefined) {
    try {
      fd = openSync(path, "wx", 0o600);
      writeSync(fd, String(process.pid));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      try {
        if (Date.now() - statSync(path).mtimeMs > STALE_MS) unlinkSync(path);
      } catch {
        // removed by the holder meanwhile
      }
      if (Date.now() - started > timeoutMs) break;
      await sleep(100);
    }
  }
  try {
    return await fn();
  } finally {
    if (fd !== undefined) {
      closeSync(fd);
      try {
        unlinkSync(path);
      } catch {
        // already removed
      }
    }
  }
}
