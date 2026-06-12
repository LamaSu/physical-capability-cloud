/**
 * PointMap3DViewer — barrel exports.
 *
 * The viewer renders a `PointMap3DTrace` (per-frame point clouds + 6-DoF
 * camera poses produced by the LingBot adapter, schema in `@pcc/spec`)
 * inside any dashboard surface — currently the EvidenceExplorerPage and
 * the JobDetailPage.
 */

export { PointMap3DViewer } from "./PointMap3DViewer.js";
export type { PointMap3DViewerProps } from "./PointMap3DViewer.js";

export { PointMap3DScene } from "./PointMap3DScene.js";
export type { PointMap3DSceneProps } from "./PointMap3DScene.js";

export {
  usePointMap3DPlayback,
  __testHooks as __pointMap3DPlaybackTestHooks,
} from "./usePointMap3DPlayback.js";
export type {
  PointMap3DPlaybackOptions,
  PointMap3DPlaybackState,
} from "./usePointMap3DPlayback.js";

export {
  extractCameraPath,
  pointsToBuffer,
  pointsToColorBuffer,
  traceDurationSec,
  timeToFrameIndex,
  clampFrameIndex,
  pathBounds,
  isFinitePoint,
} from "./pointmap-utils.js";
