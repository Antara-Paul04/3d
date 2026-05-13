// =====================================================================
// Build / decoration mode additions (search "Build mode:" to jump to the block):
//   - Vertical right-edge panel in index.html lets the player pick a placeable.
//   - 5 placeables: flower (cloned from flower.glb) + 4 procedural placeholders
//     (tree/lantern/mushroom/log) built from primitives in a chunky low-poly style.
//   - Selecting a button shows a semi-transparent ghost that follows the duck.
//   - Space places the selected item (gated at the top of the existing Space
//     handler — the original tree-climb behaviour runs when no item is selected).
//   - X removes the nearest placed object within 1.5 units.
//   - State persists to localStorage under key "duckIsland_v1".
// =====================================================================
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { MeshSurfaceSampler } from 'three/addons/math/MeshSurfaceSampler.js';
import { createNoise2D } from 'simplex-noise';
import { Tree } from '@dgreenheck/ez-tree';

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));  // capped per perf audit (#2)
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.15;
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x87ceeb);
scene.fog = new THREE.Fog(0xb8d8ee, 160, 460);

const camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.1, 500);

// === Build mode (third-person, same camera as explore) ===
// `gameMode` toggles between explore (default) and build. Build mode keeps
// the same perspective camera; the duck steps to the side, and a mouse-
// driven grid cursor + ghost preview overlay drive part placement.
let gameMode = 'explore';

// Grid cell sizes (world meters per cell). Non-cubic by design: logs are 1m
// long along their length axis (X by default) and 0.25m thick across. See
// the Build mode section further down for full conventions.
const GRID_X = 1.0;
const GRID_Y = 0.25;
const GRID_Z = 0.25;

// Duck step-aside state. On B-enter the duck slides 2m to its world-right so
// the build area is unblocked; on exit it slides back. `_buildHomePos` is the
// pre-step-aside spot — also the camera target + grid origin while in build.
const _buildHomePos    = new THREE.Vector3();
const _duckLerpStart   = new THREE.Vector3();
const _duckLerpTarget  = new THREE.Vector3();
let   _duckLerpState   = null;   // 'aside' | 'home' | null
let   _duckLerpT       = 0;
const DUCK_LERP_DURATION = 0.5;
const DUCK_STEP_ASIDE    = 2.0;  // metres to the duck's right

// Camera target lerp — in build mode the orbit target = _buildHomePos, in
// explore it tracks player.position. `_cameraTarget` chases the desired one
// via the same camLerp that drives yaw/pitch/dist (about 0.3s settle).
const _cameraTarget    = new THREE.Vector3();
let   _exploreLastPitch = 0.35;

const hemi = new THREE.HemisphereLight(0xbcdfff, 0x4a5530, 1.1);
scene.add(hemi);
const sun = new THREE.DirectionalLight(0xfff2cc, 3.2);
sun.position.set(50, 80, 30);
sun.castShadow = true;
sun.shadow.mapSize.set(1024, 1024);
const s = sun.shadow.camera;
s.left = -25; s.right = 25; s.top = 25; s.bottom = -25; s.near = 1; s.far = 200;
scene.add(sun);
scene.add(sun.target);  // sun follows player so the small shadow frustum always covers them

// Build-mode grid: 10m × 10m of LineSegments matching the actual snap grid
// (1m spacing along X, 0.25m spacing along Z). Built once at module load and
// repositioned at the duck's home spot on B-enter; never follows the duck mid-
// session so the build zone stays anchored where placements happen.
const buildGrid = (() => {
  const positions = [];
  const halfX = 5;                                   // 10m wide in X (10 × 1m cells)
  const halfZ = 5;                                   // 10m wide in Z (40 × 0.25m cells)
  // Lines parallel to Z (constant X) at every integer X from -halfX to +halfX.
  for (let i = -halfX; i <= halfX; i++) {
    positions.push(i, 0, -halfZ);
    positions.push(i, 0,  halfZ);
  }
  // Lines parallel to X (constant Z) at every 0.25m of Z from -halfZ to +halfZ.
  const zSteps = Math.round((halfZ * 2) / GRID_Z);
  for (let j = 0; j <= zSteps; j++) {
    const z = -halfZ + j * GRID_Z;
    positions.push(-halfX, 0, z);
    positions.push( halfX, 0, z);
  }
  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  const mat = new THREE.LineBasicMaterial({
    color: 0xfff5dd,             // warm cream — reads well against grass
    transparent: true,
    opacity: 0.5,
    depthWrite: false,
  });
  const lines = new THREE.LineSegments(geom, mat);
  lines.visible = false;
  scene.add(lines);
  return lines;
})();

// Build cursor: a flat outlined rectangle that highlights the current grid
// cell / part footprint. The base plane is 1×1; updateBuildCursor scales it
// per frame to match the selected part's footprint.
const buildCursorMesh = (() => {
  const g = new THREE.PlaneGeometry(1, 1);
  g.rotateX(-Math.PI / 2);
  const m = new THREE.MeshBasicMaterial({
    color: 0xffe680,
    transparent: true,
    opacity: 0.55,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
  const mesh = new THREE.Mesh(g, m);
  mesh.visible = false;
  scene.add(mesh);
  return mesh;
})();

// === Island + sea placement constants (declared early so every scatter system can
// exclude the sea's footprint). The terrain is an island: land within ISLAND_RADIUS,
// sloping to seabed by ISLAND_FALLOFF_END. A "highland" bump rises inside the island
// at HIGHLAND_X/Z, creating an elevated forest. Sea wraps fully around the island.
const ISLAND_RADIUS       = 280;   // full-height island radius (~2x previous)
const ISLAND_FALLOFF_END  = 380;   // beyond this radius the terrain is fully seabed
const HIGHLAND_X          = 130;
const HIGHLAND_Z          = -100;
const HIGHLAND_RADIUS     = 70;    // flat plateau radius
const HIGHLAND_FALLOFF    = 80;    // smooth foothill slope outside the plateau
const HIGHLAND_HEIGHT     = 16;    // extra elevation on top of base island
// "In sea" = past the land/water boundary (i.e. terrain has dropped near the water).
function isInSea(x, z, pad = 0) {
  const r = Math.sqrt(x*x + z*z);
  return r > (ISLAND_RADIUS - pad);
}

// === Stars: a hemisphere of points, made visible only at night and parented to player ===
const STAR_COUNT  = 2200;
const STAR_RADIUS = 240;  // just past fog's day-far so they hide nicely behind day fog
const starPos = new Float32Array(STAR_COUNT * 3);
const starSize = new Float32Array(STAR_COUNT);
for (let i = 0; i < STAR_COUNT; i++) {
  const phi      = Math.random() * Math.PI * 2;
  const cosTheta = Math.pow(Math.random(), 0.7);  // bias toward zenith so it looks like a dome
  const sinTheta = Math.sqrt(1 - cosTheta * cosTheta);
  starPos[i*3]   = STAR_RADIUS * sinTheta * Math.cos(phi);
  starPos[i*3+1] = STAR_RADIUS * cosTheta;
  starPos[i*3+2] = STAR_RADIUS * sinTheta * Math.sin(phi);
  starSize[i]    = 0.8 + Math.random() * 1.6;
}
const starGeom = new THREE.BufferGeometry();
starGeom.setAttribute('position', new THREE.BufferAttribute(starPos, 3));
starGeom.setAttribute('aSize',    new THREE.BufferAttribute(starSize, 1));

const starMaterial = new THREE.ShaderMaterial({
  uniforms: { uTime: { value: 0 } },
  transparent: true,
  depthWrite: false,
  fog: false,  // ShaderMaterial ignores fog by default — explicit for clarity
  vertexShader: `
    attribute float aSize;
    uniform float uTime;
    varying float vTwinkle;
    void main() {
      vec4 mv = modelViewMatrix * vec4(position, 1.0);
      // Cheap per-star twinkle from a hash of position.
      float h = fract(sin(dot(position, vec3(12.9898, 78.233, 37.719))) * 43758.5453);
      vTwinkle = 0.6 + 0.4 * sin(uTime * 2.0 + h * 6.283);
      gl_PointSize = aSize * vTwinkle * 1.4;
      gl_Position = projectionMatrix * mv;
    }
  `,
  fragmentShader: `
    varying float vTwinkle;
    void main() {
      vec2 c = gl_PointCoord - 0.5;
      float r = length(c);
      if (r > 0.5) discard;
      float a = smoothstep(0.5, 0.0, r);
      gl_FragColor = vec4(vec3(1.0, 0.97, 0.85) * vTwinkle, a);
    }
  `,
});
const stars = new THREE.Points(starGeom, starMaterial);
stars.frustumCulled = false;
stars.visible = false;
scene.add(stars);

// === Clouds: ported from dghez/THREEJS_Procedural-clouds — billboard planes with FBM-displaced
// alpha. Uses procedurally-built shape + noise textures (no external image assets).
const CLOUD_COUNT  = 55;
const CLOUD_HEIGHT = 55;
const CLOUD_FIELD  = 320;

function makeCloudShapeTex(size = 64) {
  const data = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = (x / size - 0.5) * 2;
      const dy = (y / size - 0.5) * 2;
      const r  = Math.sqrt(dx*dx + dy*dy);
      // Soft elliptical falloff: full white center, fading to transparent at edges.
      const v  = Math.max(0, 1 - Math.pow(r, 1.6));
      const c  = Math.floor(v * 255);
      const i  = (y * size + x) * 4;
      data[i] = c; data[i+1] = c; data[i+2] = c; data[i+3] = 255;
    }
  }
  const tex = new THREE.DataTexture(data, size, size);
  tex.needsUpdate = true;
  return tex;
}
function makeCloudNoiseTex(size = 128) {
  const data = new Uint8Array(size * size * 4);
  const n = createNoise2D();
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let v = 0.5 + 0.4 * n(x * 0.04, y * 0.04) + 0.2 * n(x * 0.13, y * 0.13);
      v = Math.max(0, Math.min(1, v));
      const c = Math.floor(v * 255);
      const i = (y * size + x) * 4;
      data[i] = c; data[i+1] = c; data[i+2] = c; data[i+3] = 255;
    }
  }
  const tex = new THREE.DataTexture(data, size, size);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.needsUpdate = true;
  return tex;
}
const cloudShapeTex = makeCloudShapeTex();
const cloudNoiseTex = makeCloudNoiseTex();

const cloudPlane = new THREE.PlaneGeometry(1, 1);
const cloudGeom  = new THREE.InstancedBufferGeometry();
cloudGeom.index  = cloudPlane.index;
cloudGeom.setAttribute('position', cloudPlane.attributes.position);
cloudGeom.setAttribute('uv',       cloudPlane.attributes.uv);

const aOffset = new Float32Array(CLOUD_COUNT * 3);
const aScale  = new Float32Array(CLOUD_COUNT * 2);
const aSeed   = new Float32Array(CLOUD_COUNT);
for (let i = 0; i < CLOUD_COUNT; i++) {
  aOffset[i*3]   = (Math.random() - 0.5) * CLOUD_FIELD;
  aOffset[i*3+1] = CLOUD_HEIGHT + (Math.random() - 0.5) * 14;
  aOffset[i*3+2] = (Math.random() - 0.5) * CLOUD_FIELD;
  const w = 18 + Math.random() * 16;
  aScale[i*2]   = w;
  aScale[i*2+1] = w * (0.55 + Math.random() * 0.25);
  aSeed[i] = Math.random();
}
cloudGeom.setAttribute('aOffset', new THREE.InstancedBufferAttribute(aOffset, 3));
cloudGeom.setAttribute('aScale',  new THREE.InstancedBufferAttribute(aScale, 2));
cloudGeom.setAttribute('aSeed',   new THREE.InstancedBufferAttribute(aSeed, 1));

const cloudMaterial = new THREE.ShaderMaterial({
  transparent: true,
  depthWrite: false,
  fog: false,
  uniforms: {
    uTime:      { value: 0 },
    uShape:     { value: cloudShapeTex },
    uNoise:     { value: cloudNoiseTex },
    uPlayerPos: { value: new THREE.Vector3() },
    uDriftX:    { value: 0 },
    uDriftZ:    { value: 0 },
    uField:     { value: CLOUD_FIELD },
  },
  vertexShader: `
    attribute vec3 aOffset;
    attribute vec2 aScale;
    attribute float aSeed;
    uniform vec3 uPlayerPos;
    uniform float uDriftX;
    uniform float uDriftZ;
    uniform float uField;
    varying vec2 vUv;
    varying float vSeed;

    void main() {
      vUv = uv;
      vSeed = aSeed;
      // Drift in absolute world space, then wrap relative to the player so clouds
      // are always populated near them but still move past the camera.
      float halfField = uField * 0.5;
      vec3 base = aOffset + vec3(uDriftX, 0.0, uDriftZ);
      vec3 rel  = base - uPlayerPos;
      rel.x = mod(rel.x + halfField, uField) - halfField;
      rel.z = mod(rel.z + halfField, uField) - halfField;
      base  = rel + uPlayerPos;
      vec4 mv = viewMatrix * vec4(base, 1.0);
      mv.xy += position.xy * aScale;
      gl_Position = projectionMatrix * mv;
    }
  `,
  fragmentShader: `
    precision mediump float;
    uniform sampler2D uShape;
    uniform sampler2D uNoise;
    uniform float uTime;
    varying vec2 vUv;
    varying float vSeed;

    void main() {
      vec2 uv = vUv;
      // Multi-scale UV displacement (cheap stand-in for FBM3D from the original).
      vec4 n1 = texture2D(uNoise, uv * 0.45 + vec2(uTime * 0.014, -uTime * 0.011) + vSeed);
      uv += (n1.r - 0.5) * 0.18;
      vec4 n2 = texture2D(uNoise, uv * 1.6 + vec2(-uTime * 0.0035, uTime * 0.0042) + vSeed * 1.7);
      uv += (n2.r - 0.5) * 0.08;
      float shape = texture2D(uShape, uv).r;
      // Softness/density from a separate noise lookup (matches the original's two-texture mix).
      vec4 nA = texture2D(uNoise, vUv * 0.7 + vec2( uTime * 0.008, -uTime * 0.011) + vSeed);
      vec4 nB = texture2D(uNoise, vUv * 0.7 + vec2(-uTime * 0.0017, uTime * 0.0024) + vec2(0.2 + vSeed));
      float density = smoothstep(0.18, 0.78, (nA.r + nB.r) * 0.6);
      float alpha   = density * shape;
      if (alpha < 0.02) discard;
      gl_FragColor = vec4(0.97, 0.97, 0.99, alpha);
    }
  `,
});

const clouds = new THREE.Mesh(cloudGeom, cloudMaterial);
clouds.frustumCulled = false;
clouds.renderOrder = -1;  // draw before terrain so soft alpha doesn't show terrain showing through
scene.add(clouds);

// === Butterflies: fly around freely; occasionally land on a flower; flee from the duck ===
const BUTTERFLY_COUNT     = 38;
const BUTTERFLY_SIZE      = 0.2;
const BUTTERFLY_SCARE     = 3.5;
const BUTTERFLY_SPEED     = 3.0;
const BUTTERFLY_WANDER_R  = 14;
const BUTTERFLY_LAND_PROB = 0.45;
const BUTTERFLY_FORCE_LAND_AFTER = 5;
const flowerPerches = [];        // populated by the flower load callback (used by butterflies)
const butterflyState = [];       // initialized below, regardless of flower load

// Wing geometry: each wing is a fan of triangles approximating a rounded triangle (teardrop-ish).
// Hinged on the body (x = 0). We build it from a control polygon then triangulate as a fan.
function buildWing(side) {
  // Polygon outline of one wing in counter-clockwise order, in the xz plane (y = 0).
  // 'side' = -1 for left, +1 for right. Body anchor is the first vertex at x = 0.
  const sx = side;
  const outline = [
    [0,           0,    0.05],
    [sx * 0.18,   0,    0.42],
    [sx * 0.42,   0,    0.40],
    [sx * 0.55,   0,    0.18],
    [sx * 0.55,   0,   -0.05],
    [sx * 0.45,   0,   -0.28],
    [sx * 0.22,   0,   -0.30],
    [sx * 0.05,   0,   -0.18],
  ];
  // Centroid for fan-triangulation.
  const cx = outline.reduce((a, p) => a + p[0], 0) / outline.length;
  const cz = outline.reduce((a, p) => a + p[2], 0) / outline.length;
  const verts = [];
  for (let i = 0; i < outline.length; i++) {
    const a = outline[i], b = outline[(i + 1) % outline.length];
    // Triangle (centroid, a, b) — orient by side so normals point up consistently.
    if (side > 0) verts.push(cx, 0, cz, a[0], 0, a[2], b[0], 0, b[2]);
    else          verts.push(cx, 0, cz, b[0], 0, b[2], a[0], 0, a[2]);
  }
  return verts;
}
const bfPositions = new Float32Array([...buildWing(-1), ...buildWing(1)]);
const bfGeomSrc = new THREE.BufferGeometry();
bfGeomSrc.setAttribute('position', new THREE.BufferAttribute(bfPositions, 3));
bfGeomSrc.computeVertexNormals();

