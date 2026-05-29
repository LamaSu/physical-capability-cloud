/**
 * Multi-method DID resolver.
 *
 * Dispatches to method-specific resolvers based on the parsed DID's method-name.
 * Supports: did:pkh, did:web, did:ens
 */

import { parseDID } from "./did.js";
import { resolvePKH } from "./methods/pkh.js";
import { resolveWeb } from "./methods/web.js";
import { resolveENS } from "./methods/ens.js";
import {
  DIDResolutionError,
  type DIDDocument,
  type ParsedDID,
  type ResolverOptions,
} from "./types.js";

type MethodResolver = (parsed: ParsedDID, options: ResolverOptions) => Promise<DIDDocument>;

const BUILTIN_RESOLVERS: Record<string, MethodResolver> = {
  pkh: resolvePKH,
  web: resolveWeb,
  ens: resolveENS,
};

export class DIDResolver {
  private readonly options: ResolverOptions;
  private readonly resolvers: Record<string, MethodResolver>;

  constructor(options: ResolverOptions = {}) {
    this.options = options;
    // Shallow-copy so callers can register extra methods on a per-instance basis.
    this.resolvers = { ...BUILTIN_RESOLVERS };
  }

  /**
   * Parse a DID URI into its components without resolving it.
   */
  parse(did: string): ParsedDID {
    return parseDID(did);
  }

  /**
   * Register an additional DID-method resolver.
   * Useful for tests or third-party method support.
   */
  registerMethod(method: string, resolver: MethodResolver): void {
    this.resolvers[method] = resolver;
  }

  /**
   * Return the list of currently-supported DID methods.
   */
  supportedMethods(): string[] {
    return Object.keys(this.resolvers).sort();
  }

  /**
   * Resolve a DID URI to a DIDDocument.
   *
   * @throws DIDResolutionError if the DID is malformed, the method is unsupported,
   *   or the underlying resolver fails.
   */
  async resolve(did: string): Promise<DIDDocument> {
    const parsed = this.parse(did);
    const resolver = this.resolvers[parsed.method];
    if (!resolver) {
      throw new DIDResolutionError(
        `DID method "${parsed.method}" is not supported (supported: ${this.supportedMethods().join(", ")})`,
        did,
        "methodNotSupported",
      );
    }
    return resolver(parsed, this.options);
  }
}
