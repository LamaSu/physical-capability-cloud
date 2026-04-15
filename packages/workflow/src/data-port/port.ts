/**
 * DataPort<T> — typed, optional-zod-validated port between workflow steps.
 *
 * See design §5.6. Ports back onto the DataLocationStore for durable
 * provenance; tokens can be awaited (producer-consumer queue semantics) or
 * put/got synchronously when already available.
 *
 * v0.1 semantics are in-memory: the port maintains a queue of tokens and a
 * list of awaiting consumers; a crash drops queued tokens. Producers can
 * register DataLocation rows via the DataManager (see manager.ts) so the
 * same content can be resurrected after restart by a future re-read against
 * the persistent store.
 */

import type { ZodType } from 'zod';

import { PortClosedError, type Token } from '../shared/types.js';
import type { Store } from '../store/types.js';
import type { DataPort } from './types.js';

export interface CreateDataPortOptions<T> {
  name: string;
  store: Store;
  /** Optional runtime validation — schema.parse() is called on each put. */
  schema?: ZodType<T>;
}

interface Waiter<T> {
  resolve(t: Token<T>): void;
  reject(e: Error): void;
}

class InMemoryDataPort<T> implements DataPort<T> {
  readonly name: string;

  private readonly schema: ZodType<T> | undefined;
  private readonly queue: Token<T>[] = [];
  private readonly waiters: Waiter<T>[] = [];
  private readonly closedBy = new Set<string>();
  private closed = false;

  constructor(opts: CreateDataPortOptions<T>) {
    this.name = opts.name;
    this.schema = opts.schema;
    // Store ref intentionally held but currently unused in v0.1 (provenance
    // registration is the DataManager's responsibility).
    void opts.store;
  }

  async put(token: Token<T>): Promise<void> {
    if (this.closed) throw new PortClosedError(this.name);
    if (this.schema) {
      this.schema.parse(token.value);
    }
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter.resolve(token);
      return;
    }
    this.queue.push(token);
  }

  async get(consumerId: string): Promise<Token<T>> {
    void consumerId;
    if (this.queue.length > 0) {
      return this.queue.shift()!;
    }
    if (this.closed) throw new PortClosedError(this.name);
    return new Promise<Token<T>>((resolve, reject) => {
      this.waiters.push({ resolve, reject });
    });
  }

  async close(consumerId: string): Promise<void> {
    this.closedBy.add(consumerId);
    this.closed = true;
    const err = new PortClosedError(this.name);
    while (this.waiters.length > 0) {
      this.waiters.shift()!.reject(err);
    }
  }

  empty(): boolean {
    return this.queue.length === 0 && this.waiters.length === 0;
  }
}

export function createDataPort<T>(opts: CreateDataPortOptions<T>): DataPort<T> {
  return new InMemoryDataPort<T>(opts);
}
