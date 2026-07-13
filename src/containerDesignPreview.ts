// Dev-only design harness for the cargo container styles (served from
// public/container-design-preview.html). The three production styles come from
// components/containerFaces.ts — the same code path CargoGrid3D renders — so
// what this page shows is exactly what ships. Signal/Wire are retired ChatGPT
// candidates kept for comparison.

import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js'
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js'
import { createContainerMaterials, type ContainerStyle } from './components/containerFaces'
import { disposeObject } from './components/threeUtils'

type PreviewStyle = ContainerStyle | 'signal' | 'wire'
type PreviewMode = 'stacked' | 'single'
type PreviewView = 'iso' | 'top' | 'side'

interface BoxSpec {
  /** [width, height, depth] in 1-SCU cells. */
  cells: [number, number, number]
  scu: number
  dims: [number, number, number]
  label: string
  position: [number, number, number]
  color: number
}

interface PreviewRefs {
  mount: HTMLElement
  renderer: THREE.WebGLRenderer
  scene: THREE.Scene
  camera: THREE.PerspectiveCamera
  controls: OrbitControls
  floor: THREE.Group
  cargo: THREE.Group
  render: () => void
}

/** World size of one 1-SCU cell. */
const CELL = 0.55

const MISSION_BLUE = 0x5b8cff
const MISSION_GREEN = 0x46c08a

/** Real SC container shapes (see src/domain/cargo.ts), placed FLUSH on a shared
 *  cell lattice — zero gaps, so styles that protrude past their dims get caught. */
function spec(
  cells: [number, number, number],
  scu: number,
  corner: [number, number, number],
  color: number,
): BoxSpec {
  return {
    cells,
    scu,
    dims: [cells[0] * CELL, cells[1] * CELL, cells[2] * CELL],
    label: `${scu} SCU`,
    position: [
      (corner[0] + cells[0] / 2) * CELL,
      (corner[1] + cells[1] / 2) * CELL,
      (corner[2] + cells[2] / 2) * CELL,
    ],
    color,
  }
}

const BOXES: Record<PreviewMode, BoxSpec[]> = {
  stacked: [
    spec([8, 2, 2], 32, [-6, 0, -1], MISSION_BLUE),
    spec([4, 2, 2], 16, [2, 0, -1], MISSION_GREEN),
    spec([2, 2, 2], 8, [-6, 2, -1], MISSION_BLUE),
    spec([1, 1, 1], 1, [-4, 2, -1], MISSION_GREEN),
  ],
  single: [spec([8, 2, 2], 32, [-4, 0, -1], MISSION_BLUE)],
}

const STYLE_TITLES: Record<PreviewStyle, string> = {
  cell: 'Unit-Cell Shell',
  lid: 'Two-Tone Manifest',
  ion: 'Ion Trace',
  signal: 'Mission Signal',
  wire: 'Tactical Wireframe',
}

let previewMode: PreviewMode = 'stacked'
let previewStyle: PreviewStyle = 'cell'
let previewView: PreviewView = 'iso'

const mount = document.querySelector<HTMLElement>('[data-preview]')
if (!mount) throw new Error('Missing preview mount')

const refs = createScene(mount)
rebuildPreview()

for (const button of document.querySelectorAll<HTMLButtonElement>('[data-style]')) {
  button.addEventListener('click', () => setStyle(button.dataset.style as PreviewStyle))
}

for (const button of document.querySelectorAll<HTMLButtonElement>('[data-style-card]')) {
  button.addEventListener('click', () => setStyle(button.dataset.styleCard as PreviewStyle))
}

for (const button of document.querySelectorAll<HTMLButtonElement>('[data-mode]')) {
  button.addEventListener('click', () => {
    previewMode = button.dataset.mode as PreviewMode
    document.querySelectorAll('[data-mode]').forEach((b) => b.classList.toggle('active', b === button))
    rebuildPreview()
  })
}

for (const button of document.querySelectorAll<HTMLButtonElement>('[data-stage-view]')) {
  button.addEventListener('click', () => {
    previewView = button.dataset.stageView as PreviewView
    document.querySelectorAll('[data-stage-view]').forEach((b) => b.classList.toggle('active', b === button))
    applyCameraView(refs, previewView)
  })
}

function setStyle(style: PreviewStyle) {
  previewStyle = style
  document.querySelectorAll('[data-style]').forEach((b) => {
    b.classList.toggle('active', (b as HTMLElement).dataset.style === style)
  })
  document.querySelectorAll('[data-style-card]').forEach((b) => {
    b.classList.toggle('active', (b as HTMLElement).dataset.styleCard === style)
  })
  const title = document.querySelector('#activeTitle')
  if (title) title.textContent = STYLE_TITLES[style]
  rebuildPreview()
}

