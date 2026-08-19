import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { lockSync } from "proper-lockfile";

const STALE_AFTER_MS = 10_000;
const UPDATE_EVERY_MS = 2_000;

export class StateLock {
  private released = false;

  private constructor(private readonly unlock: () => void) {}

  static acquire(stateDir: string): StateLock {
    mkdirSync(stateDir, { recursive: true });
    try {
      const unlock = lockSync(stateDir, {
        realpath: false,
        stale: STALE_AFTER_MS,
        update: UPDATE_EVERY_MS,
        lockfilePath: join(stateDir, "uma.lock"),
      });
      return new StateLock(unlock);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ELOCKED")
        throw new Error("State directory is already in use", { cause: error });
      throw error;
    }
  }

  release(): void {
    if (this.released) return;
    this.released = true;
    this.unlock();
  }
}
