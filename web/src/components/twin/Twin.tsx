"use client";

import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useLayoutEffect,
  useState,
  type ComponentRef,
  type MutableRefObject,
  type RefObject,
} from "react";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { AdaptiveDpr, OrbitControls, PerformanceMonitor } from "@react-three/drei";
import { Box3, CanvasTexture, DirectionalLight, Group, PCFShadowMap, PerspectiveCamera, SRGBColorSpace, Vector3 } from "three";
import type { GridHelper } from "three";
import { useRig } from "@/lib/store";
import type { Brand } from "@proto/types";
import { useDiscrete } from "./discrete";
import Flow from "./Flow";
import { LabelProjector, LabelsDom, chipVisible, createRegistry, placeChip, type LabelRegistry } from "./Labels";
import { RIG_BOUNDS, type Vec } from "./layout";
import Leak from "./Leak";
import { useLiveSync } from "./live";
import RigModel from "./RigModel";
import { FALLBACK_TOKENS, TwinContext, readCssTokens, resolveAccents, useTheme, type CssTokens, type Theme } from "./theme";

export type TwinView = "topside" | "orbit";

export interface TwinProps {
  /** Camera preset. "topside" = elevated schematic view of the pipes (default); "orbit" = lower 3/4 view. */
  view?: TwinView;
  /** true (default): rotate + zoom allowed, no pan. false: fixed camera, pointer events ignored. */
  interactive?: boolean;
  /** Slow automatic rotation around the rig (default false). */
  autoRotate?: boolean;
  /** DOM labels for tank / pump / master / branches (default true). */
  showLabels?: boolean;
  /** Extra classes for the wrapper (which is `relative h-full w-full overflow-hidden`). */
  className?: string;
  /** Overrides brand.colors from the store, same shape. */
  palette?: Brand["colors"];
}

export interface TwinHandle {
  /** Animate the camera back to the current preset (also clears any user rotation/zoom). */
  resetView(): void;
  /** Switch preset and animate to it. */
  setView(view: TwinView): void;
}

/** Elevation above the ground plane and rotation around the vertical axis, degrees. */
const PRESETS: Record<TwinView, { pitch: number; yaw: number }> = {
  topside: { pitch: 55, yaw: 12 },
  orbit: { pitch: 28, yaw: 38 },
};
const FOV = 38;
/** The projected box of meshes + chips fills this share of the binding canvas dimension. */
const FILL = 0.85;
/** Margin used by the first, corner-based estimate before the screen-space refinement. */
const FIT_MARGIN = 0.15;
const ANIM_S = 0.8;
const COMPACT_PX = 600;
/** Stable object: R3F re-applies camera props when this changes, so it must not be recreated per render. */
const CAMERA = { position: [8, 10, 12] as [number, number, number], fov: FOV, near: 0.1, far: 200 };

const deg = (d: number) => (d * Math.PI) / 180;

type Controls = ComponentRef<typeof OrbitControls>;
interface Bounds {
  min: Vec;
  max: Vec;
}
interface CameraApi {
  /** Fit the camera to the rig for `view`. `w`/`h` override the container size (from a ResizeObserver). */
  goTo(view: TwinView, animate: boolean, w?: number, h?: number): void;
}

/** Unit vector from the rig centre toward the camera for a preset. */
function presetDir(view: TwinView, out: Vector3): Vector3 {
  const { pitch, yaw } = PRESETS[view];
  const p = deg(pitch);
  const y = deg(yaw);
  return out.set(Math.cos(p) * Math.sin(y), Math.sin(p), Math.cos(p) * Math.cos(y)).normalize();
}

const _corner = new Vector3();
const _q = new Vector3();
const _right = new Vector3();
const _up = new Vector3();
const WORLD_UP = new Vector3(0, 1, 0);

/**
 * Distance from `center` along `dir` at which every corner of `b` fits the view with FIT_MARGIN to spare,
 * for the given vertical fov and aspect. Not called per frame.
 */
