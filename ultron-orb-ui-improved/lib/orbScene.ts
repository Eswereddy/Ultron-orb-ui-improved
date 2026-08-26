import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";
import { ShaderPass } from "three/addons/postprocessing/ShaderPass.js";

export type ThemeName = "ultron" | "jarvis" | "vibranium";
export const THEME_NAMES: ThemeName[] = ["ultron", "jarvis", "vibranium"];

export interface OrbSceneOptions {
  /** Called roughly twice a second with the current render fps. */
  onFps?(fps: number): void;
  /** Initial color theme. Defaults to "ultron". */
  theme?: ThemeName;
}

export interface OrbSceneApi {
  /** Rotate the camera around the orb by the given angles (radians). */
  rotateBy(deltaTheta: number, deltaPhi: number): void;
  /** Multiply the camera distance by `factor` (<1 zooms in, >1 zooms out). */
  zoomBy(factor: number): void;
  zoomIn(): void;
  zoomOut(): void;
  resetView(): void;
  /** Swap the orb's color palette without rebuilding the scene. */
  setTheme(theme: ThemeName): void;
  getTheme(): ThemeName;
  /** When enabled, the orb slowly spins on its own after a few seconds of no input. */
  setAutoRotate(enabled: boolean): void;
  /** Renders one clean frame and returns it as a PNG data URL. */
  captureImage(): string;
  dispose(): void;
}

const HOME_POSITION = new THREE.Vector3(0, 0.5, 5.5);
const MIN_DISTANCE = 0.6;
const MAX_DISTANCE = 40;
const AUTO_ROTATE_IDLE_MS = 4000;

// ═══════════════════════════════════════════════
// THEME / COLOR SYSTEM
// ═══════════════════════════════════════════════
type Role = "bright" | "mid" | "dim" | "faint" | "hot";

const THEME_COLORS: Record<ThemeName, Record<Role, number>> = {
  ultron: { bright: 0xffaa30, mid: 0xdd7700, dim: 0x884400, faint: 0x553300, hot: 0xffcc66 },
  jarvis: { bright: 0x33ccff, mid: 0x0f8fbf, dim: 0x0a4a63, faint: 0x052733, hot: 0x99e6ff },
  vibranium: { bright: 0xb266ff, mid: 0x7a33cc, dim: 0x442066, faint: 0x241033, hot: 0xdcaaff },
};

// Post-processing color-grade push, per theme (see chromaticShader below).
const THEME_TINT: Record<ThemeName, THREE.Vector3> = {
  ultron: new THREE.Vector3(1.15, 0.85, 0.55),
  jarvis: new THREE.Vector3(0.75, 1.05, 1.3),
  vibranium: new THREE.Vector3(1.05, 0.85, 1.3),
};

// ═══════════════════════════════════════════════
// PERFORMANCE / QUALITY TIERS
// ═══════════════════════════════════════════════
type Quality = "low" | "medium" | "high";

interface QualityPreset {
  dust: number;
  debris: number;
  textOuter: number;
  textInner: number;
  textAmbient: number;
  bloomStrength: number;
  bloomHalfRes: boolean;
  pixelRatioCap: number;
  antialias: boolean;
  chromatic: boolean;
  flicker: boolean;
}

const QUALITY_PRESETS: Record<Quality, QualityPreset> = {
  low: {
    dust: 450,
    debris: 70,
    textOuter: 260,
    textInner: 35,
    textAmbient: 110,
    bloomStrength: 1.3,
    bloomHalfRes: true,
    pixelRatioCap: 1,
    antialias: false,
    chromatic: false,
    flicker: false,
  },
  medium: {
    dust: 1100,
    debris: 160,
    textOuter: 700,
    textInner: 70,
    textAmbient: 250,
    bloomStrength: 1.6,
    bloomHalfRes: false,
    pixelRatioCap: 1.5,
    antialias: true,
    chromatic: true,
    flicker: true,
  },
  high: {
    dust: 2000,
    debris: 250,
    textOuter: 1200,
    textInner: 100,
    textAmbient: 400,
    bloomStrength: 1.8,
    bloomHalfRes: false,
    pixelRatioCap: 2,
    antialias: true,
    chromatic: true,
    flicker: true,
  },
};

function detectQuality(): Quality {
  if (typeof window === "undefined" || typeof navigator === "undefined") return "high";
  const nav = navigator as Navigator & { deviceMemory?: number };
  const cores = navigator.hardwareConcurrency || 4;
  const mem = nav.deviceMemory ?? 4;
  const coarsePointer = window.matchMedia?.("(pointer: coarse)")?.matches ?? false;
  const smallScreen = Math.min(window.innerWidth, window.innerHeight) < 500;

  if (cores <= 4 && (coarsePointer || smallScreen || mem <= 4)) return "low";
  if (cores <= 6 || (coarsePointer && !smallScreen)) return "medium";
  return "high";
}

function detectReducedMotion(): boolean {
  if (typeof window === "undefined") return false;
  return window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches ?? false;
}

