"use client";

import { useLayoutEffect, useMemo, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import { InstancedMesh, Object3D } from "three";
import { PATHS, buildPathGeom, pointAt, type FlowPath } from "./layout";
import { liveRate, liveReturnRate, reducedMotion } from "./live";
import { useTwin } from "./theme";

const PER_PATH = 36;
const COUNT = PATHS.length * PER_PATH;

function rateFor(p: FlowPath): number {
  return p.sensor === "ret" ? liveReturnRate() : liveRate(p.sensor);
}

/**
 * One InstancedMesh of small spheres travelling along every pipe path.
 * Speed is proportional to that pipe's L/min; a path with no flow is collapsed to scale 0.
 */
export default function Flow() {
  const { theme } = useTwin();
  const ref = useRef<InstancedMesh>(null);
  const geoms = useMemo(() => PATHS.map(buildPathGeom), []);
  const progress = useMemo(() => new Float32Array(PATHS.length), []);
  const smooth = useMemo(() => new Float32Array(PATHS.length), []);
  const dummy = useMemo(() => new Object3D(), []);
  const tmp = useMemo(() => new Float32Array(3), []);
  const still = useMemo(() => reducedMotion(), []);

  // Hide everything until the first animated frame.
  useLayoutEffect(() => {
    const mesh = ref.current;
    if (!mesh) return;
    dummy.scale.setScalar(0);
    dummy.updateMatrix();
    for (let i = 0; i < COUNT; i++) mesh.setMatrixAt(i, dummy.matrix);
    mesh.instanceMatrix.needsUpdate = true;
  }, [dummy]);

  useFrame((_, delta) => {
    const mesh = ref.current;
    if (!mesh) return;
    const dt = Math.min(delta, 0.1);
    for (let p = 0; p < PATHS.length; p++) {
      const target = rateFor(PATHS[p]);
      smooth[p] += (target - smooth[p]) * Math.min(1, dt * 3);
      const rate = smooth[p];
      const visible = rate > 0.03;
      const g = geoms[p];
      if (visible && !still) {
        const speed = Math.min(6, rate * 1.6); // scene units per second, proportional to L/min
        progress[p] = (progress[p] + (speed * dt) / g.total) % 1;
      }
      const scale = visible ? 0.7 + 0.3 * Math.min(1, rate / 2) : 0;
      for (let k = 0; k < PER_PATH; k++) {
        if (visible) {
          pointAt(g, (progress[p] + k / PER_PATH) % 1, tmp);
          dummy.position.set(tmp[0], tmp[1], tmp[2]);
        }
        dummy.scale.setScalar(scale);
        dummy.updateMatrix();
        mesh.setMatrixAt(p * PER_PATH + k, dummy.matrix);
      }
    }
    mesh.instanceMatrix.needsUpdate = true;
  });

  return (
    <instancedMesh ref={ref} args={[undefined, undefined, COUNT]} frustumCulled={false}>
      <sphereGeometry args={[0.11, 8, 8]} />
      <meshBasicMaterial color={theme.particle} toneMapped={false} />
    </instancedMesh>
  );
}
