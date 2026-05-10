import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { MeshSurfaceSampler } from 'three/addons/math/MeshSurfaceSampler.js';
import { createNoise2D } from 'simplex-noise';
import { Tree } from '@dgreenheck/ez-tree';

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.15;
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x87ceeb);
scene.fog = new THREE.Fog(0xb8d8ee, 120, 320);

const camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.1, 500);

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
const BUTTERFLY_COUNT     = 25;
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
  const x = (Math.random() - 0.5) * 70;
  const z = (Math.random() - 0.5) * 70;
  const y = 9 + Math.random() * 2;  // start safely above tallest terrain (~7); they descend on first wander
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
  const tx = b.pos.x + (Math.random() - 0.5) * BUTTERFLY_WANDER_R;
  const tz = b.pos.z + (Math.random() - 0.5) * BUTTERFLY_WANDER_R;
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
const FIREFLY_COUNT = 450;
const FIREFLY_SPEED = 1.6;
const FIREFLY_WANDER_R = 6;
const fireflyState = [];
const ffPositions = new Float32Array(FIREFLY_COUNT * 3);
const ffPhases    = new Float32Array(FIREFLY_COUNT);
for (let i = 0; i < FIREFLY_COUNT; i++) {
  // Initial spawn: spread around the duck's spawn area, low-altitude. Will hop to
  // terrain-relative targets once getTerrainHeight is available (it isn't in this
  // section's lexical position, but the wander loop runs in animate()).
  const x = (Math.random() - 0.5) * 60;
  const z = (Math.random() - 0.5) * 60;
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
      const tx = f.pos.x + (Math.random() - 0.5) * FIREFLY_WANDER_R;
      const tz = f.pos.z + (Math.random() - 0.5) * FIREFLY_WANDER_R;
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
const TERRAIN_SIZE = 240;
const TERRAIN_SEGMENTS = 220;
const HEIGHT_SCALE = 7;

function getTerrainHeight(x, z) {
  const n = noise2D(x * 0.010, z * 0.010) * 0.8
          + noise2D(x * 0.035, z * 0.035) * 0.2;
  return n * HEIGHT_SCALE;
}

const terrainGeo = new THREE.PlaneGeometry(TERRAIN_SIZE, TERRAIN_SIZE, TERRAIN_SEGMENTS, TERRAIN_SEGMENTS);
terrainGeo.rotateX(-Math.PI / 2);
const pos = terrainGeo.attributes.position;
const colors = new Float32Array(pos.count * 3);
const grass = new THREE.Color(0x3f7825);  // darker so it blends with grass-blade roots
const rock  = new THREE.Color(0xb39563);
const tmp   = new THREE.Color();
for (let i = 0; i < pos.count; i++) {
  const x = pos.getX(i);
  const z = pos.getZ(i);
  const y = getTerrainHeight(x, z);
  pos.setY(i, y);
  const t = THREE.MathUtils.clamp((y + HEIGHT_SCALE * 0.3) / (HEIGHT_SCALE * 1.3), 0, 1);
  tmp.lerpColors(grass, rock, t);
  colors[i * 3] = tmp.r;
  colors[i * 3 + 1] = tmp.g;
  colors[i * 3 + 2] = tmp.b;
}
terrainGeo.computeVertexNormals();
terrainGeo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
const terrain = new THREE.Mesh(
  terrainGeo,
  new THREE.MeshStandardMaterial({ vertexColors: true })
);
terrain.receiveShadow = true;
scene.add(terrain);

// === Trees: ez-tree (procedural, runtime). Generate a few unique variants, instance the rest. ===
const TREE_COUNT    = 300;
const TREE_VARIANTS = 3;
const DUCK_RADIUS   = 0.35;
const treeColliders = [];  // populated below, consumed in animate()

const barkMaterial = new THREE.MeshLambertMaterial({ color: 0x6b3f1d });
const leafMaterial = new THREE.MeshLambertMaterial({
  color: 0x3a8a2c,
  side: THREE.DoubleSide,
  flatShading: true,
});

const treeVariants = [];
const variantTopY = [];  // tree-local max y per variant (for climbing)
for (let v = 0; v < TREE_VARIANTS; v++) {
  const t = new Tree();
  t.options.seed = v * 137 + 17;
  t.options.branch.levels = 2;
  t.options.branch.sections = { 0: 5, 1: 4, 2: 3, 3: 3 };
  t.options.branch.segments = { 0: 5, 1: 4, 2: 3, 3: 3 };
  t.options.leaves.count = 2;
  t.options.leaves.size  = 1.4;
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
    subs.push({ geometry: g, material: isLeaf ? leafMaterial : barkMaterial });
  });
  treeVariants.push(subs);
  variantTopY.push(topY);
}

const variantTransforms = treeVariants.map(() => []);
{
  const up = new THREE.Vector3(0, 1, 0);
  const q  = new THREE.Quaternion();
  let placed = 0;
  for (let i = 0; i < TREE_COUNT * 2 && placed < TREE_COUNT; i++) {
    const x = (Math.random() - 0.5) * (TERRAIN_SIZE - 20);
    const z = (Math.random() - 0.5) * (TERRAIN_SIZE - 20);
    const y = getTerrainHeight(x, z);
    if (y < -1.5) continue;
    const vi  = Math.floor(Math.random() * TREE_VARIANTS);
    const scl = 0.18 + Math.random() * 0.14;  // ~0.18-0.32, much smaller than before
    q.setFromAxisAngle(up, Math.random() * Math.PI * 2);
    variantTransforms[vi].push(new THREE.Matrix4().compose(
      new THREE.Vector3(x, y, z), q, new THREE.Vector3(scl, scl, scl)
    ));
    // ez-tree default trunk radius is 1.5 units; scale carries through to world space.
    treeColliders.push({ x, z, r: 1.5 * scl + DUCK_RADIUS, top: y + variantTopY[vi] * scl });
    placed++;
  }
}

