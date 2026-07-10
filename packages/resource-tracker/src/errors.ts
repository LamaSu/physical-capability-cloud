/**
 * Typed refuse-to-start errors.
 *
 * Every failure mode a caller needs to branch on is its own subclass with
 * a stable `code` and structured `details` — never a bare string message.
 * This lets a preflight() implementation catch-and-map these into a typed
 * refusal result without string-matching error messages.
 */

/** Base class for every error this package throws. */
export class ResourceTrackerError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "ResourceTrackerError";
  }
}

/** The requested resource has no registered calibration bounds. */
export class UnknownResourceError extends ResourceTrackerError {
  constructor(resource: string) {
    super(
      "unknown_resource",
      `No calibration bounds registered for resource "${resource}"`,
      { resource },
    );
    this.name = "UnknownResourceError";
  }
}

/**
 * The requested amount falls outside the resource's calibrated [min, max]
 * range — refused regardless of how much capacity is currently available.
 * Mirrors PyLabRobot's height↔volume calibration check.
 */
export class OutOfCalibratedRangeError extends ResourceTrackerError {
  constructor(
    resource: string,
    requested: number,
    bounds: { min: number; max: number; unit?: string },
  ) {
    const unit = bounds.unit ?? "";
    super(
      "out_of_calibrated_range",
      `Requested ${requested}${unit} for "${resource}" is outside the calibrated range [${bounds.min}${unit}, ${bounds.max}${unit}]`,
      { resource, requested, min: bounds.min, max: bounds.max, unit: bounds.unit },
    );
    this.name = "OutOfCalibratedRangeError";
  }
}

/**
 * The amount is within calibrated bounds but exceeds what is currently
 * available (after accounting for other pending reservations).
 */
export class InsufficientResourceError extends ResourceTrackerError {
  constructor(resource: string, requested: number, available: number) {
    super(
      "insufficient_resource",
      `Requested ${requested} of "${resource}" exceeds available ${available}`,
      { resource, requested, available },
    );
    this.name = "InsufficientResourceError";
  }
}

/** commit()/rollback() referenced a reservation id that doesn't exist (or
 *  was already finalized). */
export class ReservationNotFoundError extends ResourceTrackerError {
  constructor(reservationId: string) {
    super(
      "reservation_not_found",
      `No pending reservation "${reservationId}" (already committed/rolled back, or never created)`,
      { reservationId },
    );
    this.name = "ReservationNotFoundError";
  }
}