const bfGeom = new THREE.InstancedBufferGeometry();
bfGeom.setAttribute('position', bfGeomSrc.attributes.position);
const bfFlapPhase = new Float32Array(BUTTERFLY_COUNT);
const bfColorAttr = new Float32Array(BUTTERFLY_COUNT * 3);
const bfFlapRate  = new Float32Array(BUTTERFLY_COUNT);
for (let i = 0; i < BUTTERFLY_COUNT; i++) {
  bfFlapPhase[i] = Math.random() * Math.PI * 2;
  bfFlapRate[i]  = 1.0;  // updated per-frame from the state machine
  bfColorAttr[i*3] = 1; bfColorAttr[i*3+1] = 1; bfColorAttr[i*3+2] = 1;
}
bfGeom.setAttribute('aPhase', new THREE.InstancedBufferAttribute(bfFlapPhase, 1));
bfGeom.setAttribute('aRate',  new THREE.InstancedBufferAttribute(bfFlapRate, 1));
bfGeom.setAttribute('aColor', new THREE.InstancedBufferAttribute(bfColorAttr, 3));

const butterflyMaterial = new THREE.ShaderMaterial({
  side: THREE.DoubleSide,
  uniforms: { uTime: { value: 0 } },
  vertexShader: `
    attribute float aPhase;
    attribute float aRate;
    attribute vec3 aColor;
    uniform float uTime;
    varying vec3 vColor;
    varying float vWingT;

    void main() {
      vColor = aColor;
      float flap = sin(uTime * 18.0 * aRate + aPhase) * 1.1;
      vWingT = sin(uTime * 18.0 * aRate + aPhase) * 0.5 + 0.5;
      float a  = flap * sign(position.x);
      float ca = cos(a), sa = sin(a);
      vec3 p = vec3(position.x * ca - position.y * sa,
                    position.x * sa + position.y * ca,
                    position.z);
      // instanceMatrix carries world placement (position + yaw) from the CPU update.
      gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4(p, 1.0);
    }
  `,
  fragmentShader: `
    precision mediump float;
    varying vec3 vColor;
    varying float vWingT;
    void main() {
      gl_FragColor = vec4(vColor * (0.85 + 0.25 * vWingT), 1.0);
    }
  `,
});

const butterflies = new THREE.InstancedMesh(bfGeom, butterflyMaterial, BUTTERFLY_COUNT);
butterflies.frustumCulled = false;
scene.add(butterflies);

// Spread butterflies in a moderate area around the spawn so several are visible immediately.
// A large terrain-wide spread is too sparse to see any nearby. Use an absolute altitude
// (no getTerrainHeight here — noise2D isn't initialized yet at this point in the file).
for (let i = 0; i < BUTTERFLY_COUNT; i++) {
  let x, z;
  do {
    x = (Math.random() - 0.5) * 180;   // wider spawn area for the larger island
    z = (Math.random() - 0.5) * 180;
  } while (isInSea(x, z, 1));
  const y = 11 + Math.random() * 4;  // start safely above tallest terrain incl. highland
  butterflyState.push({
    mode: 'flying',
    pos:    new THREE.Vector3(x, y, z),
    target: new THREE.Vector3(x, y, z),
    yaw: Math.random() * Math.PI * 2,
    sitTimer: 0,
    sinceLanded: 0,
    landingIdx: -1,
  });
}
function initButterflies() { /* flowers loaded — used as targets in pickButterflyTarget */ }

function pickButterflyTarget(b) {
  // Force a landing if the butterfly hasn't landed in a while, otherwise random chance.
  const wantsLand = flowerPerches.length > 0 &&
    (b.sinceLanded > BUTTERFLY_FORCE_LAND_AFTER || Math.random() < BUTTERFLY_LAND_PROB);
  if (wantsLand) {
    for (let k = 0; k < 8; k++) {
      const idx = Math.floor(Math.random() * flowerPerches.length);
      const fp  = flowerPerches[idx];
      const dx  = fp.x - player.position.x, dz = fp.z - player.position.z;
      const d2  = dx*dx + dz*dz;
      // Skip flowers right next to the duck, but allow ones in walking distance so it's visible.
      if (d2 > BUTTERFLY_SCARE * BUTTERFLY_SCARE && d2 < 25 * 25) {
        b.target.copy(fp);
        b.landingIdx = idx;
        return;
      }
    }
  }
  // Wander relative to the butterfly's own position so each one stays in its area.
  // Try a few times to avoid landing the target over the sea.
  let tx, tz;
  for (let k = 0; k < 6; k++) {
    tx = b.pos.x + (Math.random() - 0.5) * BUTTERFLY_WANDER_R;
    tz = b.pos.z + (Math.random() - 0.5) * BUTTERFLY_WANDER_R;
    if (!isInSea(tx, tz, 2)) break;
  }
  const ty = getTerrainHeight(tx, tz) + 1.4 + Math.random() * 2.0;
  b.target.set(tx, ty, tz);
  b.landingIdx = -1;
}

const _bfMat   = new THREE.Matrix4();
const _bfQuat  = new THREE.Quaternion();
const _bfUp    = new THREE.Vector3(0, 1, 0);
const _bfScl   = new THREE.Vector3(BUTTERFLY_SIZE, BUTTERFLY_SIZE, BUTTERFLY_SIZE);
const _bfDir   = new THREE.Vector3();
function updateButterflies(dt, t) {
  for (let i = 0; i < butterflyState.length; i++) {
    const b = butterflyState[i];

    if (b.mode === 'sitting') {
      bfFlapRate[i] = 0.15;
      const dx = b.pos.x - player.position.x;
      const dz = b.pos.z - player.position.z;
      const scared = dx*dx + dz*dz < BUTTERFLY_SCARE * BUTTERFLY_SCARE;
      b.sitTimer -= dt;
      if (scared || b.sitTimer <= 0) {
        b.mode = 'flying';
        b.sinceLanded = 0;  // reset hunger-for-flowers counter when leaving a perch
        pickButterflyTarget(b);
      } else {
        b.pos.y = b.target.y + Math.sin(t * 1.5 + i) * 0.02;
      }
    } else {  // flying
      bfFlapRate[i] = 1.4;
      b.sinceLanded += dt;
      _bfDir.subVectors(b.target, b.pos);
      const dist = _bfDir.length();
      if (dist < 0.6) {
        if (b.landingIdx >= 0) {
          b.pos.copy(b.target);
          b.mode = 'sitting';
          b.sitTimer = 4 + Math.random() * 4;  // 4-8 seconds
        } else {
          pickButterflyTarget(b);
        }
      } else {
        _bfDir.multiplyScalar(BUTTERFLY_SPEED * dt / dist);
        b.pos.add(_bfDir);
        b.pos.y += Math.sin(t * 6 + i) * 0.015;
        b.yaw = Math.atan2(b.target.x - b.pos.x, b.target.z - b.pos.z);
      }
    }

    _bfQuat.setFromAxisAngle(_bfUp, b.yaw);
    _bfMat.compose(b.pos, _bfQuat, _bfScl);
    butterflies.setMatrixAt(i, _bfMat);
  }
  butterflies.instanceMatrix.needsUpdate = true;
  bfGeom.attributes.aRate.needsUpdate = true;
}

// === Fireflies: night-time wandering points (additive glow) ===
const FIREFLY_COUNT = 650;
const FIREFLY_SPEED = 1.6;
const FIREFLY_WANDER_R = 6;
const fireflyState = [];
const ffPositions = new Float32Array(FIREFLY_COUNT * 3);
const ffPhases    = new Float32Array(FIREFLY_COUNT);
for (let i = 0; i < FIREFLY_COUNT; i++) {
  // Initial spawn: spread around the duck's spawn area, low-altitude. Will hop to
  // terrain-relative targets once getTerrainHeight is available (it isn't in this
  // section's lexical position, but the wander loop runs in animate()).
  let x, z;
  do {
    x = (Math.random() - 0.5) * 180;
    z = (Math.random() - 0.5) * 180;
  } while (isInSea(x, z, 1));
  const y = 1.5 + Math.random() * 1.0;
  fireflyState.push({
    pos:    new THREE.Vector3(x, y, z),
    target: new THREE.Vector3(x, y, z),
    phase:  Math.random() * Math.PI * 2,
  });
  ffPositions[i*3] = x; ffPositions[i*3+1] = y; ffPositions[i*3+2] = z;
  ffPhases[i] = fireflyState[i].phase;
}

const ffGeom = new THREE.BufferGeometry();
ffGeom.setAttribute('position', new THREE.BufferAttribute(ffPositions, 3));
ffGeom.setAttribute('aPhase',   new THREE.BufferAttribute(ffPhases, 1));

const fireflyMaterial = new THREE.ShaderMaterial({
  uniforms: { uTime: { value: 0 } },
  transparent: true,
  depthWrite: false,
  blending: THREE.AdditiveBlending,
  vertexShader: `
    attribute float aPhase;
    uniform float uTime;
    varying float vGlow;
    void main() {
      // Asymmetric pulse: bright burst, slower fade — feels like a firefly.
      float s = sin(uTime * 3.2 + aPhase) * 0.5 + 0.5;
      float pulse = pow(s, 2.0);
      vGlow = pulse;
      vec4 mv = modelViewMatrix * vec4(position, 1.0);
      // Tiny dots: small base size, modest grow on the bright phase.
      gl_PointSize = (1.2 + 3.5 * pulse) * (90.0 / -mv.z);
      gl_Position = projectionMatrix * mv;
    }
  `,
  fragmentShader: `
    varying float vGlow;
    void main() {
      vec2 c = gl_PointCoord - 0.5;
      float r = length(c);
      if (r > 0.5) discard;
      float a = smoothstep(0.5, 0.0, r);
      // Pure green; the bright phase nudges to a slightly yellow-green core.
      vec3 col = mix(vec3(0.05, 0.55, 0.08), vec3(0.55, 1.0, 0.35), vGlow);
      gl_FragColor = vec4(col, a * (0.05 + vGlow));
    }
  `,
});
const fireflies = new THREE.Points(ffGeom, fireflyMaterial);
fireflies.frustumCulled = false;
fireflies.visible = false;
scene.add(fireflies);

const _ffDir = new THREE.Vector3();
function updateFireflies(dt, t) {
  const posAttr = ffGeom.attributes.position;
  const arr = posAttr.array;
  for (let i = 0; i < fireflyState.length; i++) {
    const f = fireflyState[i];
    _ffDir.subVectors(f.target, f.pos);
    const dist = _ffDir.length();
    if (dist < 0.35) {
      // Pick a new wander target near the firefly's own position, hovering low above terrain.
      let tx, tz;
      for (let k = 0; k < 6; k++) {
        tx = f.pos.x + (Math.random() - 0.5) * FIREFLY_WANDER_R;
        tz = f.pos.z + (Math.random() - 0.5) * FIREFLY_WANDER_R;
        if (!isInSea(tx, tz, 1)) break;
      }
      const ty = getTerrainHeight(tx, tz) + 0.6 + Math.random() * 1.6;
      f.target.set(tx, ty, tz);
    } else {
      _ffDir.multiplyScalar(FIREFLY_SPEED * dt / dist);
      f.pos.add(_ffDir);
      // Tiny vertical bobble so they don't look like they're on rails.
      f.pos.y += Math.sin(t * 3 + i * 0.7) * 0.012;
    }
    arr[i*3]   = f.pos.x;
    arr[i*3+1] = f.pos.y;
    arr[i*3+2] = f.pos.z;
  }
  posAttr.needsUpdate = true;
}

const noise2D = createNoise2D();
const TERRAIN_SIZE = 800;
const TERRAIN_SEGMENTS = 320;   // reduced per perf audit (#3)
const HEIGHT_SCALE = 7;

// Island shape: terrain is high in the center, slopes down radially to seabed past
// ISLAND_FALLOFF_END. A highland bump adds elevation in a sub-region. Natural noise
// rides on top for surface detail and an undulating shoreline.
const SEA_BOTTOM    = -10.0;   // seabed (deeper for bigger island)
const SEA_WATER_Y   = 0.0;     // sea surface — water plane lives at exact Y=0
const ISLAND_BASE   = 2.0;     // grass surface height in the island core
const DUCK_SUBMERGE_DEPTH = 0.55;  // surface-bob depth — only the head shows

