/**
 * Browser shim for the one `node:util` export @pcc/spec reads: `types`, for
 * `types.isProxy`. The dashboard's vite.config.ts aliases `node:util` to this
 * file, as it aliases `node:crypto` to node-crypto-shim.ts.
 *
 * A browser has no trap-free proxy check, so `types` offers none. Then
 * @pcc/spec's plainDataCopy (util/plain-data.ts) has a null `isProxy` and
 * refuses every object: a proxy cannot be told apart from plain data without
 * running its traps. The dashboard bundles that module but never copies
 * untrusted objects with it.
 */
export const types: Readonly<Record<string, never>> = Object.freeze({});
