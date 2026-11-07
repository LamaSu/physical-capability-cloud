/**
 * The evidence work this adapter has outstanding, for quiesceEvidence(). A local copy of
 * @pcc/kernel's OutstandingWork (adapters/outstanding-work.ts), so the adapter does not
 * load the kernel at runtime.
 *
 * Each piece of work (a run or command in flight, a scheduled completion) is counted from
 * begin() until the returned function is called, after its last emission; idle() resolves
 * once none is outstanding, at once when none is.
 */
export class OutstandingWork {
  private count = 0;
  private waiters: Array<() => void> = [];

  /** Count one piece of work, until the returned function is called. Calling it again does nothing. */
  begin(): () => void {
    this.count += 1;
    let ended = false;
    return () => {
      if (ended) return;
      ended = true;
      this.count -= 1;
      if (this.count === 0) {
        const waiters = this.waiters;
        this.waiters = [];
        for (const resolve of waiters) resolve();
      }
    };
  }

  /** Count `work` until it settles, whether it resolves or rejects. Returns it unchanged. */
  track<T>(work: Promise<T>): Promise<T> {
    const end = this.begin();
    work.then(end, end);
    return work;
  }

  /** Resolves once no work is outstanding: at once when none is. */
  idle(): Promise<void> {
    if (this.count === 0) return Promise.resolve();
    return new Promise<void>((resolve) => this.waiters.push(resolve));
  }
}