function _smoothstep(a, b, x) {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

function getTerrainHeight(x, z) {
  // Noise is intentionally small (n*0.7) so the grass surface stays in roughly
  // [1.3, 2.7] — never dipping below water level (0). This is what fixes the old
  // "water peeks through the grass" bug.
  const n = noise2D(x * 0.010, z * 0.010) * 0.8
          + noise2D(x * 0.035, z * 0.035) * 0.2;

  // Radial island mask: 1 well inside the island, 0 past the falloff end.
  const r = Math.sqrt(x*x + z*z);
  const islandMask = _smoothstep(ISLAND_FALLOFF_END, ISLAND_RADIUS, r);

  // Highland bump: localized plateau with a foothill slope.
  const dx = x - HIGHLAND_X, dz = z - HIGHLAND_Z;
  const hr = Math.sqrt(dx*dx + dz*dz);
  const highMask = _smoothstep(HIGHLAND_RADIUS + HIGHLAND_FALLOFF, HIGHLAND_RADIUS, hr);
  const highlandLift = HIGHLAND_HEIGHT * highMask;

  // Combine: base land + small noise + highland lift, all lerped down to SEA_BOTTOM
  // as the mask falls off. Smooth lerp gives the beach a gradual underwater slope.
  const land = ISLAND_BASE + n * 0.7 + highlandLift;
  return SEA_BOTTOM + (land - SEA_BOTTOM) * islandMask;
}

// Walkable height. Below water surface inside the island falloff = float half-submerged.
function getWalkableY(x, z) {
  const tY = getTerrainHeight(x, z);
  const r = Math.sqrt(x*x + z*z);
  if (r > ISLAND_RADIUS - 8 && tY < SEA_WATER_Y) return SEA_WATER_Y - DUCK_SUBMERGE_DEPTH;
  return tY;
}

const terrainGeo = new THREE.PlaneGeometry(TERRAIN_SIZE, TERRAIN_SIZE, TERRAIN_SEGMENTS, TERRAIN_SEGMENTS);
terrainGeo.rotateX(-Math.PI / 2);
const pos = terrainGeo.attributes.position;
const colors = new Float32Array(pos.count * 3);
const sand    = new THREE.Color(0xd9c483);  // beach tone right at the waterline
const grass   = new THREE.Color(0x3f7825);  // main island grass
const richGrass = new THREE.Color(0x2c6b1c);  // deeper green for the highland
const seabed  = new THREE.Color(0x4f6e74);  // muted under the sea
const tmp     = new THREE.Color();
for (let i = 0; i < pos.count; i++) {
  const x = pos.getX(i);
  const z = pos.getZ(i);
  const y = getTerrainHeight(x, z);
  pos.setY(i, y);
  // 4-tone gradient driven by height:
  //   seabed (very low) → sand (waterline) → grass (lowlands) → rich grass (highland)
  let c;
  if (y < SEA_WATER_Y - 1.0) {
    c = seabed;
  } else if (y < SEA_WATER_Y + 1.0) {
    c = tmp.lerpColors(sand, grass, _smoothstep(SEA_WATER_Y - 1.0, SEA_WATER_Y + 1.0, y));
  } else if (y < 6) {
    c = grass;
  } else {
    c = tmp.lerpColors(grass, richGrass, _smoothstep(6, 12, y));
  }
  colors[i * 3]     = c.r;
  colors[i * 3 + 1] = c.g;
  colors[i * 3 + 2] = c.b;
}
terrainGeo.computeVertexNormals();
terrainGeo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
const terrain = new THREE.Mesh(
  terrainGeo,
  new THREE.MeshStandardMaterial({ vertexColors: true })
);
terrain.receiveShadow = true;
scene.add(terrain);

// === Sea surface: a single huge plane at Y=0 that wraps fully around the island.
// Where land is above water, the terrain mesh occludes the sea. Plane size is well
// past the terrain edge so the horizon fades into fog from any vantage.
const SEA_PLANE_SIZE = 2000;
const seaGeom = new THREE.PlaneGeometry(SEA_PLANE_SIZE, SEA_PLANE_SIZE, 128, 128);  // reduced per perf audit (#4)
seaGeom.rotateX(-Math.PI / 2);
const seaMaterial = new THREE.MeshStandardMaterial({
  color:       0x2a6e93,
  metalness:   0.0,
  roughness:   0.22,    // lower than before — picks up a hint of sky reflection
  transparent: true,
  opacity:     0.85,    // slightly translucent so deep water near shore looks watery
});
// Waves: radial sine moving INWARD (toward the island), with amplitude scaled by
// proximity to the shore. The island sits at the origin, so wave crests are
// concentric circles approaching the land. Foam appears on wave crests near shore.
seaMaterial.onBeforeCompile = (shader) => {
  shader.uniforms.uTime = windUniform;  // shared wind clock
  shader.vertexShader = shader.vertexShader
    .replace('#include <common>', `#include <common>
      uniform float uTime;
      varying float vCrest;
      varying float vShoreProx;`)
    .replace('#include <begin_vertex>', `
      vec3 transformed = vec3(position);
      vec3 worldP = (modelMatrix * vec4(transformed, 1.0)).xyz;
      float r = length(worldP.xz);
      // 1 right at the shoreline, 0 in deep open water. Tapers over ~150 units.
      vShoreProx = smoothstep(440.0, 290.0, r);
      // Travelling wave: sin(kr + wt) → crests move toward decreasing r (inward).
      // Longer wavelength (~31u) reads naturally on the bigger ocean.
      float wave = sin(r * 0.2 + uTime * 1.4);
      float waveAmp = mix(0.05, 0.65, vShoreProx);
      transformed.y += wave * waveAmp;
      // Cross-chop so the surface isn't a single mechanical sine.
      transformed.y += sin(worldP.x * 0.32 + uTime * 1.8) * 0.05
                     + cos(worldP.z * 0.22 + uTime * 0.6) * 0.04;
      vCrest = wave;`);
  shader.fragmentShader = shader.fragmentShader
    .replace('#include <common>', `#include <common>
      varying float vCrest;
      varying float vShoreProx;`)
    .replace('vec4 diffuseColor = vec4( diffuse, opacity );', `
      vec4 diffuseColor = vec4( diffuse, opacity );
      // White foam: bright on wave crests + a base shoreward tint.
      float crestFoam = smoothstep(0.55, 1.0, vCrest) * vShoreProx;
      float shoreFoam = smoothstep(0.75, 0.98, vShoreProx) * 0.4;
      float foam = clamp(crestFoam + shoreFoam, 0.0, 0.92);
      diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.96, 0.98, 1.0), foam);`);
};
const sea = new THREE.Mesh(seaGeom, seaMaterial);
sea.position.set(0, SEA_WATER_Y, 0);
sea.receiveShadow = true;
scene.add(sea);

// === Fish: swim in a ring of water around the island. Always rendered; the opaque
// water plane hides them from above except during a jump arc.
const FISH_COUNT     = 20;
const FISH_R_INNER   = ISLAND_RADIUS + 35;   // safely past the shore
const FISH_R_OUTER   = ISLAND_RADIUS + 130;  // within fog far so they stay visible
function _randFishPos() {
  const a = Math.random() * Math.PI * 2;
  const r = FISH_R_INNER + Math.random() * (FISH_R_OUTER - FISH_R_INNER);
  return { x: Math.cos(a) * r, z: Math.sin(a) * r };
}
function _clampFishToSea(p) {
  const r = Math.sqrt(p.x*p.x + p.z*p.z);
  if (r < FISH_R_INNER) {
    const s = FISH_R_INNER / Math.max(r, 0.001);
    p.x *= s; p.z *= s;
  } else if (r > FISH_R_OUTER) {
    const s = FISH_R_OUTER / r;
    p.x *= s; p.z *= s;
  }
}
// Body + tail must share indexing for mergeGeometries to work — IcosahedronGeometry
// is non-indexed but ConeGeometry is indexed by default, so toNonIndexed() both.
const _fishBody = new THREE.IcosahedronGeometry(0.5, 1).toNonIndexed();
_fishBody.scale(0.42, 0.3, 0.85);
const _fishTail = new THREE.ConeGeometry(0.18, 0.34, 4, 1).toNonIndexed();
_fishTail.rotateX(-Math.PI / 2);   // tip trails behind the +z head
_fishTail.translate(0, 0, -0.55);
const fishGeom = mergeGeometries([_fishBody, _fishTail]);
const fishMaterial = new THREE.MeshStandardMaterial({
  color:     0xff8a3a,
  roughness: 0.55,
  metalness: 0.10,
});
const fishes = new THREE.InstancedMesh(fishGeom, fishMaterial, FISH_COUNT);
fishes.frustumCulled = false;
fishes.castShadow    = false;
scene.add(fishes);

const fishState = [];
{
  const tmpColor = new THREE.Color();
  for (let i = 0; i < FISH_COUNT; i++) {
    const p = _randFishPos();
    fishState.push({
      mode:   'swim',
      swimX:  p.x,
      swimZ:  p.z,
      swimY:  SEA_BOTTOM + 0.4 + Math.random() * 1.4,
      yaw:    Math.random() * Math.PI * 2,
      targetX: 0, targetZ: 0, targetY: 0,
      jumpT: 0, jumpDur: 0, jumpH: 0,
      jumpYaw: 0, jumpSpeed: 0,
      jumpStartX: 0, jumpStartZ: 0,
      nextJumpDelay: 1 + Math.random() * 6,
    });
    tmpColor.setHSL(0.04 + Math.random() * 0.06, 0.85, 0.55);
    fishes.setColorAt(i, tmpColor);
  }
}
if (fishes.instanceColor) fishes.instanceColor.needsUpdate = true;

function pickFishSwimTarget(f) {
  const p = _randFishPos();
  f.targetX = p.x;
  f.targetZ = p.z;
  f.targetY = SEA_BOTTOM + 0.4 + Math.random() * 1.4;
}
for (const f of fishState) pickFishSwimTarget(f);

const _fishMat = new THREE.Matrix4();
const _fishPos = new THREE.Vector3();
const _fishQuat = new THREE.Quaternion();
const _fishScl = new THREE.Vector3(1, 1, 1);
const _fishEul = new THREE.Euler();
const FISH_SWIM_SPEED = 1.2;

function updateFish(dt) {
  for (let i = 0; i < fishState.length; i++) {
    const f = fishState[i];
    let pitch = 0;

    if (f.mode === 'jump') {
      f.jumpT += dt;
      if (f.jumpT >= f.jumpDur) {
        // splashdown — clamp inside the sea, turn around, resume swimming
        const landP = {
          x: f.jumpStartX + Math.sin(f.jumpYaw) * f.jumpSpeed * f.jumpDur,
          z: f.jumpStartZ + Math.cos(f.jumpYaw) * f.jumpSpeed * f.jumpDur,
        };
        _clampFishToSea(landP);
        f.swimX = landP.x; f.swimZ = landP.z;
        f.swimY = SEA_BOTTOM + 0.6;
        f.yaw   = f.jumpYaw + Math.PI;
        f.mode  = 'swim';
        f.nextJumpDelay = 5 + Math.random() * 12;
        pickFishSwimTarget(f);
      } else {
        const tN = f.jumpT / f.jumpDur;
        const y  = SEA_WATER_Y + 4 * f.jumpH * tN * (1 - tN);
        const dy = 4 * f.jumpH * (1 - 2 * tN) / f.jumpDur;
        const x  = f.jumpStartX + Math.sin(f.jumpYaw) * f.jumpSpeed * f.jumpT;
        const z  = f.jumpStartZ + Math.cos(f.jumpYaw) * f.jumpSpeed * f.jumpT;
        _fishPos.set(x, y, z);
        f.yaw  = f.jumpYaw;
        // Pitch: head up while rising, down while falling
        pitch = -Math.atan2(dy, f.jumpSpeed);
      }
    }
    if (f.mode === 'swim') {
      const dxT = f.targetX - f.swimX;
      const dzT = f.targetZ - f.swimZ;
      const dyT = f.targetY - f.swimY;
      const dist = Math.sqrt(dxT*dxT + dzT*dzT);
      if (dist < 0.6) {
        pickFishSwimTarget(f);
      } else {
        f.swimX += (dxT / dist) * FISH_SWIM_SPEED * dt;
        f.swimZ += (dzT / dist) * FISH_SWIM_SPEED * dt;
        f.swimY += dyT * 0.6 * dt;
        f.yaw   = Math.atan2(dxT, dzT);
      }
      _fishPos.set(f.swimX, f.swimY, f.swimZ);
      f.nextJumpDelay -= dt;
      if (f.nextJumpDelay <= 0) {
        f.mode      = 'jump';
        f.jumpT     = 0;
        f.jumpDur   = 0.7 + Math.random() * 0.5;
        f.jumpH     = 1.0 + Math.random() * 1.4;
        f.jumpYaw   = Math.random() * Math.PI * 2;
        f.jumpSpeed = 0.8 + Math.random() * 1.4;
        f.jumpStartX = f.swimX;
        f.jumpStartZ = f.swimZ;
      }
    }

    _fishEul.set(pitch, f.yaw, 0, 'YXZ');
    _fishQuat.setFromEuler(_fishEul);
    _fishMat.compose(_fishPos, _fishQuat, _fishScl);
    fishes.setMatrixAt(i, _fishMat);
  }
  fishes.instanceMatrix.needsUpdate = true;
}

// =====================================================================
// === Tree economy (resources, planting, growth) — Part 1 of 3
// =====================================================================
// Self-contained, additive system: world trees register themselves into the
// `trees` array when placed; the duck can chop trees with Space (near) for
// logs + saplings; `P` plants a sapling; saplings grow into trees on the
// night→day transition. See block near `const clock` for the helpers.

const INV_STORAGE_KEY    = 'duckIsland_inventory_v1';
const TREES_STORAGE_KEY  = 'duckIsland_trees_v1';
// halfLogCredit: half logs cost 0.5 of a log. To keep the math integer, the
// first half-log placement deducts 1 log and banks `halfLogCredit = 1`; the
// next half-log placement consumes that credit without taking from logs.
const inventory = { logs: 0, saplings: 0, halfLogCredit: 0 };
function loadInventory() {
  try {
    const raw = localStorage.getItem(INV_STORAGE_KEY);
    if (!raw) return;
    const d = JSON.parse(raw);
    if (typeof d.logs === 'number') inventory.logs = d.logs;
    if (typeof d.saplings === 'number') inventory.saplings = d.saplings;
    if (typeof d.halfLogCredit === 'number') inventory.halfLogCredit = d.halfLogCredit;
  } catch (e) {}
}
function saveInventory() {
  try { localStorage.setItem(INV_STORAGE_KEY, JSON.stringify(inventory)); } catch (e) {}
}
loadInventory();

const invHud = document.createElement('div');
invHud.id = 'invHud';
invHud.style.cssText = `
  position: fixed; top: 40px; left: 12px;
  font: 13px/1.4 -apple-system, system-ui, sans-serif;
  color: #fff; text-shadow: 0 1px 2px rgba(0,0,0,.55);
  pointer-events: none; user-select: none;
`;
document.body.appendChild(invHud);
function updateInvHud() {
  invHud.textContent = `🪵 ${inventory.logs} logs · 🌱 ${inventory.saplings} saplings`;
}
updateInvHud();

// Registry of every individual tree (world + planted). Populated below during
// world generation; mutated by chop/plant/grow. Each entry:
//   { origin: 'world'|'world-palm'|'planted', position: {x,y,z}, plantedAtDay,
//     isFullyGrown, stage, colliderIdx,
//     // 'world'/'world-palm': variantIdx + instanceIdx for hiding
//     // 'planted': mesh (THREE.Object3D) }
const trees = [];
const variantInstancedMeshes = [];   // [vi] -> Array<InstancedMesh> (filled below)
let palmTrunkIM  = null;
let palmFrondsIM = null;
let currentDay         = 0;
let daysSinceWildSpawn = 0;

// === Trees ===
// Three categories:
//   - Coast: procedural coconut palms placed in a ring near the shoreline
//   - Mid-island: standard ez-tree variants (0..2) spread across the lowlands
//   - Highland: lush ez-tree variant (3) clustered around the highland plateau
const TREE_VARIANTS    = 4;            // 0-2 normal, 3 lush highland
const TREE_COUNT_MAIN  = 360;
const TREE_COUNT_HIGH  = 200;
const PALM_COUNT       = 110;
const DUCK_RADIUS      = 0.35;
const treeColliders = [];  // populated below, consumed in animate()

const barkMaterial    = new THREE.MeshLambertMaterial({ color: 0x6b3f1d });
const leafMaterial    = new THREE.MeshLambertMaterial({
  color: 0x3a8a2c,
  side: THREE.DoubleSide,
  flatShading: true,
});
const lushLeafMaterial = new THREE.MeshLambertMaterial({
  color: 0x2d7a23,                     // deeper, more saturated green for the forest
  side: THREE.DoubleSide,
  flatShading: true,
});

// Generate the ez-tree variants. Variant 3 has denser foliage for the highland.
const treeVariants = [];
const variantTopY = [];  // tree-local max y per variant (for climbing)
for (let v = 0; v < TREE_VARIANTS; v++) {
  const t = new Tree();
  t.options.seed = v * 137 + 17;
  t.options.branch.levels = 2;
  t.options.branch.sections = { 0: 5, 1: 4, 2: 3, 3: 3 };
  t.options.branch.segments = { 0: 5, 1: 4, 2: 3, 3: 3 };
  if (v === 3) {
    t.options.leaves.count = 3;
    t.options.leaves.size  = 1.7;
  } else {
    t.options.leaves.count = 2;
    t.options.leaves.size  = 1.4;
  }
  t.generate();
  t.updateMatrixWorld(true);
  const subs = [];
  let topY = 0;
  t.traverse((o) => {
    if (!o.isMesh) return;
    const g = o.geometry.clone();
    g.applyMatrix4(o.matrixWorld);
    g.computeBoundingBox();
    if (g.boundingBox.max.y > topY) topY = g.boundingBox.max.y;
    const isLeaf = o.material && o.material.name === 'leaves';
    const leafMat = (v === 3) ? lushLeafMaterial : leafMaterial;
    subs.push({ geometry: g, material: isLeaf ? leafMat : barkMaterial });
  });
  treeVariants.push(subs);
  variantTopY.push(topY);
}

const variantTransforms = treeVariants.map(() => []);
const _treeUp = new THREE.Vector3(0, 1, 0);
const _treeQuat = new THREE.Quaternion();
function placeTreeAt(vi, x, z, scl) {
  const y = getTerrainHeight(x, z);
  if (y < SEA_WATER_Y + 0.5) return false;  // skip waterline / submerged
  _treeQuat.setFromAxisAngle(_treeUp, Math.random() * Math.PI * 2);
  const instanceIdx = variantTransforms[vi].length;
  variantTransforms[vi].push(new THREE.Matrix4().compose(
    new THREE.Vector3(x, y, z), _treeQuat, new THREE.Vector3(scl, scl, scl),
  ));
  const colliderIdx = treeColliders.length;
  treeColliders.push({ x, z, r: 1.5 * scl + DUCK_RADIUS, top: y + variantTopY[vi] * scl });
  // Tree economy registration — additive, no behavioural change for existing code.
  trees.push({
    origin: 'world',
    variantIdx: vi, instanceIdx, colliderIdx,
    position: { x, y, z },
    plantedAtDay: 0, isFullyGrown: true, stage: 'grown',
  });
  return true;
}

// Main inland trees — anywhere on the island that isn't the palm-coast ring.
const COAST_RING_INNER = ISLAND_RADIUS - 18;  // beyond this, palms only
{
  let placed = 0;
  for (let i = 0; i < TREE_COUNT_MAIN * 4 && placed < TREE_COUNT_MAIN; i++) {
    // Bias toward smaller radii so it doesn't all crowd the coast.
    const a = Math.random() * Math.PI * 2;
    const r = Math.sqrt(Math.random()) * COAST_RING_INNER;
    const x = Math.cos(a) * r;
    const z = Math.sin(a) * r;
    const vi  = Math.floor(Math.random() * 3);  // variants 0-2
    const scl = 0.18 + Math.random() * 0.14;
    if (placeTreeAt(vi, x, z, scl)) placed++;
  }
}

// Highland forest — dense cluster of lush trees on and around the plateau.
{
  const HIGH_OUTER_R = HIGHLAND_RADIUS + HIGHLAND_FALLOFF * 0.65;
  let placed = 0;
  for (let i = 0; i < TREE_COUNT_HIGH * 4 && placed < TREE_COUNT_HIGH; i++) {
    const a = Math.random() * Math.PI * 2;
    const r = Math.sqrt(Math.random()) * HIGH_OUTER_R;
    const x = HIGHLAND_X + Math.cos(a) * r;
    const z = HIGHLAND_Z + Math.sin(a) * r;
    if (Math.sqrt(x*x + z*z) > COAST_RING_INNER) continue;  // never escape into palm ring
    const scl = 0.22 + Math.random() * 0.13;
    if (placeTreeAt(3, x, z, scl)) placed++;
  }
}

for (let vi = 0; vi < TREE_VARIANTS; vi++) {
  const subs = treeVariants[vi];
  const xs   = variantTransforms[vi];
  variantInstancedMeshes[vi] = [];   // tree-economy chop hook needs these refs
  if (!xs.length) continue;
  for (const { geometry, material } of subs) {
    const im = new THREE.InstancedMesh(geometry, material, xs.length);
    im.castShadow = false;
    im.receiveShadow = true;
    for (let k = 0; k < xs.length; k++) im.setMatrixAt(k, xs[k]);
    im.instanceMatrix.needsUpdate = true;
    variantInstancedMeshes[vi].push(im);
    scene.add(im);
  }
}

// === Coconut palms: procedural trunk + drooping fronds, scattered around the coast ===
const palmTrunkMat = new THREE.MeshLambertMaterial({ color: 0x6a4a26 });
const palmFrondMat = new THREE.MeshLambertMaterial({
  color: 0x4ea53a,
  side: THREE.DoubleSide,
  flatShading: true,
});

// Trunk: tapered cylinder, base at y=0, top at y=4.2.
const palmTrunkGeom = new THREE.CylinderGeometry(0.18, 0.28, 4.2, 6, 4);
palmTrunkGeom.translate(0, 2.1, 0);

// Single drooping frond, pivot at the trunk side (x=0). Build by curving a plane.
function _buildFrondsGeom() {
  const FROND_COUNT = 8;
  const fronds = [];
  for (let i = 0; i < FROND_COUNT; i++) {
    const f = new THREE.PlaneGeometry(2.6, 0.55, 6, 1).toNonIndexed();
    // Droop the tip downward via a quadratic in local x.
    const pos = f.attributes.position;
    for (let k = 0; k < pos.count; k++) {
      const fx = pos.getX(k);            // [-1.3, 1.3]
      const t  = (fx + 1.3) / 2.6;       // 0 at trunk side, 1 at tip
      pos.setY(k, pos.getY(k) - t * t * 0.7);
      pos.setX(k, fx + 1.3);             // shift so trunk side sits at x=0
    }
    f.attributes.position.needsUpdate = true;
    f.computeVertexNormals();
    // Slight upward tilt at the base of each frond + random Y to fan around the trunk.
    f.rotateZ(0.12);
    f.rotateY((i / FROND_COUNT) * Math.PI * 2 + (Math.random() - 0.5) * 0.2);
    f.translate(0, 4.1, 0);              // sit at the top of the trunk
    fronds.push(f);
  }
  return mergeGeometries(fronds);
}
const palmFrondsGeom = _buildFrondsGeom();

const palmTransforms = [];
{
  // Place palms in a ring just inland of the shoreline.
  let placed = 0;
  for (let i = 0; i < PALM_COUNT * 6 && placed < PALM_COUNT; i++) {
    const a = Math.random() * Math.PI * 2;
    // Hug the actual shoreline: from just inland of the coast out to where terrain dips underwater.
    const r = (ISLAND_RADIUS - 15) + Math.random() * 35;
    const x = Math.cos(a) * r;
    const z = Math.sin(a) * r;
    const y = getTerrainHeight(x, z);
    if (y < SEA_WATER_Y + 0.25 || y > SEA_WATER_Y + 4) continue;  // beach band only
    const scl = 0.45 + Math.random() * 0.35;
    const q = new THREE.Quaternion().setFromAxisAngle(_treeUp, Math.random() * Math.PI * 2);
    const instanceIdx = palmTransforms.length;
    palmTransforms.push(new THREE.Matrix4().compose(
      new THREE.Vector3(x, y, z), q, new THREE.Vector3(scl, scl, scl),
    ));
    const colliderIdx = treeColliders.length;
    treeColliders.push({ x, z, r: 0.28 * scl + DUCK_RADIUS, top: y + 4.2 * scl });
    // Tree economy registration for the palm.
    trees.push({
      origin: 'world-palm',
      instanceIdx, colliderIdx,
      position: { x, y, z },
      plantedAtDay: 0, isFullyGrown: true, stage: 'grown',
    });
    placed++;
  }
}

if (palmTransforms.length > 0) {
  const _ims = [];
  for (const [geom, mat] of [[palmTrunkGeom, palmTrunkMat], [palmFrondsGeom, palmFrondMat]]) {
    const im = new THREE.InstancedMesh(geom, mat, palmTransforms.length);
    im.castShadow = false;
    im.receiveShadow = true;
    for (let k = 0; k < palmTransforms.length; k++) im.setMatrixAt(k, palmTransforms[k]);
    im.instanceMatrix.needsUpdate = true;
    scene.add(im);
    _ims.push(im);
  }
  palmTrunkIM  = _ims[0];
  palmFrondsIM = _ims[1];
}

// === Tiny white flowers scattered on tree leaves ===
// Per-variant leaf samplers — sample a max pool of points each, take a random subset per tree.
const TREE_FLOWER_MAX_PER_TREE = 80;  // upper bound; each tree picks 0..this many
const TREE_FLOWER_RADIUS       = 0.12;

const variantLeafPool = [];  // [variantIdx] → array of THREE.Vector3 in variant-local space
for (let vi = 0; vi < TREE_VARIANTS; vi++) {
  const leafSub = treeVariants[vi].find((s) => s.material === leafMaterial);
  if (!leafSub) { variantLeafPool.push(null); continue; }
  const sampler = new MeshSurfaceSampler(new THREE.Mesh(leafSub.geometry)).build();
  const pool = [];
  const tmp = new THREE.Vector3();
  for (let k = 0; k < 160; k++) {  // bigger pool so more flowers can be picked per tree
    sampler.sample(tmp);
    pool.push(tmp.clone());
  }
  variantLeafPool.push(pool);
}

// Build world-space matrices for every flower across every tree.
const _flowerWorld = new THREE.Vector3();
const _flowerScl   = new THREE.Vector3(1, 1, 1);
const _flowerQuat  = new THREE.Quaternion();
const treeFlowerMats = [];
for (let vi = 0; vi < TREE_VARIANTS; vi++) {
  const pool = variantLeafPool[vi];
  if (!pool) continue;
  for (const treeMat of variantTransforms[vi]) {
    // Per tree: random count (some trees 0, some many).
    // Bias toward more flowers (exponent < 1) so most trees bloom densely; some still empty.
    const n = Math.floor(Math.pow(Math.random(), 0.6) * (TREE_FLOWER_MAX_PER_TREE + 1));
    if (n === 0) continue;
    // Pick n distinct local positions from the pool.
    const indices = [];
    while (indices.length < n) {
      const k = Math.floor(Math.random() * pool.length);
      if (!indices.includes(k)) indices.push(k);
    }
    for (const idx of indices) {
      _flowerWorld.copy(pool[idx]).applyMatrix4(treeMat);
      const m = new THREE.Matrix4().compose(_flowerWorld, _flowerQuat, _flowerScl);
      treeFlowerMats.push(m);
    }
  }
}

if (treeFlowerMats.length > 0) {
  const flowerGeom = new THREE.SphereGeometry(TREE_FLOWER_RADIUS, 6, 5);
  const flowerMat  = new THREE.MeshLambertMaterial({ color: 0xffffff });
  const treeFlowers = new THREE.InstancedMesh(flowerGeom, flowerMat, treeFlowerMats.length);
  treeFlowers.castShadow = false;
  treeFlowers.receiveShadow = true;
  for (let i = 0; i < treeFlowerMats.length; i++) treeFlowers.setMatrixAt(i, treeFlowerMats[i]);
  treeFlowers.instanceMatrix.needsUpdate = true;
  scene.add(treeFlowers);
}

// === Animated grass (al-ro slerp wind + FluffyGrass tip-color & height variation) ===
const GRASS_COUNT  = 140000;   // halved from 320k after perf audit (#1)
const BLADE_WIDTH  = 0.085;    // slightly thicker blade compensates for the lower density
const BLADE_HEIGHT = 0.09;
const BLADE_JOINTS = 2;        // 1x2-segment plane = 4 tris per blade instead of 6

// Procedural Perlin-ish noise texture (replaces FluffyGrass's perlinnoise.webp).
function makeNoiseTexture(size = 128) {
  const data = new Uint8Array(size * size * 4);
  const n = createNoise2D();
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let v = 0.5 + 0.4 * n(x * 0.06, y * 0.06) + 0.2 * n(x * 0.15, y * 0.15);
      v = Math.max(0, Math.min(1, v));
      const c = Math.floor(v * 255);
      const i = (y * size + x) * 4;
      data[i] = c; data[i+1] = c; data[i+2] = c; data[i+3] = 255;
    }
  }
  const tex = new THREE.DataTexture(data, size, size);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearFilter;
  tex.needsUpdate = true;
  return tex;
}
const grassNoiseTex = makeNoiseTexture(128);

