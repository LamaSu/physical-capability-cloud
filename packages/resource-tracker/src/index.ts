/**
 * @pcc/resource-tracker
 *
 * Offline, in-memory, dependency-free transactional resource reservation:
 * a calibrated capacity model that refuses out-of-bounds requests, a
 * 2-phase-commit resource ledger (reserve -> commit/rollback), and typed
 * refuse-to-start errors.
 *
 * Clean-room port of the PyLabRobot poka-yoke *pattern*
 * (https://github.com/PyLabRobot/pylabrobot) for PCC's preflight() gate —
 * pattern reference only; this package has no dependency on pylabrobot
 * and never executes third-party code.
 */

export { CapacityModel, type ResourceBounds } from "./capacity-model.js";
export { ResourceTracker, type Reservation, type ReserveRequest } from "./resource-tracker.js";
export {
  ResourceTrackerError,
  UnknownResourceError,
  OutOfCalibratedRangeError,
  InsufficientResourceError,
  ReservationNotFoundError,
} from "./errors.js";
