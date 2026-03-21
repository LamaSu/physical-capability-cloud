/**
 * KernelKeyStore — in-memory secure store for bundle AES keys.
 * Maps bundleId to the AES key used to encrypt it.
 * In production: encrypt at rest, HSM-backed.
 */
export class KernelKeyStore {
  private keys = new Map<string, Uint8Array>();

  store(bundleId: string, aesKey: Uint8Array): void {
    this.keys.set(bundleId, new Uint8Array(aesKey));
  }

  retrieve(bundleId: string): Uint8Array | null {
    return this.keys.get(bundleId) ?? null;
  }

  has(bundleId: string): boolean {
    return this.keys.has(bundleId);
  }

  delete(bundleId: string): boolean {
    return this.keys.delete(bundleId);
  }
}

/** Singleton key store instance shared across the kernel. */
export const kernelKeyStore = new KernelKeyStore();