function fitDistance(b: Bounds, center: Vector3, dir: Vector3, fovDeg: number, aspect: number): number {
  _right.crossVectors(WORLD_UP, dir).normalize();
  _up.crossVectors(dir, _right).normalize();
  const tanH = Math.tan(deg(fovDeg) / 2) * (1 - FIT_MARGIN);
  const tanW = tanH * aspect;
  let d = 0;
  for (let i = 0; i < 8; i++) {
    _corner.set(i & 1 ? b.max[0] : b.min[0], i & 2 ? b.max[1] : b.min[1], i & 4 ? b.max[2] : b.min[2]);
    _q.subVectors(_corner, center);
    const z = _q.dot(dir);
    d = Math.max(d, z + Math.abs(_q.dot(_up)) / tanH, z + Math.abs(_q.dot(_right)) / tanW);
  }
  return d;
}

const ease = (t: number) => t * t * (3 - 2 * t);

/**
 * Inside the Canvas: owns camera presets, fitting and the reset animation.
 * Fits (1) on the first non-zero size, (2) on every size change until the user takes over,
 * (3) once more after the first rendered frame using the real mesh bounding box.
 */
function CameraRig({
  view,
  controls,
  rig,
  registry,
  api,
  userMoved,
}: {
  view: TwinView;
  controls: MutableRefObject<Controls | null>;
  rig: RefObject<Group | null>;
  /** Chips to keep inside the frame (null when labels are off). */
  registry: LabelRegistry | null;
  api: MutableRefObject<CameraApi | null>;
  userMoved: MutableRefObject<boolean>;
}) {
  const camera = useThree((s) => s.camera);
  const size = useThree((s) => s.size);
  const sizeRef = useRef(size);
  sizeRef.current = size;
  const viewRef = useRef(view);
  viewRef.current = view;
  const registryRef = useRef(registry);
  registryRef.current = registry;

  const st = useMemo(
    () => ({
      bounds: { min: [...RIG_BOUNDS.min] as Vec, max: [...RIG_BOUNDS.max] as Vec } as Bounds,
      center: new Vector3(),
      measured: false,
      fitted: false,
      active: false,
      t: 0,
      dir: new Vector3(),
      fromPos: new Vector3(),
      toPos: new Vector3(),
      fromTgt: new Vector3(),
      toTgt: new Vector3(),
      box: new Box3(),
      sb: { minX: 0, minY: 0, maxX: 0, maxY: 0 },
      chip: { left: 0, top: 0 },
    }),
    [],
  );
  const updateCenter = useCallback(() => {
    const { min, max } = st.bounds;
    st.center.set((min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2);
  }, [st]);
  useMemo(updateCenter, [updateCenter]);

  /** Screen-space box (px) of the mesh bounds corners plus every visible chip, for the camera as currently posed. */
  const screenBox = useCallback(
    (width: number, height: number) => {
      const sb = st.sb;
      sb.minX = sb.minY = Infinity;
      sb.maxX = sb.maxY = -Infinity;
      const grow = (x: number, y: number) => {
        if (x < sb.minX) sb.minX = x;
        if (x > sb.maxX) sb.maxX = x;
        if (y < sb.minY) sb.minY = y;
        if (y > sb.maxY) sb.maxY = y;
      };
      const { min, max } = st.bounds;
      for (let i = 0; i < 8; i++) {
        _corner.set(i & 1 ? max[0] : min[0], i & 2 ? max[1] : min[1], i & 4 ? max[2] : min[2]).project(camera);
        grow((_corner.x * 0.5 + 0.5) * width, (-_corner.y * 0.5 + 0.5) * height);
      }
      const reg = registryRef.current;
      if (reg) {
        for (let i = 0; i < reg.length; i++) {
          const e = reg[i];
          const el = e.el;
          if (!el || !chipVisible(e.key)) continue;
          const w = el.offsetWidth;
          const h = el.offsetHeight;
          if (!w || !h) continue;
          _corner.set(e.anchor[0], e.anchor[1], e.anchor[2]).project(camera);
          placeChip(e.align, (_corner.x * 0.5 + 0.5) * width, (-_corner.y * 0.5 + 0.5) * height, w, h, st.chip);
          grow(st.chip.left, st.chip.top);
          grow(st.chip.left + w, st.chip.top + h);
        }
      }
      return sb;
    },
    [camera, st],
  );

  const goTo = useCallback(
    (v: TwinView, animate: boolean, w?: number, h?: number) => {
      if (!(camera instanceof PerspectiveCamera)) return;
      const width = w ?? sizeRef.current.width;
      const height = h ?? sizeRef.current.height;
      if (width < 2 || height < 2) return; // layout not settled yet; a later size change will fit
      const aspect = width / height;
      const c = controls.current;
      st.fromPos.copy(camera.position);
      st.fromTgt.copy(c ? c.target : st.center);

      // 1. corner-based estimate along the preset direction
      presetDir(v, st.dir);
      st.toTgt.copy(st.center);
      let d = fitDistance(st.bounds, st.center, st.dir, camera.fov, aspect);

      // 2. refine: pose the camera, measure the projected box of meshes + chips, centre it and scale to FILL
      const savedAspect = camera.aspect;
      camera.aspect = aspect;
      camera.updateProjectionMatrix();
      const tanHalf = Math.tan(deg(camera.fov) / 2);
      for (let iter = 0; iter < 3; iter++) {
        camera.position.copy(st.toTgt).addScaledVector(st.dir, d);
        camera.lookAt(st.toTgt);
        camera.updateMatrixWorld(true);
        const sb = screenBox(width, height);
        const bw = sb.maxX - sb.minX;
        const bh = sb.maxY - sb.minY;
        if (!(bw > 0 && bh > 0)) break;
        const dx = (sb.minX + sb.maxX) / 2 - width / 2;
        const dy = (sb.minY + sb.maxY) / 2 - height / 2;
        const upp = (2 * d * tanHalf) / height; // world units per pixel on the target plane
        _right.setFromMatrixColumn(camera.matrixWorld, 0);
        _up.setFromMatrixColumn(camera.matrixWorld, 1);
        st.toTgt.addScaledVector(_right, dx * upp).addScaledVector(_up, -dy * upp);
        d *= Math.max(bw / (FILL * width), bh / (FILL * height));
      }
      camera.aspect = savedAspect;
      camera.updateProjectionMatrix();
      st.toPos.copy(st.toTgt).addScaledVector(st.dir, d);
      st.fitted = true;

      if (!animate) {
        st.active = false;
        camera.position.copy(st.toPos);
        if (c) {
          c.target.copy(st.toTgt);
          c.update();
        } else {
          camera.lookAt(st.toTgt);
        }
        return;
      }
      camera.position.copy(st.fromPos); // the refinement moved the camera; animate from where it really was
      if (c) c.update();
      st.t = 0;
      st.active = true;
    },
    [camera, st, controls, screenBox],
  );

  useEffect(() => {
    api.current = { goTo };
    return () => {
      api.current = null;
    };
  }, [api, goTo]);

  // Preset change: animate (snap on the very first mount).
  const mounted = useRef(false);
  useEffect(() => {
    userMoved.current = false;
    goTo(view, mounted.current);
    mounted.current = true;
  }, [view, goTo, userMoved]);

  // R3F's own measurement of the canvas changed: re-fit unless the user has taken over.
  useEffect(() => {
    if (!userMoved.current) goTo(viewRef.current, false, size.width, size.height);
  }, [size.width, size.height, goTo]);

  useFrame((_, delta) => {
    // After the first rendered frame the meshes exist: measure them once and re-fit.
    if (!st.measured && rig.current) {
      st.measured = true;
      rig.current.updateWorldMatrix(true, true);
      st.box.setFromObject(rig.current);
      if (!st.box.isEmpty()) {
        st.bounds.min = [st.box.min.x, Math.min(0, st.box.min.y), st.box.min.z];
        st.bounds.max = [st.box.max.x, st.box.max.y, st.box.max.z];
        updateCenter();
      }
      if (!userMoved.current) goTo(viewRef.current, false);
      return;
    }
    if (!st.active) return;
    st.t = Math.min(1, st.t + Math.min(delta, 0.1) / ANIM_S);
    const e = ease(st.t);
    camera.position.lerpVectors(st.fromPos, st.toPos, e);
    const c = controls.current;
    if (c) {
      c.target.lerpVectors(st.fromTgt, st.toTgt, e);
      c.update();
    } else {
      camera.lookAt(st.toTgt);
    }
    if (st.t >= 1) st.active = false;
  });
  return null;
}

/** Radial alpha gradient (transparent in the middle, page colour at the edge) laid over the grid so it recedes. */
function makeFadeTexture(bg: string): CanvasTexture {
  const c = document.createElement("canvas");
  c.width = c.height = 256;
  const g = c.getContext("2d");
  if (g) {
    const rgb = bg.slice(bg.indexOf("(") + 1, bg.lastIndexOf(")")); // "r, g, b" from three's getStyle()
    const grad = g.createRadialGradient(128, 128, 34, 128, 128, 128);
    grad.addColorStop(0, `rgba(${rgb}, 0)`);
    grad.addColorStop(0.5, `rgba(${rgb}, 0.45)`);
    grad.addColorStop(1, `rgba(${rgb}, 1)`);
    g.fillStyle = grad;
    g.fillRect(0, 0, 256, 256);
  }
  const t = new CanvasTexture(c);
  t.colorSpace = SRGBColorSpace;
  return t;
}

/** Dark ground, a faint large-cell grid that fades with distance, and a slightly lighter slab under the rig. */
/** Renders one frame right after mount so the canvas is never black while the loop is paused. */
function FirstFrame() {
  const advance = useThree((s) => s.advance);
  useEffect(() => {
    advance(performance.now());
  }, [advance]);
  return null;
}

function Ground({ theme }: { theme: Theme }) {
  const bg = theme.bg.getStyle();
  const fade = useMemo(() => makeFadeTexture(bg), [bg]);
  useEffect(() => () => fade.dispose(), [fade]);
  const grid = useRef<GridHelper>(null);
  useEffect(() => {
    const g = grid.current;
    if (!g) return;
    g.material.transparent = true;
    g.material.opacity = 0.06;
    g.material.depthWrite = false;
  }, []);
  return (
    <group>
      <mesh rotation-x={-Math.PI / 2} position={[0.5, -0.2, 0.4]} receiveShadow>
        <planeGeometry args={[80, 80]} />
        <meshStandardMaterial color={theme.ground} roughness={1} metalness={0} />
      </mesh>
      <gridHelper ref={grid} args={[80, 16, theme.grid, theme.grid]} position={[0.5, -0.19, 0.4]} />
      <mesh rotation-x={-Math.PI / 2} position={[0.5, -0.18, 0.4]} renderOrder={1}>
        <planeGeometry args={[80, 80]} />
        <meshBasicMaterial map={fade} transparent depthWrite={false} toneMapped={false} />
      </mesh>
      {/* platform slab: the rig reads as an object on a table */}
      <mesh position={[0.5, -0.09, 0.45]} receiveShadow>
        <boxGeometry args={[15.2, 0.16, 6.4]} />
        <meshStandardMaterial color={theme.slab} metalness={0.1} roughness={0.95} />
      </mesh>
    </group>
  );
}

/** One directional light with a soft shadow map tightly framed around the rig. */
function KeyLight() {
  const ref = useRef<DirectionalLight>(null);
  useEffect(() => {
    const l = ref.current;
    if (!l) return;
    l.target.position.set(0.5, 0, 0.4);
    l.target.updateMatrixWorld();
    l.shadow.camera.updateProjectionMatrix();
  }, []);
  return (
    <directionalLight
      ref={ref}
      position={[4, 13, 7]}
      intensity={1.6}
      castShadow
      shadow-mapSize-width={1024}
      shadow-mapSize-height={1024}
      shadow-camera-left={-9}
      shadow-camera-right={9}
      shadow-camera-top={6}
      shadow-camera-bottom={-6}
      shadow-camera-near={2}
      shadow-camera-far={40}
      shadow-bias={-0.0004}
      shadow-normalBias={0.02}
      shadow-radius={4}
    />
  );
}

/**
 * Embeddable live 3D twin of the rig. Fills its parent (give the parent a size); re-fits the camera as the
 * container resizes until the user rotates or zooms; pauses when the tab is hidden or the wrapper is scrolled
 * out of view. Continuous animation reads telemetry from a mutable ref; only discrete changes re-render.
 */
const Twin = forwardRef<TwinHandle, TwinProps>(function Twin(
  { view = "topside", interactive = true, autoRotate = false, showLabels = true, className = "", palette },
  ref,
) {
  const brand = useRig((s) => s.brand);
  // shadcn variables are read from the wrapper once mounted, so the twin follows the page theme.
  const [tokens, setTokens] = useState<CssTokens | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (wrapRef.current) setTokens(readCssTokens(wrapRef.current));
  }, []);
  const accents = useMemo(() => resolveAccents(brand, tokens ?? FALLBACK_TOKENS, palette), [brand, tokens, palette]);
  const theme = useTheme(accents, tokens ?? FALLBACK_TOKENS);
  const d = useDiscrete();
  useLiveSync();

  const [viewState, setViewState] = useState<TwinView>(view);
  useEffect(() => {
    setViewState(view);
  }, [view]);
  const viewRef = useRef(viewState);
  viewRef.current = viewState;

  const rigRef = useRef<Group | null>(null);
  const controlsRef = useRef<Controls | null>(null);
  const apiRef = useRef<CameraApi | null>(null);
  const userMoved = useRef(false);

  useImperativeHandle(
    ref,
    () => ({
      resetView() {
        userMoved.current = false;
        apiRef.current?.goTo(viewRef.current, true);
      },
      setView(v) {
        userMoved.current = false;
        setViewState(v);
      },
    }),
    [],
  );

  // Frame loop only while the tab is visible and the wrapper is on screen.
  const [dpr, setDpr] = useState(1.5);
  const [tabVisible, setTabVisible] = useState(true);
  const [inView, setInView] = useState(true);
  const [compact, setCompact] = useState(false);
  // Only an explicit report pauses the loop: an occluded window may never deliver observer callbacks.
  useEffect(() => {
    const onVis = () => setTabVisible(!document.hidden);
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, []);
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const io = new IntersectionObserver((entries) => {
      const entry = entries[entries.length - 1];
      if (entry) setInView(entry.isIntersecting);
    }, { threshold: 0.01 });
    io.observe(el);
    // Wrapper size drives the compact labels and re-fits the camera (fresh dimensions, not R3F's debounced ones).
    const ro = new ResizeObserver(([entry]) => {
      const w = entry?.contentRect.width ?? el.clientWidth;
      const h = entry?.contentRect.height ?? el.clientHeight;
      setCompact(w < COMPACT_PX);
      if (!userMoved.current) apiRef.current?.goTo(viewRef.current, false, w, h);
    });
    ro.observe(el);
    return () => {
      io.disconnect();
      ro.disconnect();
    };
  }, []);
  const frameloop = tabVisible && inView ? "always" : "never";

  const registry = useMemo(() => createRegistry(), []);
  const ctx = useMemo(() => ({ theme, brand }), [theme, brand]);

  return (
    <div ref={wrapRef} className={`relative h-full w-full overflow-hidden ${className}`} style={{ background: "var(--background)" }}>
      {tokens && (
      <div className="absolute inset-0">
        <Canvas
          dpr={dpr}
          frameloop={frameloop}
          shadows={{ type: PCFShadowMap }}
          gl={{ antialias: true, powerPreference: "high-performance", alpha: false }}
          camera={CAMERA}
          style={{ pointerEvents: interactive ? "auto" : "none" }}
        >
          <color attach="background" args={[theme.bg]} />
          <TwinContext.Provider value={ctx}>
            <PerformanceMonitor onDecline={() => setDpr(1)} onIncline={() => setDpr(1.5)} onFallback={() => setDpr(1)} flipflops={3} />
            <AdaptiveDpr pixelated />
            <ambientLight intensity={0.35} />
            <hemisphereLight args={[theme.glass, theme.bg, 0.45]} />
            <KeyLight />
            <Ground theme={theme} />
            <group ref={rigRef}>
              <RigModel state={d} />
            </group>
            <Flow />
            <Leak levels={d.leak} />
            {showLabels && <LabelProjector registry={registry} />}
            <OrbitControls
              ref={controlsRef}
              enabled={interactive}
              enableRotate={interactive}
              enableZoom={interactive}
              enablePan={false}
              enableDamping
              dampingFactor={0.08}
              autoRotate={autoRotate}
              autoRotateSpeed={0.4}
              minDistance={4}
              maxDistance={40}
              minPolarAngle={0.12}
              maxPolarAngle={Math.PI / 2 - 0.06}
              onStart={() => {
                userMoved.current = true;
              }}
              regress
            />
            <CameraRig view={viewState} controls={controlsRef} rig={rigRef} registry={showLabels ? registry : null} api={apiRef} userMoved={userMoved} />
            <FirstFrame />
          </TwinContext.Provider>
        </Canvas>
      </div>
      )}
      {showLabels && <LabelsDom registry={registry} brand={brand} compact={compact} />}
    </div>
  );
});

export default Twin;
export { Twin };
