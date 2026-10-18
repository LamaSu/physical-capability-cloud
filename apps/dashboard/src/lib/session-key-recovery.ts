// The fetch boundary asks the auth lifecycle to renew without reading a key.
let recovery: { isActive: () => boolean; identity: () => number; renew: () => Promise<boolean> } | null = null;

export function configureSessionKeyRecovery(next: NonNullable<typeof recovery>): void {
  recovery = next;
}

export function isSessionKeyActive(): boolean {
  return recovery?.isActive() ?? false;
}

export function sessionIdentity(): number {
  return recovery?.identity() ?? 0;
}

export function renewSessionKey(): Promise<boolean> {
  return recovery?.renew() ?? Promise.resolve(false);
}
