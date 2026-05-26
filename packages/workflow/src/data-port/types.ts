/**
 * Data-port types.
 *
 * See design §5.6. Re-exports DataLocation / DataScheme / DataType / Token /
 * TokenTag from shared/types.ts so consumers can import everything port-related
 * from a single barrel.
 */

export type {
  DataLocation,
  DataScheme,
  DataType,
  Token,
  TokenTag,
} from '../shared/types.js';

/** Typed port for a single channel of data between workflow steps. */
export interface DataPort<T = unknown> {
  readonly name: string;
  put(token: import('../shared/types.js').Token<T>): Promise<void>;
  get(consumerId: string): Promise<import('../shared/types.js').Token<T>>;
  close(consumerId: string): Promise<void>;
  empty(): boolean;
}
