// The fetch boundary asks the auth lifecycle to renew without reading a key.
export const SESSION_KEY_SIGN_IN_NOTICE = "Your wallet is signed in. Sign in again to enable operator actions.";

let recovery: {
  isActive: () => boolean;
  identity: () => number;
  renew: () => Promise<boolean>;
  notifyMissingBearer: () => void;
} | null = null;

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

export function notifyMissingSessionBearer(): void {
  recovery?.notifyMissingBearer();
}
