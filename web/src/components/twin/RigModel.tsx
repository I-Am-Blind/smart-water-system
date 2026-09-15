"use client";

import { useMemo, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import { DoubleSide, Group, Mesh, MeshBasicMaterial, MeshStandardMaterial, Quaternion, Vector3 } from "three";
import type { Color } from "three";
import type { LeakLevel } from "@proto/types";
import { BRANCH_Z, LEAK_HALF, MANIFOLD_HALF_Z, PIPE_R, RETURN_Z, TANK_H, TANK_R, X, Y, type Vec } from "./layout";
import { liveRate, liveReturnRate } from "./live";
import { useTwin } from "./theme";
import type { Discrete } from "./discrete";

const UP = new Vector3(0, 1, 0);
const _a = new Vector3();
const _b = new Vector3();

/** Position, orientation and length of a straight segment (memoised; endpoints are module constants). */
function useSegment(from: Vec, to: Vec) {
  return useMemo(() => {
    _a.set(from[0], from[1], from[2]);
    _b.set(to[0], to[1], to[2]);
    const dir = _b.clone().sub(_a);
    const length = dir.length();
    const quaternion = new Quaternion().setFromUnitVectors(UP, dir.normalize());
    const position = _a.clone().add(_b).multiplyScalar(0.5);
    return { position, quaternion, length };
  }, [from, to]);
}

/** Translucent steel pipe between two points; the water tube inside shows through when it flows. */
function Pipe({ from, to, color }: { from: Vec; to: Vec; color: Color }) {
  const { position, quaternion, length } = useSegment(from, to);
  return (
    <mesh position={position} quaternion={quaternion} castShadow>
      <cylinderGeometry args={[PIPE_R, PIPE_R, length, 16]} />
      <meshStandardMaterial color={color} metalness={0.4} roughness={0.5} transparent opacity={0.55} depthWrite={false} />
    </mesh>
  );
}

/** Emissive cyan core inside a pipe; visible only while that segment carries flow, brighter with more L/min. */
function WaterTube({ from, to, sensor }: { from: Vec; to: Vec; sensor: number | "ret" }) {
  const { theme } = useTwin();
  const { position, quaternion, length } = useSegment(from, to);
  const mesh = useRef<Mesh>(null);
  const mat = useRef<MeshBasicMaterial>(null);
  useFrame(() => {
    const m = mesh.current;
    const mm = mat.current;
    if (!m || !mm) return;
    const rate = sensor === "ret" ? liveReturnRate() : liveRate(sensor);
    const vis = rate > 0.03;
    m.visible = vis;
    if (vis) mm.color.copy(theme.water).multiplyScalar(Math.min(1.9, 0.7 + rate * 0.6));
  });
  return (
    <mesh ref={mesh} position={position} quaternion={quaternion} visible={false}>
      <cylinderGeometry args={[PIPE_R * 0.7, PIPE_R * 0.7, length, 12]} />
      <meshBasicMaterial ref={mat} color={theme.water} toneMapped={false} />
    </mesh>
  );
}

/** Rounded corner where two pipes meet. */
function Joint({ at, color, r = PIPE_R * 1.18 }: { at: Vec; color: Color; r?: number }) {
  return (
    <mesh position={at} castShadow>
      <sphereGeometry args={[r, 12, 12]} />
      <meshStandardMaterial color={color} metalness={0.4} roughness={0.5} />
    </mesh>
  );
}

/** Reservoir: a static translucent vessel (the rig does not measure its level, so none is drawn). */
function Tank() {
  const { theme } = useTwin();
  return (
    <group position={[X.tankC, 0, 0]}>
      <mesh position={[0, 0.04, 0]} castShadow>
        <cylinderGeometry args={[TANK_R + 0.15, TANK_R + 0.2, 0.08, 32]} />
        <meshStandardMaterial color={theme.dark} metalness={0.4} roughness={0.7} />
      </mesh>
      <mesh position={[0, TANK_H / 2, 0]} castShadow>
        <cylinderGeometry args={[TANK_R, TANK_R, TANK_H, 32, 1, true]} />
        <meshStandardMaterial color={theme.glass} transparent opacity={0.18} roughness={0.1} metalness={0.2} depthWrite={false} side={DoubleSide} />
      </mesh>
      <mesh position={[0, TANK_H, 0]} rotation-x={Math.PI / 2}>
        <torusGeometry args={[TANK_R, 0.05, 8, 40]} />
        <meshStandardMaterial color={theme.metal} metalness={0.7} roughness={0.35} />
      </mesh>
    </group>
  );
}

function Pump({ on }: { on: boolean }) {
  const { theme } = useTwin();
  const ring = useRef<MeshStandardMaterial>(null);
  const onRef = useRef(on);
  onRef.current = on;
  useFrame((s) => {
    const m = ring.current;
    if (!m) return;
    m.emissiveIntensity = onRef.current ? 0.9 + 0.6 * Math.sin(s.clock.elapsedTime * 5) : 0.06;
  });
  return (
    <group position={[X.pump, Y, 0]}>
      <mesh castShadow>
        <boxGeometry args={[0.95, 0.78, 0.78]} />
        <meshStandardMaterial color={theme.dark} metalness={0.5} roughness={0.55} />
      </mesh>
      <mesh position={[0, 0.2, -0.55]} rotation-x={Math.PI / 2} castShadow>
        <cylinderGeometry args={[0.26, 0.26, 0.5, 20]} />
        <meshStandardMaterial color={theme.metal} metalness={0.7} roughness={0.4} />
      </mesh>
      <mesh position={[0, 0.42, 0]} rotation-x={Math.PI / 2}>
        <torusGeometry args={[0.28, 0.04, 8, 36]} />
        <meshStandardMaterial ref={ring} color={on ? theme.accent : theme.closed} emissive={on ? theme.accent : theme.closed} emissiveIntensity={0.06} toneMapped={false} />
      </mesh>
    </group>
  );
}

/** Flow sensor: housing across the pipe plus a rotor disc on top spinning with the flow. */
function Sensor({ x, z, sensor }: { x: number; z: number; sensor: number }) {
  const { theme } = useTwin();
  const rotor = useRef<Group>(null);
  useFrame((_, delta) => {
    const g = rotor.current;
    if (g) g.rotation.y += liveRate(sensor) * 5 * Math.min(delta, 0.1);
  });
  return (
    <group position={[x, Y, z]}>
      <mesh rotation-z={Math.PI / 2} castShadow>
        <cylinderGeometry args={[0.3, 0.3, 0.55, 20]} />
        <meshStandardMaterial color={theme.metal} metalness={0.6} roughness={0.45} />
      </mesh>
      <mesh position={[0, 0.3, 0]} castShadow>
        <cylinderGeometry args={[0.14, 0.14, 0.18, 12]} />
        <meshStandardMaterial color={theme.dark} metalness={0.5} roughness={0.6} />
      </mesh>
      <group ref={rotor} position={[0, 0.44, 0]}>
        <mesh castShadow>
          <cylinderGeometry args={[0.22, 0.22, 0.04, 16]} />
          <meshStandardMaterial color={theme.metal} metalness={0.6} roughness={0.45} />
        </mesh>
        <mesh position={[0, 0.03, 0]}>
          <boxGeometry args={[0.4, 0.02, 0.06]} />
          <meshStandardMaterial color={theme.dark} />
        </mesh>
      </group>
    </group>
  );
}

/** Solenoid valve: coil colour by state, lever turns across the pipe when closed. */
function Valve({ x, z, open, latched }: { x: number; z: number; open: boolean; latched: boolean }) {
  const { theme } = useTwin();
  const lever = useRef<Group>(null);
  const target = useRef(open ? 0 : Math.PI / 2);
  target.current = open ? 0 : Math.PI / 2;
  useFrame((_, delta) => {
    const g = lever.current;
    if (g) g.rotation.y += (target.current - g.rotation.y) * Math.min(1, delta * 6);
  });
  const color = latched ? theme.danger : open ? theme.metal : theme.closed;
  return (
    <group position={[x, Y, z]}>
      <mesh castShadow>
        <boxGeometry args={[0.5, 0.56, 0.5]} />
        <meshStandardMaterial color={theme.dark} metalness={0.5} roughness={0.55} />
      </mesh>
      <mesh position={[0, 0.42, 0]} castShadow>
        <cylinderGeometry args={[0.16, 0.16, 0.3, 14]} />
        <meshStandardMaterial color={color} emissive={color} emissiveIntensity={latched ? 0.9 : 0} metalness={0.5} roughness={0.5} toneMapped={false} />
      </mesh>
      <group ref={lever} position={[0, 0.62, 0]}>
        <mesh castShadow>
          <boxGeometry args={[0.52, 0.05, 0.09]} />
          <meshStandardMaterial color={theme.metal} metalness={0.7} roughness={0.35} />
        </mesh>
      </group>
    </group>
  );
}

function Block({ x, color }: { x: number; color: Color }) {
  return (
    <mesh position={[x, Y, 0]} castShadow>
      <boxGeometry args={[0.5, 0.72, MANIFOLD_HALF_Z * 2]} />
      <meshStandardMaterial color={color} metalness={0.5} roughness={0.5} />
    </mesh>
  );
}

/**
 * The pipe section where a leak is simulated. ok: steel; warn: amber tint; drip/burst: red, pulsing at 1 Hz
 * along its whole length.
 */
function LeakSegment({ z, level }: { z: number; level: LeakLevel }) {
  const { theme } = useTwin();
  const mat = useRef<MeshStandardMaterial>(null);
  const lvl = useRef(level);
  lvl.current = level;
  useFrame((s) => {
    const m = mat.current;
    if (!m) return;
    const l = lvl.current;
    m.emissiveIntensity = l >= 2 ? 1.2 + 0.8 * Math.sin(s.clock.elapsedTime * Math.PI * 2) : l === 1 ? 0.45 : 0;
  });
  const color = level === 0 ? theme.pipe : level === 1 ? theme.warn : theme.danger;
  return (
    <mesh position={[X.leak, Y, z]} rotation-z={Math.PI / 2} castShadow>
      <cylinderGeometry args={[PIPE_R * 1.08, PIPE_R * 1.08, LEAK_HALF * 2, 16]} />
      <meshStandardMaterial ref={mat} color={color} emissive={color} emissiveIntensity={0} metalness={0.4} roughness={0.5} toneMapped={false} />
    </mesh>
  );
}

// Static endpoints (module constants keep useSegment's memo stable).
const MAIN: [Vec, Vec] = [[X.tankOut, Y, 0], [X.manifold - 0.25, Y, 0]];
const BRANCH_PIPES = BRANCH_Z.map((z): { z: number; a: [Vec, Vec]; b: [Vec, Vec] } => ({
  z,
  a: [[X.manifold + 0.25, Y, z], [X.leak - LEAK_HALF, Y, z]],
  b: [[X.leak + LEAK_HALF, Y, z], [X.collector - 0.25, Y, z]],
}));
const RET1: [Vec, Vec] = [[X.collector, Y, BRANCH_Z[2]], [X.collector, Y, RETURN_Z]];
const RET2: [Vec, Vec] = [[X.collector, Y, RETURN_Z], [X.tankC, Y, RETURN_Z]];
const RET3: [Vec, Vec] = [[X.tankC, Y, RETURN_Z], [X.tankC, Y, TANK_R]];
const RET_J1: Vec = [X.collector, Y, RETURN_Z];
const RET_J2: Vec = [X.tankC, Y, RETURN_Z];

/** Every mesh of the rig (no ground, no platform) so the camera can measure it. */
export default function RigModel({ state }: { state: Discrete }) {
  const { theme } = useTwin();
  const pipe = theme.pipe;
  return (
    <group>
      <Tank />
      <WaterTube from={MAIN[0]} to={MAIN[1]} sensor={0} />
      <Pipe from={MAIN[0]} to={MAIN[1]} color={pipe} />
      <Pump on={state.pump} />
      <Sensor x={X.master} z={0} sensor={0} />
      <Block x={X.manifold} color={theme.metal} />

      {BRANCH_PIPES.map((bp, i) => (
        <group key={bp.z}>
          <WaterTube from={bp.a[0]} to={bp.a[1]} sensor={2 * i + 1} />
          <WaterTube from={bp.b[0]} to={bp.b[1]} sensor={2 * i + 2} />
          <Pipe from={bp.a[0]} to={bp.a[1]} color={pipe} />
          <LeakSegment z={bp.z} level={state.leak[i]} />
          <Pipe from={bp.b[0]} to={bp.b[1]} color={pipe} />
          <Valve x={X.valve} z={bp.z} open={state.valves[i]} latched={state.leak[i] >= 2} />
          <Sensor x={X.inSensor} z={bp.z} sensor={2 * i + 1} />
          <Sensor x={X.outSensor} z={bp.z} sensor={2 * i + 2} />
        </group>
      ))}

      <Block x={X.collector} color={theme.metal} />
      <WaterTube from={RET1[0]} to={RET1[1]} sensor="ret" />
      <WaterTube from={RET2[0]} to={RET2[1]} sensor="ret" />
      <WaterTube from={RET3[0]} to={RET3[1]} sensor="ret" />
      <Pipe from={RET1[0]} to={RET1[1]} color={pipe} />
      <Joint at={RET_J1} color={pipe} />
      <Pipe from={RET2[0]} to={RET2[1]} color={pipe} />
      <Joint at={RET_J2} color={pipe} />
      <Pipe from={RET3[0]} to={RET3[1]} color={pipe} />
    </group>
  );
}
