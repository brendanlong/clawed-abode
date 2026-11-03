/** Limits how many holders run at once; the rest wait in arrival order. */
export class Semaphore {
  private active = 0;
  private readonly waiting: (() => void)[] = [];

  constructor(private readonly limit: number) {}

  /** Resolves with a release function once a slot is free. Release exactly once. */
  async acquire(): Promise<() => void> {
    if (this.active < this.limit) {
      this.active++;
    } else {
      // The releaser hands its slot straight to us, so `active` stays put.
      await new Promise<void>((resolve) => this.waiting.push(resolve));
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.waiting.shift();
      if (next) next();
      else this.active--;
    };
  }
}