const bladeBase = new THREE.PlaneGeometry(BLADE_WIDTH, BLADE_HEIGHT, 1, BLADE_JOINTS);
bladeBase.translate(0, BLADE_HEIGHT / 2, 0);  // root at y=0

const grassGeom = new THREE.InstancedBufferGeometry();
grassGeom.index = bladeBase.index;
grassGeom.setAttribute('position', bladeBase.attributes.position);
grassGeom.setAttribute('uv', bladeBase.attributes.uv);

const offsets          = new Float32Array(GRASS_COUNT * 3);
const orientations     = new Float32Array(GRASS_COUNT * 4);
const stretches        = new Float32Array(GRASS_COUNT);
const halfRootAngleSin = new Float32Array(GRASS_COUNT);
const halfRootAngleCos = new Float32Array(GRASS_COUNT);

const mulQ = (a, b) => new THREE.Vector4(
  a.x*b.w + a.y*b.z - a.z*b.y + a.w*b.x,
 -a.x*b.z + a.y*b.w + a.z*b.x + a.w*b.y,
  a.x*b.y - a.y*b.x + a.z*b.w + a.w*b.z,
 -a.x*b.x - a.y*b.y - a.z*b.z + a.w*b.w
);
const TILT_MIN = -0.25, TILT_MAX = 0.25;
let qY = new THREE.Vector4(), qX = new THREE.Vector4(), qZ = new THREE.Vector4();
for (let i = 0; i < GRASS_COUNT; i++) {
  // Sample uniformly inside the island disc — avoids rejection sampling.
  const polarA = Math.random() * Math.PI * 2;
  const polarR = Math.sqrt(Math.random()) * (ISLAND_RADIUS - 4);
  const x = Math.cos(polarA) * polarR;
  const z = Math.sin(polarA) * polarR;
  const y = getTerrainHeight(x, z);
  offsets[i*3] = x; offsets[i*3+1] = y; offsets[i*3+2] = z;

  let a = Math.PI - Math.random() * 2 * Math.PI;
  halfRootAngleSin[i] = Math.sin(0.5 * a);
  halfRootAngleCos[i] = Math.cos(0.5 * a);
  qY.set(0, Math.sin(a/2), 0, Math.cos(a/2)).normalize();

  a = Math.random() * (TILT_MAX - TILT_MIN) + TILT_MIN;
  qX.set(Math.sin(a/2), 0, 0, Math.cos(a/2)).normalize();
  let q = mulQ(qY, qX);

  a = Math.random() * (TILT_MAX - TILT_MIN) + TILT_MIN;
  qZ.set(0, 0, Math.sin(a/2), Math.cos(a/2)).normalize();
  q = mulQ(q, qZ);

  orientations[i*4] = q.x; orientations[i*4+1] = q.y;
  orientations[i*4+2] = q.z; orientations[i*4+3] = q.w;
  stretches[i] = i < GRASS_COUNT / 3 ? Math.random() * 1.8 : Math.random();
}

grassGeom.setAttribute('offset',           new THREE.InstancedBufferAttribute(offsets, 3));
grassGeom.setAttribute('orientation',      new THREE.InstancedBufferAttribute(orientations, 4));
grassGeom.setAttribute('stretch',          new THREE.InstancedBufferAttribute(stretches, 1));
grassGeom.setAttribute('halfRootAngleSin', new THREE.InstancedBufferAttribute(halfRootAngleSin, 1));
grassGeom.setAttribute('halfRootAngleCos', new THREE.InstancedBufferAttribute(halfRootAngleCos, 1));