export function createOrbScene(
  container: HTMLElement,
  options: OrbSceneOptions = {},
): OrbSceneApi {
  const width = container.clientWidth;
  const height = container.clientHeight;

  let currentTheme: ThemeName = options.theme ?? "ultron";
  const quality = detectQuality();
  const preset = QUALITY_PRESETS[quality];
  const reducedMotion = detectReducedMotion();
  const motionScale = reducedMotion ? 0.15 : 1;

  function themeColor(role: Role): number {
    return THEME_COLORS[currentTheme][role];
  }

  // ——— Registry of every material tagged with a role, so a theme swap ———
  // ——— only needs to touch `.color`, never rebuild geometry.          ———
  const registry: Record<Role, THREE.Material[]> = {
    bright: [],
    mid: [],
    dim: [],
    faint: [],
    hot: [],
  };

  function regColor<T extends THREE.Material & { color: THREE.Color }>(mat: T, role: Role): T {
    registry[role].push(mat);
    return mat;
  }

  // ——— SCENE ———
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(55, width / height, 0.1, 500);
  camera.position.copy(HOME_POSITION);

  const renderer = new THREE.WebGLRenderer({
    antialias: preset.antialias,
    powerPreference: "high-performance",
    preserveDrawingBuffer: true, // required so captureImage() can read back a frame
  });
  renderer.setSize(width, height);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, preset.pixelRatioCap));
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 0.8;
  container.appendChild(renderer.domElement);

  // ——— POST PROCESSING ———
  const composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));

  const bloomSize = preset.bloomHalfRes
    ? new THREE.Vector2(Math.max(1, width / 2), Math.max(1, height / 2))
    : new THREE.Vector2(width, height);
  const bloom = new UnrealBloomPass(bloomSize, preset.bloomStrength, 0.4, 0.2);
  composer.addPass(bloom);

  // Chromatic aberration + color grade shader (skipped entirely on low tier)
  const chromaticShader = {
    uniforms: {
      tDiffuse: { value: null },
      uTime: { value: 0 },
      uIntensity: { value: 0.003 },
      uTint: { value: THEME_TINT[currentTheme].clone() },
    },
    vertexShader: `
      varying vec2 vUv;
      void main() {
        vUv = uv;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: `
      uniform sampler2D tDiffuse;
      uniform float uTime;
      uniform float uIntensity;
      uniform vec3 uTint;
      varying vec2 vUv;
      void main() {
        vec2 dir = vUv - vec2(0.5);
        float d = length(dir);
        float offset = uIntensity * d;
        // Slight flicker
        float flicker = 1.0 + 0.02 * sin(uTime * 30.0) * sin(uTime * 7.3);
        vec4 cr = texture2D(tDiffuse, vUv + dir * offset);
        vec4 cg = texture2D(tDiffuse, vUv);
        vec4 cb = texture2D(tDiffuse, vUv - dir * offset * 0.5);
        gl_FragColor = vec4(cr.r, cg.g * 1.05, cb.b * 0.6, 1.0) * flicker;
        // Push towards the active theme's tone
        gl_FragColor.rgb = mix(gl_FragColor.rgb, gl_FragColor.rgb * uTint, 0.3);
      }
    `,
  };
  const chromaticPass = preset.chromatic ? new ShaderPass(chromaticShader) : null;
  if (chromaticPass) composer.addPass(chromaticPass);

  // Controls
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.04;
  controls.minDistance = MIN_DISTANCE;
  controls.maxDistance = MAX_DISTANCE;
  controls.zoomSpeed = 1.4;
  controls.enablePan = false;
  controls.autoRotateSpeed = 0.6;

  let autoRotateEnabled = false;
  let lastInteraction = performance.now();
  function markInteraction() {
    lastInteraction = performance.now();
  }
  controls.addEventListener("start", markInteraction);

  // ——— ORB ROOT ———
  const orbGroup = new THREE.Group();
  scene.add(orbGroup);

  // ——— MATERIAL HELPERS ———
  function lineMat(role: Role, opacity = 1) {
    const m = new THREE.LineBasicMaterial({
      color: themeColor(role),
      transparent: true,
      opacity,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    return regColor(m, role);
  }

  function basicMat(role: Role, opacity = 1, extra: THREE.MeshBasicMaterialParameters = {}) {
    const m = new THREE.MeshBasicMaterial({
      color: themeColor(role),
      transparent: true,
      opacity,
      blending: THREE.AdditiveBlending,
      ...extra,
    });
    return regColor(m, role);
  }

  // ——— UTILITY: Create ring at latitude ———
  function latRing(radius: number, lat: number, segs = 120) {
    const r = radius * Math.cos(lat);
    const y = radius * Math.sin(lat);
    const pts: THREE.Vector3[] = [];
    for (let i = 0; i <= segs; i++) {
      const a = (i / segs) * Math.PI * 2;
      pts.push(new THREE.Vector3(r * Math.cos(a), y, r * Math.sin(a)));
    }
    return new THREE.BufferGeometry().setFromPoints(pts);
  }

  // ——— UTILITY: Create meridian ———
  function meridian(radius: number, lon: number, segs = 120) {
    const pts: THREE.Vector3[] = [];
    for (let i = 0; i <= segs; i++) {
      const lat = (i / segs) * Math.PI - Math.PI / 2;
      pts.push(
        new THREE.Vector3(
          radius * Math.cos(lat) * Math.cos(lon),
          radius * Math.sin(lat),
          radius * Math.cos(lat) * Math.sin(lon),
        ),
      );
    }
    return new THREE.BufferGeometry().setFromPoints(pts);
  }

  // ═══════════════════════════════════════════════
  // LAYER 1: OUTER SHELL — dense wireframe grid
  // ═══════════════════════════════════════════════
  const outerShell = new THREE.Group();
  const R1 = 2.0;

  for (let i = -15; i <= 15; i++) {
    const lat = (i / 15) * (Math.PI / 2) * 0.95;
    const opacity = i % 3 === 0 ? 0.5 : 0.12;
    const role: Role = i % 3 === 0 ? "mid" : "faint";
    outerShell.add(new THREE.Line(latRing(R1, lat), lineMat(role, opacity)));
  }

  for (let i = 0; i < 24; i++) {
    const lon = (i / 24) * Math.PI * 2;
    const isMajor = i % 6 === 0;
    outerShell.add(
      new THREE.Line(meridian(R1, lon), lineMat(isMajor ? "mid" : "faint", isMajor ? 0.6 : 0.1)),
    );
  }

  const CROSS_LINES = 18;
  const CROSS_SPREAD = 0.25;
  for (let i = 0; i < 4; i++) {
    const lon = (i / 4) * Math.PI * 2;
    for (let j = 0; j < CROSS_LINES; j++) {
      const t = (j / (CROSS_LINES - 1)) * 2 - 1;
      const offset = (t * CROSS_SPREAD) / 2;
      const falloff = 1 - Math.abs(t) * 0.7;
      const opacity = 0.85 * falloff;
      const role: Role = Math.abs(t) < 0.3 ? "bright" : "mid";
      outerShell.add(new THREE.Line(meridian(R1, lon + offset, 200), lineMat(role, opacity)));
    }
  }

  const EQ_LINES = 20;
  const EQ_SPREAD = 0.35;
  for (let j = 0; j < EQ_LINES; j++) {
    const t = (j / (EQ_LINES - 1)) * 2 - 1;
    const offset = (t * EQ_SPREAD) / 2;
    const falloff = 1 - Math.abs(t) * 0.65;
    const opacity = 0.8 * falloff;
    const role: Role = Math.abs(t) < 0.3 ? "bright" : "mid";
    outerShell.add(new THREE.Line(latRing(R1, offset, 200), lineMat(role, opacity)));
  }

  orbGroup.add(outerShell);

  // ═══════════════════════════════════════════════
  // LAYER 2: GRID PANELS on the sphere surface
  // ═══════════════════════════════════════════════
  const panelGroup = new THREE.Group();

  function createSpherePanel(
    latCenter: number,
    lonCenter: number,
    latSpan: number,
    lonSpan: number,
    radius: number,
    divisions = 4,
  ) {
    const group = new THREE.Group();
    const mat = lineMat("dim", 0.25);

    for (let i = 0; i <= divisions; i++) {
      const lat = latCenter - latSpan / 2 + (i / divisions) * latSpan;
      const pts: THREE.Vector3[] = [];
      for (let j = 0; j <= divisions * 4; j++) {
        const lon = lonCenter - lonSpan / 2 + (j / (divisions * 4)) * lonSpan;
        pts.push(
          new THREE.Vector3(
            radius * Math.cos(lat) * Math.cos(lon),
            radius * Math.sin(lat),
            radius * Math.cos(lat) * Math.sin(lon),
          ),
        );
      }
      group.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), mat));
    }

    for (let j = 0; j <= divisions; j++) {
      const lon = lonCenter - lonSpan / 2 + (j / divisions) * lonSpan;
      const pts: THREE.Vector3[] = [];
      for (let i = 0; i <= divisions * 4; i++) {
        const lat = latCenter - latSpan / 2 + (i / (divisions * 4)) * latSpan;
        pts.push(
          new THREE.Vector3(
            radius * Math.cos(lat) * Math.cos(lon),
            radius * Math.sin(lat),
            radius * Math.cos(lat) * Math.sin(lon),
          ),
        );
      }
      group.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), mat));
    }

    return group;
  }

  for (let i = 0; i < 30; i++) {
    const lat = (Math.random() - 0.5) * Math.PI * 0.8;
    const lon = Math.random() * Math.PI * 2;
    const size = 0.15 + Math.random() * 0.25;
    const panel = createSpherePanel(lat, lon, size, size, R1 + 0.01, 3 + Math.floor(Math.random() * 3));
    panelGroup.add(panel);
  }
  orbGroup.add(panelGroup);

  // ═══════════════════════════════════════════════
  // LAYER 3: SECONDARY SHELL — offset, partial arcs
  // ═══════════════════════════════════════════════
  const shell2 = new THREE.Group();
  const R2 = 2.12;

  for (let i = 0; i < 16; i++) {
    const lat = (Math.random() - 0.5) * Math.PI * 0.85;
    const startLon = Math.random() * Math.PI * 2;
    const arcLen = 0.3 + Math.random() * 1.2;
    const pts: THREE.Vector3[] = [];
    const segs = 60;
    const r = R2 * Math.cos(lat);
    const y = R2 * Math.sin(lat);
    for (let j = 0; j <= segs; j++) {
      const a = startLon + (j / segs) * arcLen;
      pts.push(new THREE.Vector3(r * Math.cos(a), y, r * Math.sin(a)));
    }
    shell2.add(
      new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), lineMat("mid", 0.2 + Math.random() * 0.3)),
    );
  }

  for (let i = 0; i < 12; i++) {
    const lon = Math.random() * Math.PI * 2;
    const startLat = (Math.random() - 0.5) * Math.PI * 0.8;
    const arcLen = 0.3 + Math.random() * 0.8;
    const pts: THREE.Vector3[] = [];
    const segs = 40;
    for (let j = 0; j <= segs; j++) {
      const lat = startLat + (j / segs) * arcLen;
      pts.push(
        new THREE.Vector3(
          R2 * Math.cos(lat) * Math.cos(lon),
          R2 * Math.sin(lat),
          R2 * Math.cos(lat) * Math.sin(lon),
        ),
      );
    }
    shell2.add(
      new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), lineMat("dim", 0.15 + Math.random() * 0.2)),
    );
  }
  orbGroup.add(shell2);

  // ═══════════════════════════════════════════════
  // LAYER 4: INNER CORE — spiral geodesic
  // ═══════════════════════════════════════════════
  const innerCore = new THREE.Group();
  const R3 = 0.9;

  for (let s = 0; s < 8; s++) {
    const pts: THREE.Vector3[] = [];
    const turns = 3 + Math.random() * 2;
    const segs = 300;
    const phase = (s / 8) * Math.PI * 2;
    for (let i = 0; i <= segs; i++) {
      const t = i / segs;
      const lat = t * Math.PI - Math.PI / 2;
      const lon = t * turns * Math.PI * 2 + phase;
      pts.push(
        new THREE.Vector3(
          R3 * Math.cos(lat) * Math.cos(lon),
          R3 * Math.sin(lat),
          R3 * Math.cos(lat) * Math.sin(lon),
        ),
      );
    }
    innerCore.add(
      new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), lineMat("bright", 0.3 + Math.random() * 0.2)),
    );
  }

  for (let i = -6; i <= 6; i++) {
    const lat = (i / 6) * (Math.PI / 2) * 0.9;
    innerCore.add(new THREE.Line(latRing(R3, lat, 80), lineMat("dim", 0.2)));
  }

  for (let i = 0; i < 12; i++) {
    const lon = (i / 12) * Math.PI * 2;
    innerCore.add(new THREE.Line(meridian(R3, lon, 80), lineMat("dim", 0.15)));
  }

  orbGroup.add(innerCore);

  // ═══════════════════════════════════════════════
  // LAYER 5: INNERMOST CORE — bright hot center
  // ═══════════════════════════════════════════════
  const coreR = 0.25;

  const icoGeo = new THREE.IcosahedronGeometry(coreR, 1);
  const icoEdges = new THREE.EdgesGeometry(icoGeo);
  const icoWireMat = lineMat("hot", 0.9);
  const icoWire = new THREE.LineSegments(icoEdges, icoWireMat);
  orbGroup.add(icoWire);

  const coreSphereMat = basicMat("hot", 0.15);
  const coreSphere = new THREE.Mesh(new THREE.SphereGeometry(0.15, 16, 16), coreSphereMat);
  orbGroup.add(coreSphere);

  const glowSphereMat = basicMat("mid", 0.04);
  const glowSphere = new THREE.Mesh(new THREE.SphereGeometry(0.5, 16, 16), glowSphereMat);
  orbGroup.add(glowSphere);

  // ═══════════════════════════════════════════════
  // CODE TEXT — tiny, dense, scattered
  // ═══════════════════════════════════════════════
  const codeSnippets = [
    "sys.init()", "0xFF3A", "malloc()", ">> SCAN", "void*", "ACK",
    "SYNC OK", "ptr_ref", "exec()", "hash256", "::bind", "core.0",
    "01101001", "10110100", ">>> RDY", "HEAP 4K", "TCP/SYN",
    "mutex.lk", "IRQ 0x7", "DMA xfer", "REG EAX", "FAULT 0",
    "kernel.d", "pipe |>", "chmod +x", "fork()", "SIGTERM",
    "eth0: UP", "AES-256", "RSA 4096", "TLS 1.3", "HTTP/2",
    "latency", "200 OK", "PATCH /", "fn main", "use std",
    "impl Orb", "async {}", "spawn()", "arc::new", ".unwrap",
  ];

  interface SpriteDrift {
    phi: number;
    theta: number;
    r: number;
    speed: number;
  }

  // Sprites are drawn in plain white with a random alpha baked into the
  // canvas; the actual color comes from the (themeable) material tint, so a
  // theme swap can recolor every scattered glyph without touching a canvas.
  function makeTextSprite(text: string, size = 0.08) {
    const c = document.createElement("canvas");
    c.width = 256;
    c.height = 32;
    const ctx = c.getContext("2d")!;
    ctx.font = "bold 14px Courier New";
    const alpha = 0.35 + Math.random() * 0.55;
    ctx.fillStyle = `rgba(255, 255, 255, ${alpha})`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(text, 128, 16);
    const tex = new THREE.CanvasTexture(c);
    tex.minFilter = THREE.LinearFilter;
    const mat = new THREE.SpriteMaterial({
      map: tex,
      color: themeColor("bright"),
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    regColor(mat, "bright");
    const s = new THREE.Sprite(mat);
    s.scale.set(size * 5, size * 0.7, 1);
    return s;
  }

  function scatterText(count: number, sizeFn: () => number, rFn: () => number, speedScale: [number, number]) {
    const group = new THREE.Group();
    for (let i = 0; i < count; i++) {
      const sp = makeTextSprite(codeSnippets[Math.floor(Math.random() * codeSnippets.length)], sizeFn());
      const phi = Math.acos(2 * Math.random() - 1);
      const theta = Math.random() * Math.PI * 2;
      const r = rFn();
      sp.position.set(
        r * Math.sin(phi) * Math.cos(theta),
        r * Math.cos(phi),
        r * Math.sin(phi) * Math.sin(theta),
      );
      sp.userData = {
        phi,
        theta,
        r,
        speed: (speedScale[0] + Math.random() * speedScale[1]) * (Math.random() > 0.5 ? 1 : -1),
      } satisfies SpriteDrift;
      group.add(sp);
    }
    return group;
  }

  const textOuter = scatterText(
    preset.textOuter,
    () => 0.04 + Math.random() * 0.04,
    () => R1 + 0.03 + Math.random() * 0.08,
    [0.0002, 0.0008],
  );
  orbGroup.add(textOuter);

  const textInner = scatterText(
    preset.textInner,
    () => 0.03 + Math.random() * 0.03,
    () => R3 + 0.02,
    [0.0005, 0.001],
  );
  orbGroup.add(textInner);

  const textAmbient = scatterText(
    preset.textAmbient,
    () => 0.03,
    () => R3 + 0.2 + Math.random() * (R1 - R3 - 0.3),
    [0.0003, 0.0006],
  );
  orbGroup.add(textAmbient);

  // ═══════════════════════════════════════════════
  // ORBITING DEBRIS / ROCKS — instanced for performance
  // ═══════════════════════════════════════════════
  // Rendering hundreds of individual meshes costs one draw call each; an
  // InstancedMesh per (geometry, color-role) pair renders the whole batch
  // in a single draw call while keeping independent per-instance motion.
  const debrisGeos = [
    new THREE.IcosahedronGeometry(0.012, 0),
    new THREE.IcosahedronGeometry(0.02, 0),
    new THREE.IcosahedronGeometry(0.03, 1),
    new THREE.IcosahedronGeometry(0.008, 0),
    new THREE.TetrahedronGeometry(0.015, 0),
    new THREE.OctahedronGeometry(0.018, 0),
  ];

  interface DebrisOrbit {
    orbitR: number;
    speed: number;
    tiltX: number;
    tiltZ: number;
    phase: number;
    scale: number;
  }

  interface DebrisBatch {
    mesh: THREE.InstancedMesh;
    orbits: DebrisOrbit[];
  }

  const debrisBatches: DebrisBatch[] = [];
  const debrisTrails: { line: THREE.Line; orbit: DebrisOrbit }[] = [];
  const debrisDummy = new THREE.Object3D();

  function debrisPosition(out: THREE.Vector3, u: DebrisOrbit, t: number) {
    const a = t * u.speed + u.phase;
    out.set(
      u.orbitR * Math.cos(a) * Math.cos(u.tiltX),
      u.orbitR * Math.sin(u.tiltX) * Math.sin(a * 0.8) + Math.sin(a * 0.3 + u.tiltZ) * 0.2,
      u.orbitR * Math.sin(a) * Math.cos(u.tiltZ),
    );
  }

  function makeDebrisBatch(geo: THREE.BufferGeometry, role: Role, count: number) {
    if (count <= 0) return;
    const mat = basicMat(role, 0.55);
    const mesh = new THREE.InstancedMesh(geo, mat, count);
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    const orbits: DebrisOrbit[] = [];
    for (let i = 0; i < count; i++) {
      const orbit: DebrisOrbit = {
        orbitR: 1.2 + Math.random() * 4.0,
        speed: (0.08 + Math.random() * 0.6) * (Math.random() > 0.5 ? 1 : -1),
        tiltX: (Math.random() - 0.5) * Math.PI * 0.9,
        tiltZ: (Math.random() - 0.5) * Math.PI * 0.5,
        phase: Math.random() * Math.PI * 2,
        scale: 0.7 + Math.random() * 0.6,
      };
      orbits.push(orbit);

      // ~15% of debris get a faint trailing arc.
      if (Math.random() > 0.85) {
        const trailPts: THREE.Vector3[] = [];
        for (let j = 0; j <= 15; j++) {
          const a = -(j / 15) * 0.3;
          trailPts.push(
            new THREE.Vector3(
              orbit.orbitR * Math.cos(a + orbit.phase),
              orbit.orbitR * 0.08 * Math.sin(a * 3),
              orbit.orbitR * Math.sin(a + orbit.phase),
            ),
          );
        }
        const trail = new THREE.Line(new THREE.BufferGeometry().setFromPoints(trailPts), lineMat("faint", 0.08));
        orbGroup.add(trail);
        debrisTrails.push({ line: trail, orbit });
      }
    }
    orbGroup.add(mesh);
    debrisBatches.push({ mesh, orbits });
  }

  {
    const total = preset.debris;
    const perGeo = Math.max(1, Math.round(total / debrisGeos.length));
    for (const geo of debrisGeos) {
      const brightCount = Math.round(perGeo * 0.3);
      const midCount = perGeo - brightCount;
      makeDebrisBatch(geo, "bright", brightCount);
      makeDebrisBatch(geo, "mid", midCount);
    }
  }

  // ═══════════════════════════════════════════════
  // DUST PARTICLES
  // ═══════════════════════════════════════════════
  const dustCount = preset.dust;
  const dustPos = new Float32Array(dustCount * 3);

  for (let i = 0; i < dustCount; i++) {
    const rr = 0.5 + Math.pow(Math.random(), 0.6) * 7;
    const theta = Math.random() * Math.PI * 2;
    const phi = Math.acos(2 * Math.random() - 1);
    dustPos[i * 3] = rr * Math.sin(phi) * Math.cos(theta);
    dustPos[i * 3 + 1] = rr * Math.cos(phi);
    dustPos[i * 3 + 2] = rr * Math.sin(phi) * Math.sin(theta);
  }

  const dustGeo = new THREE.BufferGeometry();
  dustGeo.setAttribute("position", new THREE.Float32BufferAttribute(dustPos, 3));

  // Soft white dot texture — tinted by the material color so themes recolor it for free.
  const dotC = document.createElement("canvas");
  dotC.width = dotC.height = 64;
  const dCtx = dotC.getContext("2d")!;
  const g = dCtx.createRadialGradient(32, 32, 0, 32, 32, 32);
  g.addColorStop(0, "rgba(255,255,255,1)");
  g.addColorStop(0.2, "rgba(255,255,255,0.6)");
  g.addColorStop(0.5, "rgba(255,255,255,0.15)");
  g.addColorStop(1, "rgba(255,255,255,0)");
  dCtx.fillStyle = g;
  dCtx.fillRect(0, 0, 64, 64);

  const dustMat = new THREE.PointsMaterial({
    map: new THREE.CanvasTexture(dotC),
    size: 0.04,
    transparent: true,
    opacity: 0.5,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    sizeAttenuation: true,
    color: themeColor("bright"),
  });
  regColor(dustMat, "bright");
  const dustPoints = new THREE.Points(dustGeo, dustMat);
  orbGroup.add(dustPoints);

  // ═══════════════════════════════════════════════
  // SCANNING RINGS
  // ═══════════════════════════════════════════════
  function makeScanRing(radius: number, thickness = 0.015) {
    const geo = new THREE.RingGeometry(radius - thickness, radius + thickness, 120);
    const mat = basicMat("bright", 0, { side: THREE.DoubleSide, depthWrite: false });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.rotation.x = Math.PI / 2;
    return mesh;
  }

  const scanRing1 = makeScanRing(R1, 0.01);
  const scanRing2 = makeScanRing(R1 * 0.7, 0.008);
  orbGroup.add(scanRing1, scanRing2);

  // ═══════════════════════════════════════════════
  // HEXAGONAL NODES — small tech details
  // ═══════════════════════════════════════════════
  for (let i = 0; i < 15; i++) {
    const phi = Math.acos(2 * Math.random() - 1);
    const theta = Math.random() * Math.PI * 2;
    const r = R1 + 0.02;
    const hexGeo = new THREE.CircleGeometry(0.03 + Math.random() * 0.02, 6);
    const hexEdges = new THREE.EdgesGeometry(hexGeo);
    const hex = new THREE.LineSegments(hexEdges, lineMat("mid", 0.5));
    hex.position.set(
      r * Math.sin(phi) * Math.cos(theta),
      r * Math.cos(phi),
      r * Math.sin(phi) * Math.sin(theta),
    );
    hex.lookAt(0, 0, 0);
    outerShell.add(hex);
  }

  // ═══════════════════════════════════════════════
  // THEME SWITCHING
  // ═══════════════════════════════════════════════
  function setTheme(theme: ThemeName) {
    if (theme === currentTheme) return;
    currentTheme = theme;
    (Object.keys(registry) as Role[]).forEach((role) => {
      const hex = themeColor(role);
      for (const mat of registry[role]) {
        (mat as THREE.Material & { color?: THREE.Color }).color?.setHex(hex);
      }
    });
    if (chromaticPass) chromaticPass.uniforms.uTint.value.copy(THEME_TINT[theme]);
  }

  function getTheme(): ThemeName {
    return currentTheme;
  }

  // ═══════════════════════════════════════════════
  // GESTURE / PROGRAMMATIC CAMERA CONTROL
  // ═══════════════════════════════════════════════
  const sphericalScratch = new THREE.Spherical();
  const offsetScratch = new THREE.Vector3();

  function rotateBy(deltaTheta: number, deltaPhi: number) {
    markInteraction();
    offsetScratch.copy(camera.position).sub(controls.target);
    sphericalScratch.setFromVector3(offsetScratch);
    sphericalScratch.theta -= deltaTheta;
    sphericalScratch.phi = THREE.MathUtils.clamp(sphericalScratch.phi - deltaPhi, 0.05, Math.PI - 0.05);
    sphericalScratch.makeSafe();
    offsetScratch.setFromSpherical(sphericalScratch);
    camera.position.copy(controls.target).add(offsetScratch);
    camera.lookAt(controls.target);
  }

  function zoomBy(factor: number) {
    markInteraction();
    offsetScratch.copy(camera.position).sub(controls.target);
    const dist = THREE.MathUtils.clamp(offsetScratch.length() * factor, MIN_DISTANCE, MAX_DISTANCE);
    offsetScratch.setLength(dist);
    camera.position.copy(controls.target).add(offsetScratch);
  }

  function resetView() {
    markInteraction();
    camera.position.copy(HOME_POSITION);
    controls.target.set(0, 0, 0);
    camera.lookAt(controls.target);
    controls.update();
  }

  function setAutoRotate(enabled: boolean) {
    autoRotateEnabled = enabled;
    if (!enabled) controls.autoRotate = false;
    markInteraction();
  }

  function captureImage(): string {
    composer.render();
    return renderer.domElement.toDataURL("image/png");
  }

  // ═══════════════════════════════════════════════
  // ANIMATION
  // ═══════════════════════════════════════════════
  const clock = new THREE.Clock();
  let flickerTimer = 0;
  let rafId = 0;
  let disposed = false;
  let debrisRotX = 0;
  let debrisRotZ = 0;

  let fpsLastNow = performance.now();
  let fpsAccumMs = 0;
  let fpsFrames = 0;

  function animate() {
    if (disposed) return;
    rafId = requestAnimationFrame(animate);
    const t = clock.getElapsedTime();

    // fps reporting (throttled, independent of the animation clock)
    if (options.onFps) {
      const now = performance.now();
      fpsAccumMs += now - fpsLastNow;
      fpsLastNow = now;
      fpsFrames++;
      if (fpsAccumMs >= 500) {
        options.onFps(Math.round((fpsFrames * 1000) / fpsAccumMs));
        fpsAccumMs = 0;
        fpsFrames = 0;
      }
    }

    // Outer shell rotation
    outerShell.rotation.y += 0.0015 * motionScale;
    outerShell.rotation.x = Math.sin(t * 0.08) * 0.05 * motionScale;

    panelGroup.rotation.y += 0.0018 * motionScale;
    panelGroup.rotation.x = Math.sin(t * 0.08 + 0.5) * 0.04 * motionScale;

    shell2.rotation.y -= 0.001 * motionScale;
    shell2.rotation.z = Math.sin(t * 0.12) * 0.03 * motionScale;

    innerCore.rotation.y -= 0.005 * motionScale;
    innerCore.rotation.z += 0.002 * motionScale;
    innerCore.rotation.x = Math.cos(t * 0.1) * 0.08 * motionScale;

    icoWire.rotation.x += 0.008 * motionScale;
    icoWire.rotation.y += 0.012 * motionScale;

    // Core pulse
    const wave1 = Math.sin(t * 1.2);
    const wave3 = Math.pow(Math.max(0, Math.sin(t * 0.4)), 5);
    const wave4 = Math.pow(Math.max(0, Math.sin(t * 0.7 + 2)), 8);
    const fadeOut = Math.pow(Math.max(0, Math.sin(t * 0.25)), 3);
    const surge = (wave3 * 1.5 + wave4 * 2.0) * motionScale;
    const coreScale = 1 + surge + Math.sin(t * 5) * 0.05 * motionScale;
    coreSphere.scale.setScalar(coreScale);
    const coreOpacity = Math.max(0, (0.08 + wave1 * 0.05 * motionScale + surge * 0.2) * (1 - fadeOut * 0.95 * motionScale));
    coreSphereMat.opacity = Math.min(0.6, coreOpacity);
    glowSphere.scale.setScalar(1 + surge * 0.8);
    glowSphereMat.opacity = Math.max(0, (0.03 + surge * 0.08) * (1 - fadeOut * 0.9 * motionScale));
    icoWire.scale.setScalar(1 + surge * 0.6);
    icoWireMat.opacity = Math.min(1, 0.5 + surge * 0.4);

    // Debris orbits — batched via InstancedMesh
    for (const batch of debrisBatches) {
      for (let i = 0; i < batch.orbits.length; i++) {
        const u = batch.orbits[i];
        debrisPosition(debrisDummy.position, u, t);
        debrisDummy.rotation.set(debrisRotX, 0, debrisRotZ);
        debrisDummy.scale.setScalar(u.scale);
        debrisDummy.updateMatrix();
        batch.mesh.setMatrixAt(i, debrisDummy.matrix);
      }
      batch.mesh.instanceMatrix.needsUpdate = true;
    }
    debrisRotX += 0.015 * motionScale;
    debrisRotZ += 0.01 * motionScale;

    for (const { line, orbit } of debrisTrails) {
      debrisPosition(line.position, orbit, t);
    }

    // Text drift
    const driftGroups: [THREE.Group, number][] = [
      [textOuter, 1],
      [textInner, 2],
      [textAmbient, 1.2],
    ];
    for (const [group, mult] of driftGroups) {
      group.children.forEach((sp) => {
        const u = sp.userData as SpriteDrift;
        u.theta += u.speed * mult * motionScale;
        sp.position.set(
          u.r * Math.sin(u.phi) * Math.cos(u.theta),
          u.r * Math.cos(u.phi),
          u.r * Math.sin(u.phi) * Math.sin(u.theta),
        );
      });
    }

    // Scan rings sweeping
    const scanY1 = Math.sin(t * 0.4) * R1;
    scanRing1.position.y = scanY1;
    const scanS1 = Math.sqrt(Math.max(0, R1 * R1 - scanY1 * scanY1)) / R1;
    scanRing1.scale.set(scanS1, scanS1, 1);
    (scanRing1.material as THREE.MeshBasicMaterial).opacity = 0.2 * scanS1;

    const scanY2 = Math.sin(t * 0.6 + 2) * R3;
    scanRing2.position.y = scanY2;
    const scanS2 = Math.sqrt(Math.max(0, R3 * R3 - scanY2 * scanY2)) / R3;
    scanRing2.scale.set(scanS2, scanS2, 1);
    (scanRing2.material as THREE.MeshBasicMaterial).opacity = 0.15 * scanS2;

    dustPoints.rotation.y += 0.0002 * motionScale;

    // Random flicker on some panels (disabled on low tier / reduced motion)
    if (preset.flicker && !reducedMotion) {
      flickerTimer += 0.016;
      if (flickerTimer > 0.1) {
        flickerTimer = 0;
        panelGroup.children.forEach((p) => {
          if (Math.random() > 0.95) p.visible = !p.visible;
        });
      }
    }

    bloom.strength = preset.bloomStrength * (1 + Math.sin(t * 0.8) * 0.15 * motionScale);

    if (chromaticPass) chromaticPass.uniforms.uTime.value = t;

    // Idle auto-rotate: only kicks in a few seconds after the last input.
    if (autoRotateEnabled) {
      controls.autoRotate = performance.now() - lastInteraction > AUTO_ROTATE_IDLE_MS;
    }

    controls.update();
    composer.render();
  }

  animate();

  // ——— PAUSE WHEN TAB IS HIDDEN ———
  function onVisibilityChange() {
    if (document.hidden) {
      cancelAnimationFrame(rafId);
    } else if (!disposed) {
      fpsLastNow = performance.now();
      rafId = requestAnimationFrame(animate);
    }
  }
  document.addEventListener("visibilitychange", onVisibilityChange);

  // ——— RESIZE ———
  function onResize() {
    const w = container.clientWidth;
    const h = container.clientHeight;
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    renderer.setSize(w, h);
    composer.setSize(w, h);
  }
  window.addEventListener("resize", onResize);

  // ——— CLEANUP ———
  function dispose() {
    disposed = true;
    cancelAnimationFrame(rafId);
    window.removeEventListener("resize", onResize);
    document.removeEventListener("visibilitychange", onVisibilityChange);
    controls.removeEventListener("start", markInteraction);
    controls.dispose();
    scene.traverse((obj) => {
      const mesh = obj as THREE.Mesh;
      if (mesh.geometry) mesh.geometry.dispose();
      const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      for (const mat of mats) {
        if (!mat) continue;
        const anyMat = mat as THREE.Material & { map?: THREE.Texture };
        anyMat.map?.dispose();
        mat.dispose();
      }
    });
    composer.dispose();
    renderer.dispose();
    renderer.domElement.remove();
  }

  return {
    rotateBy,
    zoomBy,
    zoomIn: () => zoomBy(0.65),
    zoomOut: () => zoomBy(1.55),
    resetView,
    setTheme,
    getTheme,
    setAutoRotate,
    captureImage,
    dispose,
  };
}
