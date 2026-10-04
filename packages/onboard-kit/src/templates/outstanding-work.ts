/**
 * The evidence work an adapter has outstanding, for its quiesceEvidence().
 *
 * The PCC kernel requires every adapter's quiesceEvidence() to resolve once the adapter has
 * emitted every evidence event of the work it was given, and never while that work can still
 * emit; it keeps the device from the next job until then. Count each thing that can still
 * emit (a running job or poll loop, a sampling timer, a command or callback in flight) from
 * begin() until the returned function is called, after its last emission, and return idle()
 * from quiesceEvidence(). (A copy of @pcc/kernel's OutstandingWork, so a template that is
 * copied out stands alone.)
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
