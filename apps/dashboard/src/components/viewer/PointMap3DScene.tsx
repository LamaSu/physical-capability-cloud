/**
 * PointMap3DScene — pure R3F scene for a single frame of a PointMap3DTrace.
 *
 * Renders:
 *   - a sparse point cloud for the current frame (per-vertex colour
 *     tinted by `Point3D.conf`)
 *   - the entire camera trajectory as a continuous polyline
 *   - a small camera-position marker at the current frame
 *   - a ground grid + 3-axis helper at the path centroid
 *   - orbit controls (mouse / touch drag to rotate, wheel to zoom)
 *
 * Lives in a `<Canvas>` mounted by `PointMap3DViewer`. Keeps no React state
 * of its own — all playback state flows down via props.
 */

import React, { useMemo, useRef } from "react";
import { OrbitControls, Line } from "@react-three/drei";
import * as THREE from "three";
import type { PointMap3DTrace } from "@pcc/spec";
import {
  extractCameraPath,
  pathBounds,
  pointsToBuffer,
  pointsToColorBuffer,
} from "./pointmap-utils.js";

export interface PointMap3DSceneProps {
  trace: PointMap3DTrace;
  currentFrame: number;
  /** Optional per-point pixel size. Default 0.04. */
  pointSize?: number;
  /** Show / hide the camera-trajectory polyline. Default true. */
  showCameraPath?: boolean;
  /** Show / hide axis + grid helpers. Default true. */
  showHelpers?: boolean;
}

/**
 * Stable colour for the trajectory polyline. Matches the solarpunk teal
 * accent used elsewhere in the dashboard.
 */
const CAMERA_PATH_COLOR = "#34d399"; // emerald-400
const CAMERA_MARKER_COLOR = "#a7f3d0"; // emerald-200
const GRID_COLOR_PRIMARY = "#0f766e80"; // teal-700 @ 50%
const GRID_COLOR_SECONDARY = "#0f766e30"; // teal-700 @ 20%

export function PointMap3DScene(props: PointMap3DSceneProps): React.ReactElement {
  const {
    trace,
    currentFrame,
    pointSize = 0.04,
    showCameraPath = true,
    showHelpers = true,
  } = props;

  // --------- Per-frame: rebuild position/color buffers ----------------
  // Memoised on the FRAME (not the trace) so seeking is allocation-light.
  const { positions, colors, pointCount } = useMemo(() => {
    const frame = trace.frames[currentFrame];
    if (!frame) {
      return {
        positions: new Float32Array(0),
        colors: new Float32Array(0),
        pointCount: 0,
      };
    }
    return {
      positions: pointsToBuffer(frame),
      colors: pointsToColorBuffer(frame),
      pointCount: frame.points.length,
    };
  }, [trace, currentFrame]);

  // --------- Per-trace: full camera path + bounds ---------------------
  const path = useMemo(() => extractCameraPath(trace), [trace]);
  const bounds = useMemo(() => pathBounds(trace), [trace]);

  // Convert the flat path Float32Array into the [Vector3-ish, ...] shape
  // `<Line>` expects. We build [[x,y,z], ...] tuples (drei accepts those).
  const pathPoints = useMemo<[number, number, number][]>(() => {
    if (path.length < 6) return [];
    const out: [number, number, number][] = [];
    for (let i = 0; i < path.length; i += 3) {
      out.push([path[i], path[i + 1], path[i + 2]]);
    }
    return out;
  }, [path]);

  // Camera marker position = translation column of current frame's pose.
  const markerPosition = useMemo<[number, number, number]>(() => {
    const m = trace.frames[currentFrame]?.pose?.matrix;
    if (!m || m.length < 12) return [0, 0, 0];
    return [m[3], m[7], m[11]];
  }, [trace, currentFrame]);

  // Cached BufferAttributes so the GPU only sees a single Float32Array
  // re-upload per frame change (otherwise R3F would recreate them).
  const positionAttr = useRef<THREE.BufferAttribute | null>(null);
  const colorAttr = useRef<THREE.BufferAttribute | null>(null);
  positionAttr.current = useMemo(
    () => new THREE.BufferAttribute(positions, 3),
    [positions],
  );
  colorAttr.current = useMemo(
    () => new THREE.BufferAttribute(colors, 3),
    [colors],
  );

  // Camera distance heuristic: 2x the longest path-bounds axis.
  const camDistance = Math.max(2, Math.max(...bounds.size) * 2.5);
  const camTarget: [number, number, number] = bounds.center;

  return (
    <>
      {/* Ambient + key light combo — enough for unlit material polygons but
          mostly cosmetic since Points + Line are unlit by default. */}
      <ambientLight intensity={0.7} />
      <directionalLight position={[5, 10, 7]} intensity={0.6} />

      {showHelpers && (
        <>
          <gridHelper
            args={[Math.max(4, Math.max(...bounds.size) * 4), 20, GRID_COLOR_PRIMARY, GRID_COLOR_SECONDARY]}
            position={[bounds.center[0], bounds.min[1], bounds.center[2]]}
          />
          <axesHelper args={[Math.max(0.5, Math.max(...bounds.size) * 0.5)]} />
        </>
      )}

      {/* Camera trajectory polyline (drei <Line> is a wrapper over Line2). */}
      {showCameraPath && pathPoints.length >= 2 && (
        <Line
          points={pathPoints}
          color={CAMERA_PATH_COLOR}
          lineWidth={1.5}
          dashed={false}
        />
      )}

      {/* Current-frame camera position marker. */}
      <mesh position={markerPosition}>
        <sphereGeometry args={[Math.max(0.02, Math.max(...bounds.size) * 0.015), 16, 16]} />
        <meshBasicMaterial color={CAMERA_MARKER_COLOR} />
      </mesh>

      {/* Sparse point cloud for the current frame. */}
      {pointCount > 0 && (
        <points key={`pts-${currentFrame}`}>
          <bufferGeometry>
            <primitive
              attach="attributes-position"
              object={positionAttr.current}
            />
            <primitive
              attach="attributes-color"
              object={colorAttr.current}
            />
          </bufferGeometry>
          <pointsMaterial
            size={pointSize}
            sizeAttenuation
            vertexColors
            transparent
            opacity={0.9}
          />
        </points>
      )}

      <OrbitControls
        target={camTarget}
        enableDamping
        dampingFactor={0.1}
        makeDefault
        maxDistance={camDistance * 8}
        minDistance={camDistance / 10}
      />
    </>
  );
}