function createScene(mount: HTMLElement): PreviewRefs {
  const scene = new THREE.Scene()
  const camera = new THREE.PerspectiveCamera(42, 1, 0.1, 100)
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true })
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
  renderer.outputColorSpace = THREE.SRGBColorSpace
  renderer.toneMapping = THREE.ACESFilmicToneMapping
  renderer.toneMappingExposure = 1.08
  renderer.shadowMap.enabled = true
  renderer.shadowMap.type = THREE.PCFShadowMap
  renderer.setClearColor(0x000000, 0)
  mount.appendChild(renderer.domElement)

  const render = () => renderer.render(scene, camera)
  const controls = new OrbitControls(camera, renderer.domElement)
  controls.enableDamping = false
  controls.minDistance = 4.8
  controls.maxDistance = 18
  controls.minPolarAngle = 0.001
  controls.maxPolarAngle = Math.PI * 0.5
  controls.rotateSpeed = 0.58
  controls.zoomSpeed = 0.72
  controls.panSpeed = 0.55
  controls.target.set(0, 0.7, 0)
  controls.addEventListener('change', render)

  // Soft studio env-map: turns flat lambert faces into specular gradients on the
  // dark bg. Low intensity so it lifts materials without washing the scene.
  const pmrem = new THREE.PMREMGenerator(renderer)
  const room = new RoomEnvironment()
  scene.environment = pmrem.fromScene(room).texture
  scene.environmentIntensity = 0.32
  room.dispose()
  pmrem.dispose()

  scene.add(new THREE.HemisphereLight(0xdce8ff, 0x151923, 1.65))

  const key = new THREE.DirectionalLight(0xffffff, 2.25)
  key.position.set(5, 8, 6)
  key.castShadow = true
  key.shadow.mapSize.set(1024, 1024)
  key.shadow.camera.left = -8
  key.shadow.camera.right = 8
  key.shadow.camera.top = 8
  key.shadow.camera.bottom = -8
  scene.add(key)

  const rim = new THREE.DirectionalLight(0x8fb6ff, 0.85)
  rim.position.set(-6, 4, -5)
  scene.add(rim)

  const floor = new THREE.Group()
  const cargo = new THREE.Group()
  scene.add(floor, cargo)

  const refs: PreviewRefs = { mount, renderer, scene, camera, controls, floor, cargo, render }
  const resize = () => {
    const width = mount.clientWidth || 600
    const height = mount.clientHeight || 420
    camera.aspect = width / height
    camera.updateProjectionMatrix()
    renderer.setSize(width, height)
    render()
  }

  if (typeof ResizeObserver !== 'undefined') new ResizeObserver(resize).observe(mount)
  else window.addEventListener('resize', resize)

  resize()
  applyCameraView(refs, 'iso')
  return refs
}

function rebuildPreview() {
  clearGroup(refs.floor)
  clearGroup(refs.cargo)

  refs.floor.add(createFloorRig(previewStyle))
  for (const box of BOXES[previewMode]) {
    const cargoBox = createCargoBox(previewStyle, box)
    cargoBox.position.set(...box.position)
    refs.cargo.add(cargoBox)
  }

  applyCameraView(refs, previewView)
}

function createCargoBox(style: PreviewStyle, box: BoxSpec) {
  if (style === 'signal') return createSignalBox(box)
  if (style === 'wire') return createWireBox(box)
  return createBakedBox(box, style)
}

/** The production styles: one BoxGeometry mesh + materials from the shared
 *  containerFaces factory — identical to what CargoGrid3D renders. */
function createBakedBox(box: BoxSpec, style: ContainerStyle) {
  const [cw, ch, cd] = box.cells
  const [w, h, d] = box.dims
  const materials = createContainerMaterials({
    style,
    cells: { w: cw, h: ch, d: cd },
    scu: box.scu,
    color: box.color,
    anisotropy: refs.renderer.capabilities.getMaxAnisotropy(),
  })
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), materials)
  mesh.castShadow = true
  mesh.receiveShadow = true
  const group = new THREE.Group()
  group.add(mesh)
  return group
}