for (let vi = 0; vi < TREE_VARIANTS; vi++) {
  const subs = treeVariants[vi];
  const xs   = variantTransforms[vi];
  if (!xs.length) continue;
  for (const { geometry, material } of subs) {
    const im = new THREE.InstancedMesh(geometry, material, xs.length);
    im.castShadow = false;
    im.receiveShadow = true;
    for (let k = 0; k < xs.length; k++) im.setMatrixAt(k, xs[k]);
    im.instanceMatrix.needsUpdate = true;
    scene.add(im);
  }
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
const GRASS_COUNT  = 500000;
const BLADE_WIDTH  = 0.07;
const BLADE_HEIGHT = 0.09;
const BLADE_JOINTS = 3;

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
  const x = (Math.random() - 0.5) * (TERRAIN_SIZE - 20);
  const z = (Math.random() - 0.5) * (TERRAIN_SIZE - 20);
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
const FLOWER_CLUSTERS = 900;
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
    const cx = (Math.random() - 0.5) * (TERRAIN_SIZE - 20);
    const cz = (Math.random() - 0.5) * (TERRAIN_SIZE - 20);
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
      const idle = Object.keys(actions).find(n => n.includes('idle')) || first;
      if (idle) { currentAction = actions[idle]; currentAction.play(); }
    }
  },
  undefined,
  () => console.warn('duck.glb not found yet — using placeholder cube. Drop your exported file in next to index.html.')
);

player.position.set(0, getTerrainHeight(0, 0), 0);

const keys = {};
addEventListener('keydown', (e) => keys[e.code] = true);
addEventListener('keyup',   (e) => keys[e.code] = false);

const PITCH_MIN = 0.05;
const PITCH_MAX = Math.PI / 2 - 0.1;
let cameraYaw = 0, cameraPitch = 0.35;
let targetYaw = cameraYaw, targetPitch = cameraPitch;
let dragging = false;
let lastX = 0, lastY = 0;
const canvas = renderer.domElement;
canvas.addEventListener('mousedown', (e) => { dragging = true; lastX = e.clientX; lastY = e.clientY; });
addEventListener('mouseup',   () => dragging = false);
addEventListener('mousemove', (e) => {
  if (!dragging) return;
  targetYaw   -= (e.clientX - lastX) * 0.005;
  targetPitch = THREE.MathUtils.clamp(targetPitch - (e.clientY - lastY) * 0.005, PITCH_MIN, PITCH_MAX);
  lastX = e.clientX; lastY = e.clientY;
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

const SPEED = 6;
const ROT_SPEED = 10;
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
    scene.fog.near = 60;
    scene.fog.far  = 200;
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
  } else {
    scene.background.set(0x87ceeb);
    scene.fog.color.set(0xb8d8ee);
    scene.fog.near = 120;
    scene.fog.far  = 320;
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
  }
  toggleBtn.textContent = isNight ? 'Day' : 'Night';
  applyLight();  // light is only on when night && user-toggle on
}
toggleBtn.addEventListener('click', () => { isNight = !isNight; applyDayNight(); });
addEventListener('keydown', (e) => {
  if (e.code === 'KeyN') { isNight = !isNight; applyDayNight(); }
});

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

  if (spacePressed) {
    if (climbState === 'normal') {
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
  if (climbState === 'normal') {
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
    let nx = player.position.x + wx * SPEED * dt;
    let nz = player.position.z + wz * SPEED * dt;
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

  if (climbState === 'normal') {
    player.position.y = getTerrainHeight(player.position.x, player.position.z);
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
    const move = Object.keys(actions).find(n => n.includes('walk') || n.includes('run') || n.includes('jump'));
    const idle = Object.keys(actions).find(n => n.includes('idle')) || Object.keys(actions)[0];
    if (moving && move) setAction(move);
    else if (idle) setAction(idle);
  } else {
    placeholder.position.y = 0.6 + (moving ? Math.sin(performance.now() * 0.018) * 0.08 : 0);
  }

  const camLerp = 1 - Math.pow(0.001, dt);
  cameraYaw   += (targetYaw     - cameraYaw)   * camLerp;
  cameraPitch += (targetPitch   - cameraPitch) * camLerp;
  camDist     += (targetCamDist - camDist)     * camLerp;

  const cosP = Math.cos(cameraPitch);
  camera.position.set(
    player.position.x + Math.sin(cameraYaw) * cosP * camDist,
    player.position.y + Math.sin(cameraPitch) * camDist + CAM_HEIGHT,
    player.position.z + Math.cos(cameraYaw) * cosP * camDist
  );
  camera.lookAt(player.position.x, player.position.y + 1, player.position.z);

  renderer.render(scene, camera);
  requestAnimationFrame(animate);
}
animate();

addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});
