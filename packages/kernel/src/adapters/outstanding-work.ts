/**
 * The evidence work an adapter has outstanding, for quiesceEvidence() (adapters/types.ts).
 *
 * An adapter counts each thing that can still emit evidence for work it was given: a
 * running job or execution loop, a poll or sampling timer, an async callback or command in
 * flight. quiesceEvidence() returns idle(), which resolves once nothing is outstanding, so
 * it resolves only after every emission that work makes, and at once when there is none.
 *
 * end() runs after the last emission of a piece of work, never before it: an emission is a
 * synchronous call into the listeners, so by the time idle() resolves, the listeners have
 * every event.
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

  /** How many pieces of work are outstanding. */
  get size(): number {
    return this.count;
  }
}