function createSignalBox(box: BoxSpec) {
  const [w, h, d] = box.dims
  const group = new THREE.Group()
  const color = new THREE.Color(box.color)
  const shellMaterial = new THREE.MeshStandardMaterial({
    color,
    map: stripeTexture(color),
    emissive: color.clone().multiplyScalar(0.16),
    roughness: 0.42,
    metalness: 0.05,
    transparent: true,
    opacity: 0.68,
    depthWrite: false,
  })
  const frameMaterial = new THREE.MeshStandardMaterial({
    color,
    emissive: color.clone().multiplyScalar(0.11),
    roughness: 0.48,
    metalness: 0.12,
  })
  const panelMaterial = new THREE.MeshStandardMaterial({
    color: 0x0b111c,
    roughness: 0.72,
    metalness: 0.18,
    transparent: true,
    opacity: 0.58,
  })

  const shell = new THREE.Mesh(new RoundedBoxGeometry(w, h, d, 3, Math.min(0.09, h * 0.1)), shellMaterial)
  shell.castShadow = true
  shell.receiveShadow = true
  group.add(shell)

  addBoxFrame(group, w, h, d, Math.min(0.075, h * 0.09), frameMaterial)
  addInsetPanel(group, [w * 0.56, h * 0.46], [0, 0, d / 2 + 0.012], 0, panelMaterial)
  addInsetPanel(group, [w * 0.56, h * 0.46], [0, 0, -d / 2 - 0.012], Math.PI, panelMaterial)
  addPart(group, [w * 0.22, h * 0.12, 0.06], [0, -h * 0.28, d / 2 + 0.035], frameMaterial)

  group.add(labelSprite(box.label.replace(' SCU', ''), color, [0, h / 2 + 0.18, 0], 0.7))
  return group
}

function createWireBox(box: BoxSpec) {
  const [w, h, d] = box.dims
  const group = new THREE.Group()
  const color = new THREE.Color(box.color)
  const ghostMaterial = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.07, depthWrite: false })
  const barMaterial = new THREE.MeshStandardMaterial({
    color,
    emissive: color.clone().multiplyScalar(0.18),
    roughness: 0.38,
    metalness: 0.2,
  })
  const lineMaterial = new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.56 })

  group.add(new THREE.Mesh(new THREE.BoxGeometry(w, h, d), ghostMaterial))
  addBoxFrame(group, w, h, d, Math.min(0.07, h * 0.08), barMaterial)

  for (const x of [-w / 2, w / 2]) {
    for (const z of [-d / 2, d / 2]) {
      addPart(group, [0.14, 0.14, 0.14], [x, h / 2, z], barMaterial)
      addPart(group, [0.14, 0.14, 0.14], [x, -h / 2, z], barMaterial)
    }
  }

  group.add(crossBrace(w, h, d / 2 + 0.018, lineMaterial))
  group.add(crossBrace(w, h, -d / 2 - 0.018, lineMaterial))
  group.add(labelSprite(box.label, color, [0, 0, d / 2 + 0.15], 0.62))
  return group
}

function createFloorRig(style: PreviewStyle) {
  const group = new THREE.Group()
  // Cell-aligned rig: the floor grid must share the box lattice (1 line per SCU
  // cell) or seams visibly drift off the grid lines.
  const cellsX = 14
  const cellsZ = 8
  const width = cellsX * CELL
  const depth = cellsZ * CELL
  const hullHeight = 4 * CELL

  const plate = new THREE.Mesh(
    new THREE.PlaneGeometry(width + 0.7, depth + 0.7),
    new THREE.ShadowMaterial({ color: 0x05070b, opacity: style === 'wire' ? 0.12 : 0.2 }),
  )
  plate.rotation.x = -Math.PI / 2
  plate.position.y = -0.035
  plate.receiveShadow = true
  group.add(plate)

  const gridPoints: number[] = []
  const x0 = -width / 2
  const z0 = -depth / 2
  for (let i = 0; i <= cellsX; i++) gridPoints.push(x0 + i * CELL, 0.012, z0, x0 + i * CELL, 0.012, z0 + depth)
  for (let j = 0; j <= cellsZ; j++) gridPoints.push(x0, 0.012, z0 + j * CELL, x0 + width, 0.012, z0 + j * CELL)

  const grid = new THREE.BufferGeometry()
  grid.setAttribute('position', new THREE.Float32BufferAttribute(gridPoints, 3))
  group.add(
    new THREE.LineSegments(
      grid,
      new THREE.LineBasicMaterial({ color: 0x566071, transparent: true, opacity: style === 'wire' ? 0.34 : 0.28 }),
    ),
  )

  const hull = new THREE.LineSegments(
    new THREE.EdgesGeometry(new THREE.BoxGeometry(width, hullHeight, depth)),
    new THREE.LineBasicMaterial({ color: 0x8792a6, transparent: true, opacity: style === 'wire' ? 0.35 : 0.22 }),
  )
  hull.position.y = hullHeight / 2
  group.add(hull)
  return group
}

function addBoxFrame(group: THREE.Group, w: number, h: number, d: number, bar: number, material: THREE.Material) {
  for (const y of [-h / 2, h / 2]) {
    for (const z of [-d / 2, d / 2]) addPart(group, [w, bar, bar], [0, y, z], material)
  }
  for (const x of [-w / 2, w / 2]) {
    for (const z of [-d / 2, d / 2]) addPart(group, [bar, h, bar], [x, 0, z], material)
  }
  for (const x of [-w / 2, w / 2]) {
    for (const y of [-h / 2, h / 2]) addPart(group, [bar, bar, d], [x, y, 0], material)
  }
}

