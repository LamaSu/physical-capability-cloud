# Landscape Report: React 3D viewer for PointMap3DTrace data

## Constitutional Constraints
No `./constitution.md` at repo root. Project-level rules from `CLAUDE.md`:
- All new deps must pass Gate A vetting (`/vet`).
- Solarpunk design system enforced (GlassPanel, dark theme, glow accents).
- React 19, Vite, TypeScript, vitest as the test framework.

## Existing Solutions Found

| # | Solution | Solves Problem? | Maintained? | Constitutional Fit | Recommendation |
|---|----------|----------------|-------------|--------------------|----------------|
| 1 | [three.js](https://github.com/mrdoob/three.js) (raw, imperative) | Fully | Yes (~100k stars, weekly releases) | OK | Adopt as substrate |
| 2 | [@react-three/fiber](https://github.com/pmndrs/react-three-fiber) v9 | Fully | Yes (R19-ready, Sep 2025) | OK — declarative React fit | **Adopt** |
| 3 | [@react-three/drei](https://github.com/pmndrs/drei) | Fully (OrbitControls, Line, Stats) | Yes (Pmndrs ecosystem) | OK | Adopt as helper |
| 4 | [deck.gl](https://github.com/visgl/deck.gl) — PointCloudLayer | Fully | Yes (Uber/vis.gl) | Mismatch — geospatial-first, 2.6MB bundle | Skip |
| 5 | [babylon.js + react-babylonjs](https://github.com/brianzinn/react-babylonjs) | Fully | Yes | Heavier (4MB+), enterprise CAD focus | Skip — overkill |
| 6 | [plotly.js scatter3d](https://github.com/plotly/plotly.js) | Partially (no per-frame timeline) | Yes | Hard — bundles all plotly | Skip |
| 7 | [potree.js](https://github.com/potree/potree) (LiDAR-class point clouds) | Overkill | Sparse maintenance | Mismatch — millions of points | Skip |

## Recommended Path
- [x] **ADOPT + EXTEND**: `three` + `@react-three/fiber` + `@react-three/drei`. The user-provided constraint ("three.js or react-three-fiber, whichever already in deps") effectively pre-selects the pmndrs stack. R3F adds React 19 support and JSX-native composition that matches the dashboard's component conventions; drei provides `<Line>`, `<Points>`, `<OrbitControls>`, `<Stats>` as drop-in components, so we don't reinvent camera-trajectory drawing or orbit interaction.

## Build Justification
The viewer itself (component + controls + data adapters) is project-specific — there is no off-the-shelf "PointMap3DTrace player" because `PointMap3DTrace` is a PCC-defined schema. So the viewer code is BUILT, but the rendering engine is ADOPTED (R3F + three).

## Library choice rationale (for the final report)

| Axis | three.js (raw) | react-three-fiber + drei |
|------|----------------|--------------------------|
| Idiomatic with React 19 | No (imperative loop) | Yes (declarative JSX) |
| Test ergonomics (vitest) | Manual DOM stubs | `@react-three/test-renderer` or logic-level tests |
| Camera trajectory polyline | Hand-roll `BufferGeometry` | `<Line points={…}>` from drei |
| Point cloud render | Hand-roll `Points`+`PointsMaterial` | `<Points><PointMaterial></Points>` |
| Bundle weight | ~600KB three core | three + R3F (~30KB) + drei (~80KB tree-shaken) |
| Risk of regressions in other pages | Imperative side-effects | Pure components, isolated |

**Decision: react-three-fiber + drei.** Lower friction to integrate with the existing React 19 + Vite + Tailwind dashboard, cleaner test surface, and drei gives us `<Line>`, `<Points>`, `<OrbitControls>` for free.