const grassMaterial = new THREE.ShaderMaterial({
  side: THREE.DoubleSide,
  uniforms: {
    time:         { value: 0 },
    bladeHeight:  { value: BLADE_HEIGHT },
    bottomColor:  { value: new THREE.Color(0x1d3a16).convertSRGBToLinear() },
    tipColor1:    { value: new THREE.Color(0x9bd38d).convertSRGBToLinear() },
    tipColor2:    { value: new THREE.Color(0x4a8a30).convertSRGBToLinear() },
    uNoiseTex:    { value: grassNoiseTex },
    uNoiseScale:  { value: 1.5 },
    uTerrainSize: { value: TERRAIN_SIZE },
    uColorMult:   { value: 1.0 },  // 1 by day, ~0.3 at night to dim the saturated tip colors
  },
  vertexShader: `
    precision mediump float;
    attribute vec3 offset;
    attribute vec4 orientation;
    attribute float halfRootAngleSin;
    attribute float halfRootAngleCos;
    attribute float stretch;
    uniform float time;
    uniform float bladeHeight;
    uniform sampler2D uNoiseTex;
    uniform float uNoiseScale;
    uniform float uTerrainSize;
    varying vec2 vUv;
    varying vec2 vGlobalUV;
    varying float frc;

    vec3 mod289(vec3 x){ return x - floor(x * (1.0/289.0)) * 289.0; }
    vec2 mod289(vec2 x){ return x - floor(x * (1.0/289.0)) * 289.0; }
    vec3 permute(vec3 x){ return mod289(((x*34.0)+1.0)*x); }
    float snoise(vec2 v){
      const vec4 C = vec4(0.211324865405187, 0.366025403784439, -0.577350269189626, 0.024390243902439);
      vec2 i  = floor(v + dot(v, C.yy));
      vec2 x0 = v - i + dot(i, C.xx);
      vec2 i1 = (x0.x > x0.y) ? vec2(1.0, 0.0) : vec2(0.0, 1.0);
      vec4 x12 = x0.xyxy + C.xxzz; x12.xy -= i1;
      i = mod289(i);
      vec3 p = permute(permute(i.y + vec3(0.0, i1.y, 1.0)) + i.x + vec3(0.0, i1.x, 1.0));
      vec3 m = max(0.5 - vec3(dot(x0,x0), dot(x12.xy,x12.xy), dot(x12.zw,x12.zw)), 0.0);
      m = m*m; m = m*m;
      vec3 xn = 2.0 * fract(p * C.www) - 1.0;
      vec3 h  = abs(xn) - 0.5;
      vec3 ox = floor(xn + 0.5);
      vec3 a0 = xn - ox;
      m *= 1.79284291400159 - 0.85373472095314 * (a0*a0 + h*h);
      vec3 g;
      g.x  = a0.x * x0.x + h.x * x0.y;
      g.yz = a0.yz * x12.xz + h.yz * x12.yw;
      return 130.0 * dot(m, g);
    }

    vec3 rotateVectorByQuaternion(vec3 v, vec4 q){
      return 2.0 * cross(q.xyz, v * q.w + cross(q.xyz, v)) + v;
    }

    vec4 slerp(vec4 v0, vec4 v1, float t){
      v0 = normalize(v0); v1 = normalize(v1);
      float d = dot(v0, v1);
      if (d < 0.0) { v1 = -v1; d = -d; }
      const float DOT_THRESHOLD = 0.9995;
      if (d > DOT_THRESHOLD) {
        return normalize(t*(v1 - v0) + v0);
      }
      float theta_0 = acos(d);
      float theta   = theta_0 * t;
      float sT = sin(theta), sT0 = sin(theta_0);
      float s0 = cos(theta) - d * sT / sT0;
      float s1 = sT / sT0;
      return s0 * v0 + s1 * v1;
    }

    void main(){
      frc = position.y / bladeHeight;
      float n = 1.0 - snoise(vec2(time - offset.x/50.0, time - offset.z/50.0));
      vec4 dir = vec4(0.0, halfRootAngleSin, 0.0, halfRootAngleCos);
      dir = slerp(dir, orientation, frc);
      vec3 vp = vec3(position.x, position.y + position.y * stretch, position.z);
      vp = rotateVectorByQuaternion(vp, dir);
      float ha = n * 0.15;
      vp = rotateVectorByQuaternion(vp, normalize(vec4(sin(ha), 0.0, -sin(ha), cos(ha))));
      vUv = uv;
      vec3 wp = offset + vp;
      vGlobalUV = (uTerrainSize * 0.5 - wp.xz) / uTerrainSize;
      // Vertical tuft variation: some patches grow noticeably taller.
      wp.y += texture2D(uNoiseTex, vGlobalUV * uNoiseScale).r * 0.45 * frc;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(wp, 1.0);
    }
  `,
  fragmentShader: `
    precision mediump float;
    uniform vec3 bottomColor;
    uniform vec3 tipColor1;
    uniform vec3 tipColor2;
    uniform sampler2D uNoiseTex;
    uniform float uNoiseScale;
    uniform float uColorMult;
    varying vec2 vUv;
    varying vec2 vGlobalUV;
    varying float frc;

    void main(){
      // Procedural blade-shaped alpha (replaces blade_alpha.jpg).
      float dist  = abs(vUv.x - 0.5) * 2.0;
      float taper = 1.0 - vUv.y * 0.45;  // softer taper for fuller blades
      if (dist > taper) discard;
      // FluffyGrass-style tip variation: two tip colours mixed by a world-space noise sample.
      float colorN = texture2D(uNoiseTex, vGlobalUV * uNoiseScale).r;
      vec3 tip = mix(tipColor1, tipColor2, colorN);
      vec3 col = mix(bottomColor, tip, frc) * uColorMult;
      gl_FragColor = vec4(col, 1.0);
      #include <tonemapping_fragment>
      #include <colorspace_fragment>
    }
  `,
});

const grassMesh = new THREE.Mesh(grassGeom, grassMaterial);
grassMesh.frustumCulled = false;  // instanced geometry doesn't have meaningful bounds
scene.add(grassMesh);

const windUniform = { value: 0 };  // shared wind clock, advanced once per frame in animate()

const FLOWER_SCALE = 0.5;
const FLOWER_CLUSTERS = 800;    // dropped to relieve flower-instance tri load (perf)
const FLOWER_SPREAD = 1.4;