function addPart(
  group: THREE.Group,
  size: [number, number, number],
  position: [number, number, number],
  material: THREE.Material,
) {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(...size), material)
  mesh.position.set(...position)
  mesh.castShadow = true
  mesh.receiveShadow = true
  group.add(mesh)
  return mesh
}

function addInsetPanel(
  group: THREE.Group,
  size: [number, number],
  position: [number, number, number],
  rotationY: number,
  material: THREE.Material,
) {
  const panel = new THREE.Mesh(new THREE.PlaneGeometry(...size), material)
  panel.position.set(...position)
  panel.rotation.y = rotationY
  group.add(panel)
}

function crossBrace(w: number, h: number, z: number, material: THREE.LineBasicMaterial) {
  const inset = 0.16
  const points = [
    -w / 2 + inset, -h / 2 + inset, z,
    w / 2 - inset, h / 2 - inset, z,
    -w / 2 + inset, h / 2 - inset, z,
    w / 2 - inset, -h / 2 + inset, z,
  ]
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(points, 3))
  return new THREE.LineSegments(geometry, material)
}

function labelSprite(text: string, color: THREE.Color, position: [number, number, number], scale: number) {
  const canvas = document.createElement('canvas')
  canvas.width = 256
  canvas.height = 96
  const ctx = canvas.getContext('2d')
  if (!ctx) return new THREE.Sprite()

  ctx.clearRect(0, 0, canvas.width, canvas.height)
  roundedRect(ctx, 18, 18, 220, 60, 15)
  ctx.fillStyle = 'rgba(8, 10, 15, 0.78)'
  ctx.fill()
  ctx.strokeStyle = color.getStyle()
  ctx.globalAlpha = 0.76
  ctx.lineWidth = 3
  ctx.stroke()
  ctx.globalAlpha = 1
  ctx.fillStyle = '#f6f8fb'
  ctx.font = '700 27px system-ui, Segoe UI, sans-serif'
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillText(text, 128, 49)

  const texture = new THREE.CanvasTexture(canvas)
  texture.colorSpace = THREE.SRGBColorSpace
  const material = new THREE.SpriteMaterial({ map: texture, transparent: true, depthWrite: false })
  const sprite = new THREE.Sprite(material)
  sprite.scale.set(1.18 * scale, 0.44 * scale, 1)
  sprite.position.set(...position)
  return sprite
}

function stripeTexture(color: THREE.Color) {
  const canvas = document.createElement('canvas')
  canvas.width = 128
  canvas.height = 128
  const ctx = canvas.getContext('2d')!
  ctx.fillStyle = color.getStyle()
  ctx.fillRect(0, 0, canvas.width, canvas.height)
  ctx.strokeStyle = 'rgba(255,255,255,0.22)'
  ctx.lineWidth = 13
  for (let i = -128; i < 256; i += 30) {
    ctx.beginPath()
    ctx.moveTo(i, 128)
    ctx.lineTo(i + 128, 0)
    ctx.stroke()
  }
  const texture = new THREE.CanvasTexture(canvas)
  texture.colorSpace = THREE.SRGBColorSpace
  texture.wrapS = THREE.RepeatWrapping
  texture.wrapT = THREE.RepeatWrapping
  texture.repeat.set(1.8, 1.2)
  return texture
}

function roundedRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath()
  ctx.moveTo(x + r, y)
  ctx.lineTo(x + w - r, y)
  ctx.quadraticCurveTo(x + w, y, x + w, y + r)
  ctx.lineTo(x + w, y + h - r)
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h)
  ctx.lineTo(x + r, y + h)
  ctx.quadraticCurveTo(x, y + h, x, y + h - r)
  ctx.lineTo(x, y + r)
  ctx.quadraticCurveTo(x, y, x + r, y)
  ctx.closePath()
}

function applyCameraView(refs: PreviewRefs, view: PreviewView) {
  const center = new THREE.Vector3(0, 0.8, 0)
  const directions: Record<PreviewView, THREE.Vector3> = {
    iso: new THREE.Vector3(0.88, 0.64, 1.08),
    top: new THREE.Vector3(0, 1, 0.001),
    side: new THREE.Vector3(1.2, 0.22, 0.02),
  }
  const distance = view === 'top' ? 8.4 : 8.1
  refs.camera.up.set(0, 1, 0)
  refs.camera.position.copy(center).add(directions[view].normalize().multiplyScalar(distance))
  refs.camera.lookAt(center)
  refs.camera.updateProjectionMatrix()
  refs.controls.target.copy(center)
  refs.controls.update()
  refs.render()
}

function clearGroup(group: THREE.Group) {
  while (group.children.length) disposeObject(group.children.pop()!)
}
