"use client";

import { useLayoutEffect, useMemo, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import { InstancedMesh, Object3D, PointLight } from "three";
import type { Color } from "three";
import type { LeakLevel } from "@proto/types";
import { BRANCH_Z, X, Y } from "./layout";
import { reducedMotion } from "./live";
import { useTwin } from "./theme";

const MAX = 60;
/** Active droplets per leak level: ok, warn (a few drips), drip, burst (fountain). */
const ACTIVE: Record<LeakLevel, number> = { 0: 0, 1: 0, 2: 32, 3: 60 };
const STRENGTH: Record<LeakLevel, number> = { 0: 0, 1: 0, 2: 0.8, 3: 1 };
const G = 7;

/** Small deterministic PRNG so the spray looks the same on every load. */
function mulberry32(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function PulseLight({ position, color }: { position: [number, number, number]; color: Color }) {
  const ref = useRef<PointLight>(null);
  useFrame((s) => {
    const l = ref.current;
    if (l) l.intensity = 6 + 4 * Math.sin(s.clock.elapsedTime * Math.PI * 2);
  });
  return <pointLight ref={ref} position={position} color={color} intensity={6} distance={7} decay={2} />;
}

const BRANCHES = 2;

/**
 * Ballistic droplets from each branch's leak point; count and strength follow the leak level.
 * Only branch 1 has meters, so in practice only its level can ever rise - see docs/PROTOCOL.md §0.
 */
export default function Leak({ levels }: { levels: [LeakLevel, LeakLevel] }) {
  const { theme } = useTwin();
  const ref = useRef<InstancedMesh>(null);
  const lv = useRef(levels);
  lv.current = levels;
  const dummy = useMemo(() => new Object3D(), []);
  const still = useMemo(() => reducedMotion(), []);

  const drops = useMemo(() => {
    const rnd = mulberry32(1234);
    const n = BRANCHES * MAX;
    const vx = new Float32Array(n);
    const vy = new Float32Array(n);
    const vz = new Float32Array(n);
    const phase = new Float32Array(n);
    const size = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const ang = rnd() * Math.PI * 2;
      const r = 0.3 + rnd() * 1.1;
      vx[i] = Math.cos(ang) * r;
      vz[i] = Math.sin(ang) * r;
      vy[i] = 2.6 + rnd() * 2.2;
      phase[i] = rnd() * 3;
      size[i] = 0.7 + rnd() * 0.6;
    }
    return { vx, vy, vz, phase, size };
  }, []);

  useLayoutEffect(() => {
    const mesh = ref.current;
    if (!mesh) return;
    dummy.scale.setScalar(0);
    dummy.updateMatrix();
    for (let i = 0; i < BRANCHES * MAX; i++) mesh.setMatrixAt(i, dummy.matrix);
    mesh.instanceMatrix.needsUpdate = true;
  }, [dummy]);

  useFrame((s) => {
    const mesh = ref.current;
    if (!mesh) return;
    const t = still ? 0.35 : s.clock.elapsedTime; // reduced motion: a frozen burst instead of animated spray
    for (let b = 0; b < BRANCHES; b++) {
      const level = lv.current[b];
      const n = ACTIVE[level];
      const k = STRENGTH[level];
      const oy = Y + 0.13;
      const oz = BRANCH_Z[b];
      for (let i = 0; i < MAX; i++) {
        const idx = b * MAX + i;
        if (i >= n) {
          dummy.scale.setScalar(0);
        } else {
          const uy = drops.vy[idx] * k;
          const life = (2 * uy) / G; // time to fall back to the pipe height
          const age = (t + drops.phase[idx]) % life;
          dummy.position.set(
            X.leak + drops.vx[idx] * k * age,
            oy + uy * age - 0.5 * G * age * age,
            oz + drops.vz[idx] * k * age,
          );
          dummy.scale.setScalar(drops.size[idx]);
        }
        dummy.updateMatrix();
        mesh.setMatrixAt(idx, dummy.matrix);
      }
    }
    mesh.instanceMatrix.needsUpdate = true;
  });

  return (
    <group>
      <instancedMesh ref={ref} args={[undefined, undefined, BRANCHES * MAX]} frustumCulled={false}>
        <sphereGeometry args={[0.09, 6, 6]} />
        <meshBasicMaterial color={theme.danger} toneMapped={false} transparent opacity={0.9} />
      </instancedMesh>
      {levels.map((l, i) =>
        l >= 2 ? <PulseLight key={i} position={[X.leak, Y + 1.1, BRANCH_Z[i]]} color={theme.danger} /> : null,
      )}
    </group>
  );
}