new GLTFLoader().load('flower.glb', (gltf) => {
  const groupsByMaterial = new Map();
  gltf.scene.updateMatrixWorld(true);
  gltf.scene.traverse((o) => {
    if (!o.isMesh) return;
    const geom = o.geometry.clone();
    geom.applyMatrix4(o.matrixWorld);
    if (!groupsByMaterial.has(o.material)) groupsByMaterial.set(o.material, []);
    groupsByMaterial.get(o.material).push(geom);
  });

  const merged = [];
  const flowerBbox = new THREE.Box3();
  for (const [mat, geoms] of groupsByMaterial) {
    const g = mergeGeometries(geoms, false);
    g.computeBoundingBox();
    flowerBbox.union(g.boundingBox);
    merged.push({ material: mat, geometry: g });
  }
  const flowerBaseOffset = -flowerBbox.min.y;  // lift so the bottom sits on the ground

  const transforms = [];
  const tmpQuat = new THREE.Quaternion();
  const upAxis  = new THREE.Vector3(0, 1, 0);
  for (let c = 0; c < FLOWER_CLUSTERS; c++) {
    // Pick a cluster center somewhere on the island disc.
    const polarA = Math.random() * Math.PI * 2;
    const polarR = Math.sqrt(Math.random()) * (ISLAND_RADIUS - 6);
    const cx = Math.cos(polarA) * polarR;
    const cz = Math.sin(polarA) * polarR;
    const groupSize = 1 + Math.floor(Math.random() * 3);
    const angleStart = Math.random() * Math.PI * 2;  // rotate the whole cluster
    for (let k = 0; k < groupSize; k++) {
      // Even angular spacing + small jitter prevents two flowers landing on top of each other.
      const a = angleStart + (k / groupSize) * Math.PI * 2 + (Math.random() - 0.5) * 0.6;
      const r = groupSize === 1 ? 0 : 0.7 + Math.random() * (FLOWER_SPREAD - 0.7);
      const x = cx + Math.cos(a) * r;
      const z = cz + Math.sin(a) * r;
      const y = getTerrainHeight(x, z);
      const s = FLOWER_SCALE * (0.85 + Math.random() * 0.3);
      tmpQuat.setFromAxisAngle(upAxis, Math.random() * Math.PI * 2);
      transforms.push(new THREE.Matrix4().compose(
        new THREE.Vector3(x, y + flowerBaseOffset * s, z),
        tmpQuat,
        new THREE.Vector3(s, s, s)
      ));
    }
  }

  // Decide each flower's petal color once, so all petal sub-meshes match per instance.
  const pink  = new THREE.Color(0xffb3cf);
  const white = new THREE.Color(0xffffff);
  const flowerColor = transforms.map(() => Math.random() < 0.5 ? pink : white);
  // Pink: high red, more blue than green. Yellow has more green than blue, so it's excluded.
  const isPetalMat = (m) => m.color && m.color.r > 0.5 && m.color.b > m.color.g;

  const minY = flowerBbox.min.y;
  const flowerHeightRange = Math.max(0.001, flowerBbox.max.y - flowerBbox.min.y);

  // Expose flower top positions so butterflies can perch on them.
  for (const m of transforms) {
    const p = new THREE.Vector3().setFromMatrixPosition(m);
    const s = m.elements[0];  // uniform scale
    flowerPerches.push(new THREE.Vector3(p.x, p.y + flowerBbox.max.y * s + 0.05, p.z));
  }
  initButterflies();

  for (const { material, geometry } of merged) {
    const tintable = isPetalMat(material);
    const mat = material.clone();
    if (tintable) mat.color.set(0xffffff);

    mat.onBeforeCompile = (shader) => {
      shader.uniforms.uTime         = windUniform;
      shader.uniforms.uFlowerMinY   = { value: minY };
      shader.uniforms.uFlowerHeight = { value: flowerHeightRange };
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', `#include <common>
          uniform float uTime;
          uniform float uFlowerMinY;
          uniform float uFlowerHeight;`)
        .replace('#include <project_vertex>', `
          vec4 mvPosition = vec4(transformed, 1.0);
          #ifdef USE_INSTANCING
            mvPosition = instanceMatrix * mvPosition;
          #endif
          {
            float h = (position.y - uFlowerMinY) / uFlowerHeight;
            float bend = smoothstep(0.0, 1.0, h);
            mvPosition.x += bend * 0.10 * sin(uTime * 1.4 + mvPosition.x * 0.35 + mvPosition.z * 0.45);
            mvPosition.z += bend * 0.08 * cos(uTime * 1.0 + mvPosition.x * 0.55 + mvPosition.z * 0.25);
          }
          mvPosition = modelViewMatrix * mvPosition;
          gl_Position = projectionMatrix * mvPosition;`);
    };

    const im = new THREE.InstancedMesh(geometry, mat, transforms.length);
    im.castShadow = false;
    im.receiveShadow = true;
    im.frustumCulled = false;  // wind sway pushes verts past the geometry's static bbox
    for (let k = 0; k < transforms.length; k++) {
      im.setMatrixAt(k, transforms[k]);
      if (tintable) im.setColorAt(k, flowerColor[k]);
    }
    im.instanceMatrix.needsUpdate = true;
    if (tintable && im.instanceColor) im.instanceColor.needsUpdate = true;
    scene.add(im);
  }
}, undefined, () => console.warn('flower.glb not found'));

const player = new THREE.Group();

// Duck lantern: warm golden point light + visible flame sprite, positioned where
// the duck would hold a lantern (slightly forward, off to the side, at body height).
// Player forward is +Z, so x=side, z=forward in player-local space.
const LANTERN_POS = new THREE.Vector3(0.3, 0.5, 0.45);
const LANTERN_COLOR = 0xffb84a;  // saturated warm gold

const duckGlow = new THREE.PointLight(LANTERN_COLOR, 0.0, 14, 1.6);
duckGlow.position.copy(LANTERN_POS);
duckGlow.castShadow = false;
player.add(duckGlow);

function makeLanternFlameTexture(size = 128) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const ctx = c.getContext('2d');
  const g = ctx.createRadialGradient(size/2, size/2, 0, size/2, size/2, size/2);
  g.addColorStop(0,    'rgba(255, 235, 170, 1.00)');
  g.addColorStop(0.30, 'rgba(255, 195, 100, 0.65)');
  g.addColorStop(1,    'rgba(255, 160,  50, 0.00)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  return new THREE.CanvasTexture(c);
}
const duckHalo = new THREE.Sprite(new THREE.SpriteMaterial({
  map:        makeLanternFlameTexture(),
  blending:   THREE.AdditiveBlending,
  depthWrite: false,
  transparent: true,
}));
duckHalo.scale.set(1.0, 1.0, 1);  // small lantern-flame sized halo
duckHalo.position.copy(LANTERN_POS);
duckHalo.visible = false;
player.add(duckHalo);
scene.add(player);

const placeholder = new THREE.Mesh(
  new THREE.BoxGeometry(0.8, 1.2, 0.8),
  new THREE.MeshStandardMaterial({ color: 0xffd54a })
);
placeholder.position.y = 0.6;
placeholder.castShadow = true;
player.add(placeholder);

let mixer = null;
const actions = {};
let currentAction = null;
let moveActionName = null;   // cached at duck.glb load time (perf audit #5)
let idleActionName = null;
// Flip if your duck faces away from the move direction after loading.
const MODEL_FACING_OFFSET = 0;
const DUCK_SCALE = 0.3;

function setAction(name) {
  if (!actions[name] || currentAction === actions[name]) return;
  if (currentAction) currentAction.fadeOut(0.2);
  actions[name].reset().fadeIn(0.2).play();
  currentAction = actions[name];
}

new GLTFLoader().load(
  'duck.glb',
  (gltf) => {
    player.remove(placeholder);
    const model = gltf.scene;
    model.scale.setScalar(DUCK_SCALE);
    model.traverse((o) => {
      if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; }
    });
    player.add(model);
    if (gltf.animations.length) {
      mixer = new THREE.AnimationMixer(model);
      for (const clip of gltf.animations) {
        actions[clip.name.toLowerCase()] = mixer.clipAction(clip);
      }
      const first = Object.keys(actions)[0];
      // Cache the move/idle action names once (perf audit #5) so animate() doesn't
      // run Object.keys + find every frame.
      moveActionName = Object.keys(actions).find(n => n.includes('walk') || n.includes('run') || n.includes('jump')) || null;
      idleActionName = Object.keys(actions).find(n => n.includes('idle')) || first;
      if (idleActionName) { currentAction = actions[idleActionName]; currentAction.play(); }
    }
  },
  undefined,
  () => console.warn('duck.glb not found yet — using placeholder cube. Drop your exported file in next to index.html.')
);

// Spawn at the origin — well inland of the shoreline so the duck starts on dry land.
player.position.set(0, getWalkableY(0, 0), 0);
// Seed the camera target so the first animate() frame doesn't snap from origin.
_cameraTarget.copy(player.position);

const keys = {};
addEventListener('keydown', (e) => keys[e.code] = true);
addEventListener('keyup',   (e) => keys[e.code] = false);
// Clear all held keys when the window loses focus — prevents stuck-key runaway
// where a movement key stays "held" if you Alt-Tab away while pressing it.
addEventListener('blur', () => { for (const k in keys) keys[k] = false; });

const PITCH_MIN = 0.05;
const PITCH_MAX = Math.PI / 2 - 0.1;
let cameraYaw = 0, cameraPitch = 0.35;
let targetYaw = cameraYaw, targetPitch = cameraPitch;
let leftDragging  = false;   // explore: orbit
let rightDragging = false;   // build: orbit (when dragged past threshold) or remove (on tap)
let rightDragMovedSq = 0;    // squared pixel distance from rightDragStart
let rightDragStartX = 0;
let rightDragStartY = 0;
let lastX = 0, lastY = 0;
const RIGHT_TAP_THRESHOLD_SQ = 25;  // (5px)^2 — under this, treat right-up as a "tap"

const canvas = renderer.domElement;
canvas.addEventListener('mousedown', (e) => {
  // Left mouse: orbit (explore) / place (build).
  if (e.button === 0) {
    if (gameMode === 'build') {
      // Single click → place. Drag-to-orbit on left is intentionally disabled
      // in build mode so it doesn't fight with placement.
      placeSelectedPart();
    } else {
      leftDragging = true;
      lastX = e.clientX; lastY = e.clientY;
    }
  } else if (e.button === 2 && gameMode === 'build') {
    // Right mouse in build: track movement; on mouseup, drag-vs-tap decides
    // between "orbit camera" and "remove hovered part".
    rightDragging = true;
    rightDragMovedSq = 0;
    rightDragStartX = e.clientX; rightDragStartY = e.clientY;
    lastX = e.clientX; lastY = e.clientY;
  }
});
addEventListener('mouseup', (e) => {
  if (e.button === 0) leftDragging = false;
  if (e.button === 2 && rightDragging) {
    if (gameMode === 'build' && rightDragMovedSq < RIGHT_TAP_THRESHOLD_SQ) {
      removeHoveredPart();
    }
    rightDragging = false;
  }
});
addEventListener('mousemove', (e) => {
  const dx = e.clientX - lastX;
  const dy = e.clientY - lastY;
  if (leftDragging) {
    targetYaw   -= dx * 0.005;
    targetPitch = THREE.MathUtils.clamp(targetPitch - dy * 0.005, PITCH_MIN, PITCH_MAX);
  } else if (rightDragging) {
    const totalDx = e.clientX - rightDragStartX;
    const totalDy = e.clientY - rightDragStartY;
    rightDragMovedSq = totalDx * totalDx + totalDy * totalDy;
    if (rightDragMovedSq >= RIGHT_TAP_THRESHOLD_SQ) {
      targetYaw   -= dx * 0.005;
      targetPitch = THREE.MathUtils.clamp(targetPitch - dy * 0.005, PITCH_MIN, PITCH_MAX);
    }
  }
  lastX = e.clientX; lastY = e.clientY;
});
// Suppress the browser context menu over the canvas in build mode so right-
// click can be used for orbit / remove. (Explore mode leaves it alone.)
canvas.addEventListener('contextmenu', (e) => {
  if (gameMode === 'build') e.preventDefault();
});

const CAM_DIST_MIN = 2.5;
const CAM_DIST_MAX = 25;
let camDist = 7, targetCamDist = camDist;
addEventListener('wheel', (e) => {
  // macOS trackpad pinch arrives as a wheel event with ctrlKey=true.
  if (e.ctrlKey) {
    targetCamDist = THREE.MathUtils.clamp(targetCamDist + e.deltaY * 0.05, CAM_DIST_MIN, CAM_DIST_MAX);
  } else {
    targetYaw   -= e.deltaX * 0.003;
    targetPitch = THREE.MathUtils.clamp(targetPitch - e.deltaY * 0.003, PITCH_MIN, PITCH_MAX);
  }
  e.preventDefault();
}, { passive: false });

const SPEED = 10;   // mid-point between the old 6 (too slow) and 14 (too easy to overshoot)
const ROT_SPEED = 14;
const CAM_HEIGHT = 1.8;

// === Tree climbing ===
const CLIMB_RANGE_BUFFER = 1.5;  // extra distance beyond trunk radius where spacebar is accepted
const CLIMB_DURATION     = 1.2;
let climbState  = 'normal';  // 'normal' | 'up' | 'top' | 'down'
let climbT      = 0;
let prevSpace   = false;
const climbStart  = new THREE.Vector3();
const climbTarget = new THREE.Vector3();

// === Day / Night toggle ===
// Captures all of the day-time look so we can swap between them. Anything that should
// look different at night flips here; per-frame updates further down only run for the
// active mode (e.g. fireflies don't wander while it's day).
let isNight = false;
let lightOn = true;
const buttonStyle = `
  position: fixed; right: 12px;
  padding: 8px 14px;
  font: 14px/1 -apple-system, system-ui, sans-serif;
  background: rgba(0,0,0,0.45);
  color: #fff;
  border: 1px solid rgba(255,255,255,0.25);
  border-radius: 6px;
  cursor: pointer;
  user-select: none;
`;
const toggleBtn = document.createElement('button');
toggleBtn.textContent = 'Night';
toggleBtn.style.cssText = buttonStyle + 'top: 12px;';
document.body.appendChild(toggleBtn);

const lightBtn = document.createElement('button');
lightBtn.textContent = 'Light: On';
lightBtn.style.cssText = buttonStyle + 'top: 52px;';
document.body.appendChild(lightBtn);

// Home button: teleports the duck back to the island center. Useful on the bigger
// map when you wander off the coast into the open ocean.
const homeBtn = document.createElement('button');
homeBtn.textContent = '🏠 Home';
homeBtn.style.cssText = buttonStyle + 'top: 92px;';
document.body.appendChild(homeBtn);
function goHome() {
  // Cancel any in-progress tree climb so the duck doesn't snap mid-animation.
  climbState = 'normal';
  climbT = 0;
  const x = 0, z = 0;
  player.position.set(x, getWalkableY(x, z), z);
}
homeBtn.addEventListener('click', goHome);
addEventListener('keydown', (e) => {
  if (e.code === 'KeyH') goHome();
});

// === Mode HUD label (top-right of the screen) + setMode(newMode) ===
const modeHud = document.createElement('div');
modeHud.id = 'modeHud';
modeHud.style.cssText = `
  position: fixed; top: 12px; right: 130px;
  font: 13px/1.4 -apple-system, system-ui, sans-serif;
  color: #fff;
  background: rgba(0,0,0,0.45);
  border: 1px solid rgba(255,255,255,0.22);
  border-radius: 6px;
  padding: 6px 10px;
  pointer-events: none;
  user-select: none;
`;
document.body.appendChild(modeHud);
function _updateModeHud() {
  modeHud.textContent = gameMode === 'build' ? '🔨 Build' : '🌳 Explore';
}
_updateModeHud();

function setMode(newMode) {
  if (newMode === gameMode) return;
  if (newMode !== 'explore' && newMode !== 'build') return;
  gameMode = newMode;
  const decoMenu = document.getElementById('buildMenu');
  const layerHud = document.getElementById('layerHud');
  if (gameMode === 'build') {
    // Use explicit values, not '': the stylesheet's `display:none` would win
    // over an empty inline style.
    if (decoMenu) decoMenu.style.display = 'flex';
    if (layerHud) layerHud.style.display = 'block';
    // Remember the duck's home spot — anchor for the grid, camera, and the
    // step-back lerp on exit.
    _buildHomePos.copy(player.position);
    // Position the grid at the home spot, snapped to cell boundaries so the
    // lines align with where logs will actually land.
    const gridX = Math.round(_buildHomePos.x / GRID_X) * GRID_X;
    const gridZ = Math.round(_buildHomePos.z / GRID_Z) * GRID_Z;
    const gridY = (typeof getTerrainHeight === 'function'
      ? getTerrainHeight(_buildHomePos.x, _buildHomePos.z)
      : 0) + 0.01;
    buildGrid.position.set(gridX, gridY, gridZ);
    buildGrid.visible = true;
    // Anchor "Layer 0" to the duck's terrain at this XZ so layer-0 placements
    // sit on the ground here instead of being buried at absolute Y=0.
    if (typeof getTerrainHeight === 'function') {
      _buildLayerOrigin = Math.round(getTerrainHeight(_buildHomePos.x, _buildHomePos.z) / GRID_Y);
    }
    buildHeight  = 0;
    manualHeight = false;
    if (typeof _refreshLayerHud === 'function') _refreshLayerHud();
    if (typeof _refreshPaletteState === 'function') _refreshPaletteState();
    // Start the duck step-aside lerp: 2m to the duck's world-right.
    const yaw = player.rotation.y - MODEL_FACING_OFFSET;
    // Forward = (sin(yaw), 0, cos(yaw)); right (90° CW around Y) = (cos(yaw), 0, -sin(yaw)).
    const rx =  Math.cos(yaw);
    const rz = -Math.sin(yaw);
    _duckLerpStart.copy(player.position);
    _duckLerpTarget.set(
      _buildHomePos.x + rx * DUCK_STEP_ASIDE,
      _buildHomePos.y,
      _buildHomePos.z + rz * DUCK_STEP_ASIDE,
    );
    _duckLerpT = 0;
    _duckLerpState = 'aside';
    // Bump pitch +15° so the camera looks down at the grid; save the explore
    // pitch so we can restore it on exit (build orbit is allowed to change pitch
    // in-session via right-drag, but the explore pitch shouldn't pick that up).
    _exploreLastPitch = targetPitch;
    targetPitch = THREE.MathUtils.clamp(targetPitch + Math.PI / 12, PITCH_MIN, PITCH_MAX);
  } else {
    // Exiting build: drop any selected part / ghost, also clear any in-flight
    // right-drag tracking so the next explore-mode right-click doesn't get
    // misinterpreted as a tap.
    if (typeof setSelectedPart === 'function') setSelectedPart(null);
    if (typeof _setHoveredPart === 'function') _setHoveredPart(null);
    rightDragging = false;
    if (decoMenu) decoMenu.style.display = 'none';
    if (layerHud) layerHud.style.display = 'none';
    buildGrid.visible = false;
    buildCursorMesh.visible = false;
    // Start the duck step-back lerp from wherever the duck currently is.
    _duckLerpStart.copy(player.position);
    _duckLerpTarget.copy(_buildHomePos);
    _duckLerpT = 0;
    _duckLerpState = 'home';
    // Restore the saved explore pitch and snap yaw to behind the duck. Both
    // settle smoothly via camLerp.
    targetPitch = _exploreLastPitch;
    targetYaw   = player.rotation.y - MODEL_FACING_OFFSET + Math.PI;
  }
  _updateModeHud();
}

addEventListener('keydown', (e) => {
  if (e.code === 'KeyB') {
    setMode(gameMode === 'build' ? 'explore' : 'build');
  } else if (e.code === 'Escape' && gameMode === 'build') {
    // Esc has two behaviours: first press deselects the current part; with
    // nothing selected, it exits build mode entirely.
    if (selectedPartId !== null) setSelectedPart(null);
    else setMode('explore');
  }
});

function applyLight() {
  const on = isNight && lightOn;
  duckGlow.intensity   = on ? 6.0 : 0.0;
  duckHalo.visible     = on;
  lightBtn.textContent = lightOn ? 'Light: On' : 'Light: Off';
}
lightBtn.addEventListener('click', () => { lightOn = !lightOn; applyLight(); });
addEventListener('keydown', (e) => {
  if (e.code === 'KeyL') { lightOn = !lightOn; applyLight(); }
});


function applyDayNight() {
  if (isNight) {
    scene.background.set(0x07091a);
    scene.fog.color.set(0x0a0e22);
    scene.fog.near = 90;
    scene.fog.far  = 290;
    hemi.color.set(0x2a3a66);
    hemi.groundColor.set(0x101830);
    hemi.intensity = 0.35;
    sun.color.set(0x9fb6e6);  // moonlight tint
    sun.intensity = 0.6;
    renderer.toneMappingExposure = 0.78;
    grassMaterial.uniforms.uColorMult.value = 0.32;  // dim the saturated grass tips
    stars.visible = true;
    fireflies.visible = true;
    butterflies.visible = false;  // butterflies sleep at night
    clouds.visible = false;       // day clouds look weird against the dark sky
    sea.material.color.setHex(0x0d2d44);  // dark moonlit sea
  } else {
    scene.background.set(0x87ceeb);
    scene.fog.color.set(0xb8d8ee);
    scene.fog.near = 160;
    scene.fog.far  = 460;
    hemi.color.set(0xbcdfff);
    hemi.groundColor.set(0x4a5530);
    hemi.intensity = 1.1;
    sun.color.set(0xfff2cc);
    sun.intensity = 3.2;
    renderer.toneMappingExposure = 1.15;
    grassMaterial.uniforms.uColorMult.value = 1.0;
    stars.visible = false;
    fireflies.visible = false;
    butterflies.visible = true;
    clouds.visible = true;
    sea.material.color.setHex(0x2a6e93);
  }
  toggleBtn.textContent = isNight ? 'Day' : 'Night';
  applyLight();  // light is only on when night && user-toggle on
}
toggleBtn.addEventListener('click', () => { isNight = !isNight; applyDayNight(); });
addEventListener('keydown', (e) => {
  if (e.code === 'KeyN') { isNight = !isNight; applyDayNight(); }
});

// =====================================================================
// === Build mode v1: 2-part PARTS, non-cubic grid, mouse-driven placement
// =====================================================================
// GRID CONVENTIONS
//   - Grid cells are non-cubic: 1m (X) × 0.25m (Y) × 0.25m (Z). This matches
//     the "log length" (1m) along X and a fine 0.25m grain in Y and Z.
//   - World pos of cell (gx, gy, gz) CENTER = (gx * 1.0, gy * 0.25, gz * 0.25).
//   - Logs are always horizontal. rot=0 = log's length runs along world X.
//     rot=1 = rotated 90° around Y, length runs along world Z.
//   - rot=0 Log occupies 1 cell at (gx, gy, gz) (X-cell is 1m, log is 1m).
//     rot=1 Log occupies 4 cells (gx, gy, gz..gz+3) (Z-cells are 0.25m × 4 = 1m).
//   - A half log (0.5m): rot=0 occupies 1 X-cell (rounded up); rot=1 occupies
//     2 Z-cells. Two adjacent half logs along X waste half a cell each by design.
// COSTS
//   - Log = 1 log resource. Half log = 0.5. Half-log accounting uses
//     `inventory.halfLogCredit` so the math stays integer (first half spends
//     a log and banks the other half; second half consumes the credit).
// CAVEAT
//   - "Layer 0" places the part at absolute world Y=0 (per the prompt). On
//     the island's hilly terrain that can bury layer-0 parts; raise the
//     layer with E to build above the grass.

const PARTS = [
  { id: 0, name: "Log",      emoji: "🪵", size: { x: 1.0, y: 0.25, z: 0.25 }, cost: 1,   isHalf: false },
  { id: 1, name: "Half log", emoji: "🪵", size: { x: 0.5, y: 0.25, z: 0.25 }, cost: 0.5, isHalf: true  },
];
const PART_STORAGE_KEY = 'duckIsland_placed_v1';
// GRID_X / GRID_Y / GRID_Z are declared near the top of the file (the grid
// mesh needs them at construction time).

// Build state
let selectedPartId = null;        // null or 0..1
let buildRot       = 0;           // 0 = log along X, 1 = log along Z
let buildHeight    = 0;           // UI layer offset above the duck's terrain (0..40)
let manualHeight   = false;       // true after Q/E; disables auto-snap-to-top until reselect

// `_buildLayerOrigin` shifts the grid up so "Layer 0" = the duck's terrain
// height at build-mode entry, instead of absolute world Y=0 (which buries
// parts on the hilly island). Absolute gy of any placed cell =
//   _buildLayerOrigin + buildHeight (or whatever auto-snap resolved to).
let _buildLayerOrigin = 0;

// Mouse-cursor → grid state (refreshed every frame in build mode).
let cursorGX = 0;
let cursorGY = 0;
let cursorGZ = 0;
let cursorValid = false;

const placedParts   = [];               // { type, gx, gy, gz, rot, mesh }
const occupancyMap  = new Map();        // "gx,gy,gz" -> placed-part ref
const _placedMeshes = [];               // mirror, for raycast intersect

let ghost = null;
let ghostMaterial = null;
let hoveredPart   = null;

// --- Shared geometry per (partId, rot) so we don't allocate per mesh ---
const _sharedGeoms = new Map();
function _geomKey(partId, rot) { return partId * 2 + rot; }
// Full logs render 0.125m longer at each end of their long axis (1m → 1.25m)
// so a perpendicular log at the adjacent cell tucks into the corner instead
// of leaving a 0.375m gap. Same-axis adjacent logs overlap by 0.25m at the
// junction — reads as a natural log-cabin joint. Occupancy is unchanged (still
// 1m worth of cells). Half logs are NOT extended: their 0.5m length already
// fits inside one X cell, and extending them would visibly cross cell bounds.
function _partLongLength(p) {
  return p.isHalf ? p.size.x : p.size.x + 0.25;
}
function _getGeom(partId, rot) {
  const k = _geomKey(partId, rot);
  let g = _sharedGeoms.get(k);
  if (g) return g;
  const p = PARTS[partId];
  // Bake rotation into the geometry: swap X and Z when rot=1 so we never have
  // to also call mesh.rotation.y on the placed mesh.
  const len = _partLongLength(p);
  const sx = rot === 0 ? len       : p.size.z;
  const sz = rot === 0 ? p.size.z  : len;
  g = new THREE.BoxGeometry(sx, p.size.y, sz);
  _sharedGeoms.set(k, g);
  return g;
}
function createLogMesh(partId, rot) {
  const mat = new THREE.MeshStandardMaterial({
    color: 0x8B6F47,    // warm wood-brown for both parts
    roughness: 0.82,
    metalness: 0.0,
  });
  const mesh = new THREE.Mesh(_getGeom(partId, rot), mat);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}

// --- Occupancy ---
function _cellKey(gx, gy, gz) { return `${gx},${gy},${gz}`; }
function getOccupiedCells(partId, gx, gy, gz, rot) {
  const p = PARTS[partId];
  const cells = [];
  if (rot === 0) {
    cells.push([gx, gy, gz]);
  } else {
    // rot=1: log runs along Z. Full log spans 4 Z-cells, half log spans 2.
    const n = p.isHalf ? 2 : 4;
    for (let i = 0; i < n; i++) cells.push([gx, gy, gz + i]);
  }
  return cells;
}
function _markOccupied(part) {
  for (const [cx, cy, cz] of getOccupiedCells(part.type, part.gx, part.gy, part.gz, part.rot)) {
    occupancyMap.set(_cellKey(cx, cy, cz), part);
  }
}
function _unmarkOccupied(part) {
  for (const [cx, cy, cz] of getOccupiedCells(part.type, part.gx, part.gy, part.gz, part.rot)) {
    const k = _cellKey(cx, cy, cz);
    if (occupancyMap.get(k) === part) occupancyMap.delete(k);
  }
}
function _isPlaceable(partId, gx, gy, gz, rot) {
  for (const [cx, cy, cz] of getOccupiedCells(partId, gx, gy, gz, rot)) {
    if (occupancyMap.has(_cellKey(cx, cy, cz))) return false;
  }
  return true;
}
function _highestOccupiedGY(gx, gz) {
  let best = -1;
  for (const obj of placedParts) {
    for (const [cx, cy, cz] of getOccupiedCells(obj.type, obj.gx, obj.gy, obj.gz, obj.rot)) {
      if (cx === gx && cz === gz && cy > best) best = cy;
    }
  }
  return best;
}

// World CENTER of a part placed at (gx, gy, gz, rot). For multi-cell footprints
// (rot=1) the center sits at the midpoint of the spanned cells along Z.
function _partCenterWorld(partId, gx, gy, gz, rot) {
  const p = PARTS[partId];
  const wx = gx * GRID_X;
  let wz = gz * GRID_Z;
  if (rot === 1) {
    const n = p.isHalf ? 2 : 4;
    // first cell center is (gz * GRID_Z), last is ((gz + n - 1) * GRID_Z).
    // Midpoint = (gz + (n-1)/2) * GRID_Z.
    wz = (gz + (n - 1) * 0.5) * GRID_Z;
  }
  const wy = gy * GRID_Y + p.size.y * 0.5;  // bottom = gy*GRID_Y, center = bottom + size.y/2
  return { wx, wy, wz };
}

// --- Palette ---
const buildMenuEl = document.getElementById('buildMenu');
const partButtons = [];
function _canAfford(p) {
  // Half log: free if we have credit, else 1 log to bank the other half.
  if (p.isHalf) return inventory.halfLogCredit > 0 || inventory.logs >= 1;
  return inventory.logs >= p.cost;
}
function _buildPalette() {
  buildMenuEl.innerHTML = '';
  for (const p of PARTS) {
    const btn = document.createElement('div');
    btn.className = 'item';
    btn.dataset.partId = String(p.id);
    btn.innerHTML = `<span>${p.emoji}</span><span>${p.name}</span><span class="cost">· ${p.cost}</span>`;
    btn.addEventListener('click', () => {
      if (!_canAfford(p)) return;
      setSelectedPart(p.id === selectedPartId ? null : p.id);
    });
    buildMenuEl.appendChild(btn);
    partButtons.push(btn);
  }
  const cancel = document.createElement('div');
  cancel.className = 'cancel';
  cancel.textContent = '✕ Cancel';
  cancel.addEventListener('click', () => setSelectedPart(null));
  buildMenuEl.appendChild(cancel);
}
_buildPalette();
function _refreshPaletteState() {
  for (let i = 0; i < PARTS.length; i++) {
    partButtons[i].classList.toggle('selected', i === selectedPartId);
    partButtons[i].classList.toggle('disabled', !_canAfford(PARTS[i]));
  }
}
const layerHudEl = document.getElementById('layerHud');
function _refreshLayerHud() {
  if (layerHudEl) layerHudEl.textContent = `Layer: ${buildHeight}`;
}

// --- Selection ---
function setSelectedPart(id) {
  _setHoveredPart(null);
  selectedPartId = id;
  buildRot     = 0;
  manualHeight = false;
  if (ghost) { scene.remove(ghost); ghost = null; ghostMaterial = null; }
  if (id !== null) {
    const m = createLogMesh(id, buildRot);
    m.material = m.material.clone();
    m.material.transparent = true;
    m.material.opacity     = 0.55;
    m.material.depthWrite  = false;
    m.castShadow = false;
    m.receiveShadow = false;
    m.visible = false;  // hidden until first cursor update positions it
    scene.add(m);
    ghost = m;
    ghostMaterial = m.material;
  }
  _refreshPaletteState();
}

// --- Mouse raycast against the active layer's ground plane ---
const _raycaster  = new THREE.Raycaster();
const _mouseNDC   = new THREE.Vector2();
const _layerPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
const _hitPoint   = new THREE.Vector3();

function updateBuildCursor() {
  if (gameMode !== 'build') return;
  _raycaster.setFromCamera(_mouseNDC, camera);
  // Layer plane sits at world Y = (_buildLayerOrigin + buildHeight) * 0.25,
  // i.e. layer 0 == the duck's local ground at build-mode entry. Plane equation
  // y = h ⇒ constant = -h (since plane is n·p + d = 0 with n = (0,1,0)).
  const layerY = (_buildLayerOrigin + buildHeight) * GRID_Y;
  _layerPlane.constant = -layerY;
  const hit = _raycaster.ray.intersectPlane(_layerPlane, _hitPoint);
  cursorValid = !!hit;
  if (!hit) {
    if (ghost) ghost.visible = false;
    buildCursorMesh.visible = false;
    return;
  }
  cursorGX = Math.round(_hitPoint.x / GRID_X);
  cursorGZ = Math.round(_hitPoint.z / GRID_Z);
  cursorGY = _buildLayerOrigin + buildHeight;        // absolute gy in world space
  // Auto-snap-to-top: if any cell at this column is occupied AND user hasn't
  // overridden via Q/E, place on top of the highest occupied cell.
  if (!manualHeight) {
    const top = _highestOccupiedGY(cursorGX, cursorGZ);
    if (top >= 0) cursorGY = top + 1;
  }

  // Ghost
  if (ghost && selectedPartId !== null) {
    // Swap geometry if rotation changed since last frame.
    const want = _getGeom(selectedPartId, buildRot);
    if (ghost.geometry !== want) ghost.geometry = want;
    const { wx, wy, wz } = _partCenterWorld(selectedPartId, cursorGX, cursorGY, cursorGZ, buildRot);
    ghost.position.set(wx, wy, wz);
    ghost.visible = true;
    const placeable  = _isPlaceable(selectedPartId, cursorGX, cursorGY, cursorGZ, buildRot);
    const affordable = _canAfford(PARTS[selectedPartId]);
    ghostMaterial.color.setHex((placeable && affordable) ? 0x6cd25b : 0xff5050);
  }

  // Cursor outline rectangle — three modes (in priority order):
  //   1. Hovering a placed log → outline the LOG's footprint in red (right-
  //      click to remove). Overrides everything else.
  //   2. A part is selected → outline the PLACEMENT cell, sized to the part's
  //      footprint, green if placeable+affordable else red.
  //   3. Otherwise → outline the default 1m × 0.25m cell in soft cream.
  // The snap math (Math.round(x / GRID_X), Math.round(z / GRID_Z)) matches the
  // grid lines drawn at integer X and 0.25m-multiple Z, so the outline always
  // sits exactly inside a visible cell.
  buildCursorMesh.visible = true;
  if (hoveredPart) {
    const hp = PARTS[hoveredPart.type];
    // Outline matches the rendered log (full logs extend 0.125m past each end).
    const hLen = _partLongLength(hp);
    const fx = hoveredPart.rot === 0 ? hLen      : hp.size.z;
    const fz = hoveredPart.rot === 0 ? hp.size.z : hLen;
    const c = _partCenterWorld(hoveredPart.type, hoveredPart.gx, hoveredPart.gy, hoveredPart.gz, hoveredPart.rot);
    // Lay the outline on top of the placed log's TOP face so it reads as
    // "this whole part" even when stacked.
    const topY = c.wy + hp.size.y * 0.5 + 0.005;
    buildCursorMesh.position.set(c.wx, topY, c.wz);
    buildCursorMesh.scale.set(fx, 1, fz);
    buildCursorMesh.material.color.setHex(0xff4d4d);
  } else if (selectedPartId !== null) {
    const p = PARTS[selectedPartId];
    const sLen = _partLongLength(p);
    const fx = buildRot === 0 ? sLen      : p.size.z;
    const fz = buildRot === 0 ? p.size.z  : sLen;
    const c = _partCenterWorld(selectedPartId, cursorGX, cursorGY, cursorGZ, buildRot);
    buildCursorMesh.position.set(c.wx, cursorGY * GRID_Y + 0.005, c.wz);
    buildCursorMesh.scale.set(fx, 1, fz);
    const placeable  = _isPlaceable(selectedPartId, cursorGX, cursorGY, cursorGZ, buildRot);
    const affordable = _canAfford(p);
    buildCursorMesh.material.color.setHex((placeable && affordable) ? 0x65d168 : 0xff4d4d);
  } else {
    buildCursorMesh.position.set(cursorGX * GRID_X, cursorGY * GRID_Y + 0.005, cursorGZ * GRID_Z);
    buildCursorMesh.scale.set(GRID_X, 1, GRID_Z);
    buildCursorMesh.material.color.setHex(0xffe680);
  }
}

// --- Hover on placed parts (raycast against actual placed meshes) ---
function _setHoveredPart(p) {
  if (p === hoveredPart) return;
  if (hoveredPart) hoveredPart.mesh.material.emissive.setHex(0x000000);
  hoveredPart = p;
  if (hoveredPart) hoveredPart.mesh.material.emissive.setHex(0x665522);
}
function updateHoverHighlight() {
  if (gameMode !== 'build') { _setHoveredPart(null); return; }
  if (_placedMeshes.length === 0) { _setHoveredPart(null); return; }
  _raycaster.setFromCamera(_mouseNDC, camera);
  const hits = _raycaster.intersectObjects(_placedMeshes, false);
  if (hits.length === 0) { _setHoveredPart(null); return; }
  const m = hits[0].object;
  _setHoveredPart(placedParts.find(o => o.mesh === m) || null);
}

// --- Place / remove ---
function placeSelectedPart() {
  if (selectedPartId === null || !cursorValid) return;
  const p = PARTS[selectedPartId];
  if (!_canAfford(p)) return;
  if (!_isPlaceable(selectedPartId, cursorGX, cursorGY, cursorGZ, buildRot)) return;

  if (p.isHalf) {
    // Spend credit if we have any, else spend 1 log and bank the other half.
    if (inventory.halfLogCredit > 0) inventory.halfLogCredit -= 1;
    else { inventory.logs -= 1; inventory.halfLogCredit = 1; }
  } else {
    inventory.logs -= p.cost;
  }
  saveInventory(); updateInvHud();

  const mesh = createLogMesh(selectedPartId, buildRot);
  const { wx, wy, wz } = _partCenterWorld(selectedPartId, cursorGX, cursorGY, cursorGZ, buildRot);
  mesh.position.set(wx, wy, wz);
  scene.add(mesh);
  const part = {
    type: selectedPartId,
    gx: cursorGX, gy: cursorGY, gz: cursorGZ,
    rot: buildRot,
    mesh,
  };
  placedParts.push(part);
  _placedMeshes.push(mesh);
  _markOccupied(part);
  _refreshPaletteState();
  savePlacedParts();
}
function removeHoveredPart() {
  if (!hoveredPart) return;
  const idx = placedParts.indexOf(hoveredPart);
  if (idx < 0) return;
  _unmarkOccupied(hoveredPart);
  scene.remove(hoveredPart.mesh);
  // Geometry is shared via _sharedGeoms — only dispose the per-mesh material.
  hoveredPart.mesh.material.dispose();
  const mi = _placedMeshes.indexOf(hoveredPart.mesh);
  if (mi >= 0) _placedMeshes.splice(mi, 1);
  placedParts.splice(idx, 1);
  _setHoveredPart(null);
  savePlacedParts();
}

// --- Persistence ---
function savePlacedParts() {
  const data = placedParts.map(o => ({ type: o.type, gx: o.gx, gy: o.gy, gz: o.gz, rot: o.rot }));
  try { localStorage.setItem(PART_STORAGE_KEY, JSON.stringify(data)); } catch (e) {}
}
function hydratePlacedParts() {
  let raw;
  try { raw = localStorage.getItem(PART_STORAGE_KEY); } catch (e) { return; }
  if (!raw) return;
  let arr;
  try { arr = JSON.parse(raw); } catch (e) { return; }
  if (!Array.isArray(arr)) return;
  for (const e of arr) {
    // Only the new grid-coord shape is supported. Entries written by earlier
    // prompts under the same key (world-coord {x,y,z}) are silently dropped.
    if (typeof e.type !== 'number' || !PARTS[e.type]) continue;
    if (typeof e.gx !== 'number' || typeof e.gy !== 'number' || typeof e.gz !== 'number') continue;
    const rot = (e.rot | 0) % 2;
    const mesh = createLogMesh(e.type, rot);
    const { wx, wy, wz } = _partCenterWorld(e.type, e.gx, e.gy, e.gz, rot);
    mesh.position.set(wx, wy, wz);
    scene.add(mesh);
    const part = { type: e.type, gx: e.gx, gy: e.gy, gz: e.gz, rot, mesh };
    placedParts.push(part);
    _placedMeshes.push(mesh);
    _markOccupied(part);
  }
}
hydratePlacedParts();
_refreshLayerHud();
if (typeof inventory !== 'undefined') _refreshPaletteState();

// Always track the mouse in NDC — the raycast pulls from this every frame in
// build mode. (Cheap; doesn't matter in explore mode.)
addEventListener('mousemove', (e) => {
  _mouseNDC.x =  (e.clientX / window.innerWidth)  * 2 - 1;
  _mouseNDC.y = -(e.clientY / window.innerHeight) * 2 + 1;
});

// --- Keys: 1/2 select, R rotate 0↔1, Q/E layer ---
addEventListener('keydown', (e) => {
  if (gameMode !== 'build') return;
  if (e.repeat) return;
  switch (e.code) {
    case 'Digit1': case 'Digit2': {
      const idx = parseInt(e.code.slice(5), 10) - 1;
      const p = PARTS[idx];
      if (!p) return;
      if (!_canAfford(p)) return;
      setSelectedPart(idx === selectedPartId ? null : idx);
      break;
    }
    case 'KeyR':
      if (selectedPartId !== null) buildRot = buildRot === 0 ? 1 : 0;
      break;
    case 'KeyQ':
      buildHeight = Math.max(0, buildHeight - 1);
      manualHeight = true;
      _refreshLayerHud();
      break;
    case 'KeyE':
      buildHeight = Math.min(40, buildHeight + 1);
      manualHeight = true;
      _refreshLayerHud();
      break;
  }
});

// =====================================================================
// === Tree economy: chop / plant / growth + persistence + day hook
// =====================================================================
const CHOP_RANGE  = 2.0;
const PLANT_RANGE = 2.0;
const _zeroScaleMat = new THREE.Matrix4().makeScale(0.0001, 0.0001, 0.0001);

function _hideWorldTree(t) {
  if (t.origin === 'world') {
    for (const im of variantInstancedMeshes[t.variantIdx] || []) {
      im.setMatrixAt(t.instanceIdx, _zeroScaleMat);
      im.instanceMatrix.needsUpdate = true;
    }
  } else if (t.origin === 'world-palm') {
    if (palmTrunkIM)  { palmTrunkIM.setMatrixAt(t.instanceIdx, _zeroScaleMat);  palmTrunkIM.instanceMatrix.needsUpdate = true; }
    if (palmFrondsIM) { palmFrondsIM.setMatrixAt(t.instanceIdx, _zeroScaleMat); palmFrondsIM.instanceMatrix.needsUpdate = true; }
  }
}

// Visual factories for planted trees — chunky primitives, matching the build-mode
// tree placeholder so the styles read as consistent on the island.
function _makePlantedSaplingMesh() {
  return new THREE.Mesh(
    new THREE.ConeGeometry(0.16, 0.5, 6),
    new THREE.MeshLambertMaterial({ color: 0x4ea53a, flatShading: true }),
  );
}
function _makePlantedGrownMesh() {
  const g = new THREE.Group();
  const trunk = new THREE.Mesh(
    new THREE.CylinderGeometry(0.18, 0.22, 1.1, 6),
    new THREE.MeshLambertMaterial({ color: 0x6b4623 }),
  );
  trunk.position.y = 0.55;
  g.add(trunk);
  const cone = new THREE.Mesh(
    new THREE.ConeGeometry(0.95, 2.0, 8),
    new THREE.MeshLambertMaterial({ color: 0x4ea53a, flatShading: true }),
  );
  cone.position.y = 2.0;
  g.add(cone);
  return g;
}

function tryChopNearestTree(px, pz) {
  let bestIdx = -1, bestD2 = CHOP_RANGE * CHOP_RANGE;
  for (let i = 0; i < trees.length; i++) {
    const t = trees[i];
    if (!t.isFullyGrown) continue;  // saplings aren't choppable
    const dx = t.position.x - px, dz = t.position.z - pz;
    const d2 = dx*dx + dz*dz;
    if (d2 < bestD2) { bestD2 = d2; bestIdx = i; }
  }
  if (bestIdx < 0) return false;
  const t = trees[bestIdx];
  if (t.origin === 'planted') {
    scene.remove(t.mesh);
  } else {
    _hideWorldTree(t);
  }
  // Invalidate the climb + collision collider. Using NaN so every comparison
  // against it (`d < r + buf` for climb, `d2 < r*r` for movement collision)
  // evaluates false — chopped trees are skipped by both loops cleanly.
  if (treeColliders[t.colliderIdx]) treeColliders[t.colliderIdx].r = NaN;
  trees.splice(bestIdx, 1);
  inventory.logs    += 3;
  inventory.saplings += 1;
  saveInventory();
  updateInvHud();
  saveTreesState();
  console.log("Chopped tree! +3 logs +1 sapling");
  return true;
}

function plantSapling() {
  if (inventory.saplings < 1) { console.log("No saplings"); return; }
  const px = player.position.x;
  const pz = player.position.z;
  for (const t of trees) {
    const dx = t.position.x - px, dz = t.position.z - pz;
    if (dx*dx + dz*dz < PLANT_RANGE * PLANT_RANGE) { console.log("Too close to another tree"); return; }
  }
  const y = getTerrainHeight(px, pz);
  if (y < SEA_WATER_Y + 0.3) { console.log("Too close to another tree"); return; }  // basically: can't plant in water
  const mesh = _makePlantedSaplingMesh();
  mesh.position.set(px, y + 0.25, pz);  // base of cone sits on terrain
  mesh.rotation.y = Math.random() * Math.PI * 2;
  scene.add(mesh);
  const colliderIdx = treeColliders.length;
  treeColliders.push({ x: px, z: pz, r: 0.3 + DUCK_RADIUS, top: y + 0.5 });
  trees.push({
    origin: 'planted',
    position: { x: px, y, z: pz },
    plantedAtDay: currentDay,
    isFullyGrown: false, stage: 'sapling',
    mesh, colliderIdx,
  });
  inventory.saplings -= 1;
  saveInventory();
  updateInvHud();
  saveTreesState();
}

function advanceTreeGrowth() {
  for (const t of trees) {
    if (t.isFullyGrown) continue;
    if (currentDay < t.plantedAtDay + 1) continue;
    // Sapling → grown
    if (t.origin === 'planted' && t.mesh) {
      const pos = t.mesh.position.clone();
      const rotY = t.mesh.rotation.y;
      scene.remove(t.mesh);
      const grown = _makePlantedGrownMesh();
      grown.position.set(pos.x, t.position.y, pos.z);   // grown trunk sits at terrain y
      grown.rotation.y = rotY;
      scene.add(grown);
      t.mesh = grown;
      if (treeColliders[t.colliderIdx]) {
        treeColliders[t.colliderIdx].r   = 0.5 + DUCK_RADIUS;
        treeColliders[t.colliderIdx].top = t.position.y + 3.0;
      }
    }
    t.isFullyGrown = true;
    t.stage = 'grown';
  }
}

function maybeSpawnWildSapling() {
  daysSinceWildSpawn++;
  if (daysSinceWildSpawn < 2) return;
  if (trees.length !== 0 || inventory.saplings !== 0) return;
  for (let i = 0; i < 40; i++) {
    const a = Math.random() * Math.PI * 2;
    const r = Math.sqrt(Math.random()) * (ISLAND_RADIUS - 30);
    const x = Math.cos(a) * r;
    const z = Math.sin(a) * r;
    const y = getTerrainHeight(x, z);
    if (y < SEA_WATER_Y + 0.5) continue;
    const mesh = _makePlantedSaplingMesh();
    mesh.position.set(x, y + 0.25, z);
    mesh.rotation.y = Math.random() * Math.PI * 2;
    scene.add(mesh);
    const colliderIdx = treeColliders.length;
    treeColliders.push({ x, z, r: 0.3 + DUCK_RADIUS, top: y + 0.5 });
    trees.push({
      origin: 'planted',
      position: { x, y, z },
      plantedAtDay: currentDay,
      isFullyGrown: false, stage: 'sapling',
      mesh, colliderIdx,
    });
    daysSinceWildSpawn = 0;
    saveTreesState();
    console.log("A wild sapling appeared.");
    return;
  }
}

function saveTreesState() {
  const planted = trees.filter(t => t.origin === 'planted').map(t => ({
    x: t.position.x, z: t.position.z,
    plantedAtDay: t.plantedAtDay,
    isFullyGrown: t.isFullyGrown,
    stage: t.stage,
  }));
  try {
    localStorage.setItem(TREES_STORAGE_KEY, JSON.stringify({
      currentDay, daysSinceWildSpawn, planted,
    }));
  } catch (e) {}
}
function loadTreesState() {
  let raw;
  try { raw = localStorage.getItem(TREES_STORAGE_KEY); } catch (e) { return; }
  if (!raw) return;
  let data; try { data = JSON.parse(raw); } catch (e) { return; }
  if (!data) return;
  if (typeof data.currentDay === 'number')         currentDay         = data.currentDay;
  if (typeof data.daysSinceWildSpawn === 'number') daysSinceWildSpawn = data.daysSinceWildSpawn;
  if (!Array.isArray(data.planted)) return;
  for (const e of data.planted) {
    const x = e.x, z = e.z;
    const y = getTerrainHeight(x, z);
    const mesh = e.isFullyGrown ? _makePlantedGrownMesh() : _makePlantedSaplingMesh();
    mesh.position.set(x, y + (e.isFullyGrown ? 0 : 0.25), z);
    scene.add(mesh);
    const colliderIdx = treeColliders.length;
    treeColliders.push({
      x, z,
      r: (e.isFullyGrown ? 0.5 : 0.3) + DUCK_RADIUS,
      top: y + (e.isFullyGrown ? 3.0 : 0.5),
    });
    trees.push({
      origin: 'planted',
      position: { x, y, z },
      plantedAtDay: e.plantedAtDay || 0,
      isFullyGrown: !!e.isFullyGrown,
      stage: e.isFullyGrown ? 'grown' : 'sapling',
      mesh, colliderIdx,
    });
  }
}
loadTreesState();

// Day-transition piggyback — additive listeners that fire AFTER the existing
// N/click handlers, so by the time onDayNightToggle runs, isNight has flipped.
let _prevIsNight = isNight;
function onDayNightToggle() {
  if (_prevIsNight && !isNight) {  // night → day
    currentDay++;
    advanceTreeGrowth();
    maybeSpawnWildSapling();
    saveTreesState();
  }
  _prevIsNight = isNight;
}
toggleBtn.addEventListener('click', onDayNightToggle);
addEventListener('keydown', (e) => {
  if (e.code === 'KeyN') onDayNightToggle();
  if (e.code === 'KeyP' && gameMode === 'explore') plantSapling();
});

// === Performance HUD (bottom-right) — debug only, no visible-feature change ===
const perfHud = document.createElement('div');
perfHud.style.cssText = `
  position: fixed; bottom: 12px; right: 12px;
  font: 12px/1.4 ui-monospace, Menlo, Consolas, monospace;
  background: rgba(0,0,0,0.55);
  color: #d6f5d6;
  padding: 8px 10px;
  border-radius: 6px;
  pointer-events: none;
  user-select: none;
  white-space: pre;
  min-width: 150px;
`;
document.body.appendChild(perfHud);

let _perfFrames = 0;
let _perfLastT  = performance.now();
function updatePerfHud() {
  _perfFrames++;
  const now = performance.now();
  const dt  = now - _perfLastT;
  if (dt < 250) return;                              // refresh ~4x/sec
  const fps = (_perfFrames * 1000 / dt) | 0;
  _perfFrames = 0;
  _perfLastT  = now;
  const r = renderer.info;
  perfHud.textContent =
    `FPS:        ${fps}\n` +
    `draw calls: ${r.render.calls}\n` +
    `triangles:  ${r.render.triangles.toLocaleString()}\n` +
    `textures:   ${r.memory.textures}`;
}

const clock = new THREE.Clock();

let totalElapsed = 0;
function animate() {
  const dt = Math.min(clock.getDelta(), 0.1);
  totalElapsed += dt;
  grassMaterial.uniforms.time.value = totalElapsed * 0.25;
  windUniform.value = totalElapsed;

  // Spacebar edge-trigger for climbing.
  const spaceDown    = !!keys['Space'];
  const spacePressed = spaceDown && !prevSpace;
  prevSpace = spaceDown;

  if (spacePressed && gameMode === 'explore') {
    // In explore mode: chop takes priority within range; otherwise try to climb
    // the nearest climbable tree. Placement only happens in build mode (Space
    // handled separately via a build-mode keydown listener below).
    if (climbState === 'normal' && tryChopNearestTree(player.position.x, player.position.z)) {
      // chopped a tree this frame — no climb
    } else if (climbState === 'normal') {
      // Find the closest climbable tree within range.
      let bestI = -1, bestD = Infinity;
      for (let i = 0; i < treeColliders.length; i++) {
        const t = treeColliders[i];
        const dx = t.x - player.position.x, dz = t.z - player.position.z;
        const d  = Math.sqrt(dx*dx + dz*dz);
        if (d < t.r + CLIMB_RANGE_BUFFER && d < bestD) { bestD = d; bestI = i; }
      }
      if (bestI >= 0) {
        const t = treeColliders[bestI];
        climbStart.copy(player.position);
        climbTarget.set(t.x, t.top + 0.2, t.z);
        climbT = 0;
        climbState = 'up';
      }
    } else if (climbState === 'top') {
      climbStart.copy(player.position);
      climbTarget.set(player.position.x, getTerrainHeight(player.position.x, player.position.z), player.position.z);
      climbT = 0;
      climbState = 'down';
    }
  }

  let mx = 0, mz = 0;
  // WASD moves the duck ONLY in explore mode and when no step-aside/step-home
  // lerp is in flight (the lerp drives the duck's position itself). The build
  // cursor is mouse-driven via updateBuildCursor(). Climbing also locks input.
  if (gameMode === 'explore' && climbState === 'normal' && _duckLerpState === null) {
    if (keys['KeyW'] || keys['ArrowUp'])    mz -= 1;
    if (keys['KeyS'] || keys['ArrowDown'])  mz += 1;
    if (keys['KeyA'] || keys['ArrowLeft'])  mx -= 1;
    if (keys['KeyD'] || keys['ArrowRight']) mx += 1;
  }
  const moving = mx || mz;

  if (moving) {
    const len = Math.hypot(mx, mz);
    mx /= len; mz /= len;
    const sin = Math.sin(cameraYaw), cos = Math.cos(cameraYaw);
    const wx =  mx * cos + mz * sin;
    const wz = -mx * sin + mz * cos;
    // Speed multiplier: full speed on dry land, much slower wading through water.
    // Without this the duck zooms straight off the beach when it crosses the
    // shoreline (e.g. after chopping a palm tree facing seaward).
    let speedMul = 1.0;
    {
      const peekX = player.position.x + wx * SPEED * dt * 0.5;
      const peekZ = player.position.z + wz * SPEED * dt * 0.5;
      if (getTerrainHeight(peekX, peekZ) < SEA_WATER_Y) speedMul = 0.25;
    }
    let nx = player.position.x + wx * SPEED * speedMul * dt;
    let nz = player.position.z + wz * SPEED * speedMul * dt;
    // Soft swim wall: don't let the duck leave the wading band into deep ocean.
    {
      const nr = Math.sqrt(nx*nx + nz*nz);
      if (nr > ISLAND_RADIUS + 6) {
        nx = player.position.x;
        nz = player.position.z;
      }
    }
    for (let i = 0; i < treeColliders.length; i++) {
      const t = treeColliders[i];
      const ddx = nx - t.x, ddz = nz - t.z;
      const d2 = ddx * ddx + ddz * ddz;
      if (d2 < t.r * t.r) {
        const d = Math.sqrt(d2) || 0.0001;
        nx = t.x + (ddx / d) * t.r;
        nz = t.z + (ddz / d) * t.r;
      }
    }
    player.position.x = nx;
    player.position.z = nz;

    const target = Math.atan2(wx, wz) + MODEL_FACING_OFFSET;
    let diff = target - player.rotation.y;
    while (diff >  Math.PI) diff -= 2 * Math.PI;
    while (diff < -Math.PI) diff += 2 * Math.PI;
    player.rotation.y += diff * Math.min(1, ROT_SPEED * dt);
  }

  // Duck step-aside / step-home lerp (B-enter / B-exit). Drives the duck's
  // XZ between the home spot and 2m to its world-right over DUCK_LERP_DURATION.
  // Runs only when no climb animation is active.
  if (_duckLerpState !== null && climbState === 'normal') {
    _duckLerpT += dt / DUCK_LERP_DURATION;
    const t = Math.min(1, _duckLerpT);
    const eased = 0.5 - 0.5 * Math.cos(t * Math.PI);  // ease in-out
    player.position.x = _duckLerpStart.x + (_duckLerpTarget.x - _duckLerpStart.x) * eased;
    player.position.z = _duckLerpStart.z + (_duckLerpTarget.z - _duckLerpStart.z) * eased;
    if (t >= 1) _duckLerpState = null;
  }

  if (climbState === 'normal') {
    player.position.y = getWalkableY(player.position.x, player.position.z);
  } else if (climbState === 'up' || climbState === 'down') {
    climbT += dt / CLIMB_DURATION;
    const tt = Math.min(1, climbT);
    const eased = 0.5 - 0.5 * Math.cos(tt * Math.PI);  // ease in-out
    player.position.lerpVectors(climbStart, climbTarget, eased);
    if (tt >= 1) climbState = (climbState === 'up') ? 'top' : 'normal';
  }
  // 'top' state: hold position at climbTarget, no terrain snap, no movement.

  sun.position.set(player.position.x + 50, player.position.y + 80, player.position.z + 30);
  sun.target.position.copy(player.position);
  sun.target.updateMatrixWorld();

  cloudMaterial.uniforms.uTime.value   = totalElapsed;
  cloudMaterial.uniforms.uDriftX.value = totalElapsed * 3.0;
  cloudMaterial.uniforms.uDriftZ.value = totalElapsed * 0.8;
  cloudMaterial.uniforms.uPlayerPos.value.copy(player.position);

  butterflyMaterial.uniforms.uTime.value = totalElapsed;
  if (!isNight) updateButterflies(dt, totalElapsed);
  updateFish(dt);
  updatePerfHud();

  // Stars + fireflies: keep time uniforms ticking so they don't pop when toggled on,
  // but skip the firefly wander update during the day (cheap, but no point doing it).
  starMaterial.uniforms.uTime.value    = totalElapsed;
  fireflyMaterial.uniforms.uTime.value = totalElapsed;
  if (isNight) {
    stars.position.copy(player.position);  // keep the star dome centered on the camera
    updateFireflies(dt, totalElapsed);
  }

  if (mixer) {
    mixer.update(dt);
    if (moving && moveActionName) setAction(moveActionName);
    else if (idleActionName)      setAction(idleActionName);
  } else {
    placeholder.position.y = 0.6 + (moving ? Math.sin(performance.now() * 0.018) * 0.08 : 0);
  }

  const camLerp = 1 - Math.pow(0.001, dt);
  cameraYaw   += (targetYaw     - cameraYaw)   * camLerp;
  cameraPitch += (targetPitch   - cameraPitch) * camLerp;
  camDist     += (targetCamDist - camDist)     * camLerp;

  // Camera orbit target: home spot in build mode (so it stays put while the
  // duck steps aside), duck position in explore. Lerped via the same camLerp
  // so transitions are smooth on B-enter / B-exit.
  const tgtX = (gameMode === 'build') ? _buildHomePos.x : player.position.x;
  const tgtY = (gameMode === 'build') ? _buildHomePos.y : player.position.y;
  const tgtZ = (gameMode === 'build') ? _buildHomePos.z : player.position.z;
  _cameraTarget.x += (tgtX - _cameraTarget.x) * camLerp;
  _cameraTarget.y += (tgtY - _cameraTarget.y) * camLerp;
  _cameraTarget.z += (tgtZ - _cameraTarget.z) * camLerp;

  const cosP = Math.cos(cameraPitch);
  camera.position.set(
    _cameraTarget.x + Math.sin(cameraYaw) * cosP * camDist,
    _cameraTarget.y + Math.sin(cameraPitch) * camDist + CAM_HEIGHT,
    _cameraTarget.z + Math.cos(cameraYaw) * cosP * camDist
  );
  camera.lookAt(_cameraTarget.x, _cameraTarget.y + 1, _cameraTarget.z);

  // === Build mode per-frame: mouse-raycast → cursor cell → ghost + hover.
  // The duck is frozen in build mode; the cursor + ghost are mouse-driven.
  // Hover-on-placed-log runs FIRST so updateBuildCursor can override the
  // outline to the placed log's footprint when applicable.
  if (gameMode === 'build') {
    updateHoverHighlight();
    updateBuildCursor();
  }

  renderer.render(scene, camera);
  requestAnimationFrame(animate);
}
animate();

addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});
