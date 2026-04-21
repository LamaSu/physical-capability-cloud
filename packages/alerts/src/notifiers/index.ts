/**
 * Notifier registry.
 *
 * A Notifier is anything that can receive an Alert and deliver it somewhere.
 * v1 ships only the Discord notifier, but the registry is built so that
 * future additions (generic webhook, email via SES/Resend, PagerDuty) plug
 * in with no changes to the upstream sources.
 *
 * The registry fans out alerts concurrently and catches individual notifier
 * failures so a dead Discord webhook cannot take down the alerter itself.
 *
 * Author: implementer-alpha
 */

import type { Alert } from "../types.js";

export interface Notifier {
  /** Human label used in logs. Must be stable across restarts. */
  readonly name: string;
  /**
   * Deliver the alert. May throw — the registry will catch and log. Must NOT
   * block the event loop indefinitely (notifiers should set their own timeout).
   */
  fire(alert: Alert): Promise<void>;
}

export class NotifierRegistry {
  private readonly notifiers: Notifier[] = [];

  register(notifier: Notifier): void {
    this.notifiers.push(notifier);
  }

  list(): ReadonlyArray<Notifier> {
    return this.notifiers;
  }

  /**
   * Fan out to every registered notifier. Individual failures are swallowed
   * after being reported via the optional onError callback. Returns once all
   * notifiers have settled (success or failure).
   */
  async broadcast(
    alert: Alert,
    onError?: (notifier: string, err: unknown) => void,
  ): Promise<void> {
    await Promise.all(
      this.notifiers.map(async (n) => {
        try {
          await n.fire(alert);
        } catch (err) {
          if (onError) onError(n.name, err);
        }
      }),
    );
  }
}
