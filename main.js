import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
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

scene.add(new THREE.HemisphereLight(0xbcdfff, 0x4a5530, 1.1));
const sun = new THREE.DirectionalLight(0xfff2cc, 3.2);
sun.position.set(50, 80, 30);
sun.castShadow = true;
sun.shadow.mapSize.set(1024, 1024);
const s = sun.shadow.camera;
s.left = -25; s.right = 25; s.top = 25; s.bottom = -25; s.near = 1; s.far = 200;
scene.add(sun);
scene.add(sun.target);  // sun follows player so the small shadow frustum always covers them

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
  t.traverse((o) => {
    if (!o.isMesh) return;
    const g = o.geometry.clone();
    g.applyMatrix4(o.matrixWorld);
    const isLeaf = o.material && o.material.name === 'leaves';
    subs.push({ geometry: g, material: isLeaf ? leafMaterial : barkMaterial });
  });
  treeVariants.push(subs);
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
    treeColliders.push({ x, z, r: 1.5 * scl + DUCK_RADIUS });
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
      vec3 col = mix(bottomColor, tip, frc);
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

const clock = new THREE.Clock();

let totalElapsed = 0;
function animate() {
  const dt = Math.min(clock.getDelta(), 0.1);
  totalElapsed += dt;
  grassMaterial.uniforms.time.value = totalElapsed * 0.25;
  windUniform.value = totalElapsed;

  let mx = 0, mz = 0;
  if (keys['KeyW'] || keys['ArrowUp'])    mz -= 1;
  if (keys['KeyS'] || keys['ArrowDown'])  mz += 1;
  if (keys['KeyA'] || keys['ArrowLeft'])  mx -= 1;
  if (keys['KeyD'] || keys['ArrowRight']) mx += 1;
  const moving = mx || mz;

  if (moving) {
    const len = Math.hypot(mx, mz);
    mx /= len; mz /= len;
    const sin = Math.sin(cameraYaw), cos = Math.cos(cameraYaw);
    const wx =  mx * cos + mz * sin;
    const wz = -mx * sin + mz * cos;
    let nx = player.position.x + wx * SPEED * dt;
    let nz = player.position.z + wz * SPEED * dt;
    // Push the duck out of any tree it would intersect (sphere-sphere on the XZ plane).
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

  player.position.y = getTerrainHeight(player.position.x, player.position.z);

  sun.position.set(player.position.x + 50, player.position.y + 80, player.position.z + 30);
  sun.target.position.copy(player.position);
  sun.target.updateMatrixWorld();

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
