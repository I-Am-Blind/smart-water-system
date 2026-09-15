/**
 * Rig geometry in scene units (roughly decimetres). Everything that needs a position
 * (meshes, particle paths, DOM labels) reads from here so the three stay aligned.
 *
 *   tank -> pump -> master sensor -> manifold -> [valve -> IN sensor -> leak point -> OUT sensor] x3 -> collector -> return -> tank
 */
export type Vec = [number, number, number];

/** Centre-line height of all pipes. */
export const Y = 0.5;
export const PIPE_R = 0.16;
export const TANK_R = 1.25;
export const TANK_H = 1.7;
/** z of branch 1, 2, 3 (front to back is +z toward the camera). */
export const BRANCH_Z: readonly [number, number, number] = [-1.6, 0, 1.6];
export const RETURN_Z = 2.6;

export const X = {
  tankC: -5.2,
  tankOut: -3.95,
  pump: -2.6,
  master: -1.1,
  manifold: 0.4,
  valve: 1.7,
  inSensor: 2.75,
  leak: 3.85,
  outSensor: 4.95,
  collector: 6.15,
} as const;

/** Half-length of the tinted "leak point" pipe section. */
export const LEAK_HALF = 0.42;
export const MANIFOLD_HALF_Z = 1.9;

export interface FlowPath {
  id: string;
  points: Vec[];
  /** Sensor index into tel.f (0 = master, 2b-1 = branch IN, 2b = branch OUT) or "ret" for the sum of outflows. */
  sensor: number | "ret";
}

/** Particle paths. Order matters only for the instance layout in Flow.tsx. */
export const PATHS: FlowPath[] = [
  { id: "main", points: [[X.tankOut, Y, 0], [X.manifold - 0.25, Y, 0]], sensor: 0 },
  ...BRANCH_Z.flatMap((z, i): FlowPath[] => [
    { id: `b${i + 1}in`, points: [[X.manifold + 0.25, Y, z], [X.leak, Y, z]], sensor: 2 * i + 1 },
    { id: `b${i + 1}out`, points: [[X.leak, Y, z], [X.collector - 0.25, Y, z]], sensor: 2 * i + 2 },
  ]),
  {
    id: "ret",
    points: [
      [X.collector, Y, BRANCH_Z[2]],
      [X.collector, Y, RETURN_Z],
      [X.tankC, Y, RETURN_Z],
      [X.tankC, Y, TANK_R],
    ],
    sensor: "ret",
  },
];

/** Precomputed polyline data for fast interpolation without allocations. */
export interface PathGeom {
  points: Vec[];
  cum: number[];
  total: number;
}

export function buildPathGeom(p: FlowPath): PathGeom {
  const cum = [0];
  let total = 0;
  for (let i = 1; i < p.points.length; i++) {
    const a = p.points[i - 1];
    const b = p.points[i];
    total += Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
    cum.push(total);
  }
  return { points: p.points, cum, total };
}

/** Writes the point at normalised distance t (0..1) along the polyline into out[0..2]. */
export function pointAt(g: PathGeom, t: number, out: Float32Array | number[]): void {
  const d = t * g.total;
  let i = 1;
  while (i < g.cum.length - 1 && g.cum[i] < d) i++;
  const a = g.points[i - 1];
  const b = g.points[i];
  const segLen = g.cum[i] - g.cum[i - 1];
  const u = segLen > 0 ? (d - g.cum[i - 1]) / segLen : 0;
  out[0] = a[0] + (b[0] - a[0]) * u;
  out[1] = a[1] + (b[1] - a[1]) * u;
  out[2] = a[2] + (b[2] - a[2]) * u;
}

/** DOM label chips: where they attach and on which side of the anchor the chip extends. */
export type LabelAlign = "above" | "left" | "right";
export interface LabelAnchor {
  pos: Vec;
  align: LabelAlign;
}
export const LABEL_ANCHORS: { pump: LabelAnchor; branch: LabelAnchor[] } = {
  pump: { pos: [X.pump, 1.15, 0], align: "above" },
  branch: BRANCH_Z.map((z): LabelAnchor => ({ pos: [X.collector + 0.8, Y + 0.1, z], align: "right" })),
};

/** Fallback mesh bounds used until the meshes have been measured after the first frame (no chip clearance). */
export const RIG_BOUNDS: { min: Vec; max: Vec } = {
  min: [X.tankC - TANK_R - 0.2, 0, -MANIFOLD_HALF_Z],
  max: [X.collector + 0.25, TANK_H, RETURN_Z + PIPE_R],
};
