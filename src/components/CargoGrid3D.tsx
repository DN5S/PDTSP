import { useEffect, useMemo, useRef, useState } from 'react'
import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js'
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js'
import { LineSegments2 } from 'three/examples/jsm/lines/LineSegments2.js'
import { LineSegmentsGeometry } from 'three/examples/jsm/lines/LineSegmentsGeometry.js'
import type { LoadoutPlan, PlacedBox } from '../optimizer/loadout'
import { missionColor } from '../optimizer/loadout'
import { auditUnloadOrder, extractionBlockers } from '../optimizer/extraction'
import { resolveBoxCell } from '../optimizer/gridSnap'
import { compartmentAllowsBox, compartmentOpening, type Compartment } from '../ships/grids'
import { disposeObject, unionSurfaceGeometry } from './threeUtils'
import {
  CONTAINER_STYLE_OPTIONS,
  createContainerMaterials,
  type ContainerStyle,
} from './containerFaces'

interface UnloadSpotlight {
  missionId: string
  stopIndex: number
}

interface StepperInfo {
  index: number
  total: number
  label: string
  /** Mission color of the next step; null when complete. */
  color?: string | null
}

interface Props {
  plan: LoadoutPlan
  focusedMissionId?: string | null
  missionColorFor?: (id: string) => string
  missionLabel?: (id: string) => string
  ghostBoxes?: PlacedBox[]
  unloadSpotlight?: UnloadSpotlight | null
  stepper?: StepperInfo | null
  onStep?: (delta: number) => void
}

interface SceneRefs {
  renderer: THREE.WebGLRenderer
  scene: THREE.Scene
  camera: THREE.PerspectiveCamera
  controls: OrbitControls
  cargo: THREE.Group
  keyLight: THREE.DirectionalLight
  raycaster: THREE.Raycaster
  pointer: THREE.Vector2
  boxes: CargoMesh[]
  currentGrid: [number, number, number]
  currentCompartments: Compartment[]
  currentView: ViewPreset
  floorPlane: THREE.Plane
  /** Scene-root light pool; excluded from camera/shadow fitting. */
  floorGlow: THREE.Mesh
  hazardIds: Set<string>
  xrayIds: Set<string>
  /** Fat-line materials whose resolution uniform follows the canvas size. */
  deferredLineMaterials: LineMaterial[]
  render: () => void
}

type ViewPreset = 'iso' | 'top' | 'front' | 'side'

interface CargoUserData {
  kind: 'cargo-box'
  boxId: string
  missionId: string
  commodity: string
  scu: number
  dims: [number, number, number]
  baseColor: THREE.Color
  style: ContainerStyle
  deliverStop?: number
}

type CargoMesh = THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardMaterial[]> & {
  userData: CargoUserData
}

interface HoverInfo {
  mission: string
  commodity: string
  scu: number
  dims: [number, number, number]
  blockers: number
}

interface BoxPlacement {
  id: string
  gridPos: [number, number, number]
  offGrid: boolean
  worldPosition?: [number, number]
  /** Current footprint; may be rotated from the box's base dims. */
  dims: [number, number, number]
}

interface DragState {
  boxId: string
  mesh: CargoMesh
  dims: [number, number, number]
  origin: BoxPlacement
  grabOffset: THREE.Vector3
  heightCell: number
  candidate: DragCandidate
}

type DragCandidate =
  | { mode: 'grid'; pos: [number, number, number]; valid: boolean }
  | { mode: 'offgrid'; worldPosition: [number, number]; valid: true }

const VIEW_PRESETS: { id: ViewPreset; label: string }[] = [
  { id: 'iso', label: 'Iso' },
  { id: 'top', label: 'Top' },
  { id: 'front', label: 'Front' },
  { id: 'side', label: 'Side' },
]
const TOP_VIEW_EPSILON = 0.001

// Wheel deltas are accumulated and eased per frame to avoid hyperscroll lurches.
const ZOOM_WHEEL_STEP = 0.0005
const ZOOM_DELTA_CAP = 140
const ZOOM_SMOOTH = 0.18

const BOX_STYLE_KEY = 'hauling-sc:cargo-style'

function loadSavedBoxStyle(): ContainerStyle {
  try {
    const raw = localStorage.getItem(BOX_STYLE_KEY)
    if (raw === 'cell' || raw === 'lid' || raw === 'ion') return raw
  } catch {
    /* storage unavailable — fall through to default */
  }
  return 'cell'
}

/** Emissive ladder for idle / hover / drag. */
const EMISSIVE_LADDER: Record<ContainerStyle, [number, number, number]> = {
  cell: [0.045, 0.16, 0.22],
  lid: [0.03, 0.12, 0.18],
  ion: [1.1, 1.4, 1.65],
}

/** Unfocused opacity per style. */
const DIM_OPACITY: Record<ContainerStyle, number> = { cell: 0.25, lid: 0.25, ion: 0.42 }
const ION_DIM_GLOW_BOOST = 1.5

/** Warning tints: persistent dig hazards and hovered-box blockers. */
type BoxTint = 'none' | 'hazard' | 'xray'
const HAZARD_TINT = new THREE.Color(0xe2574a)
const XRAY_TINT = new THREE.Color(0xe0a23a)
const EMPTY_ID_SET: Set<string> = new Set()

/** Blockers of one placed box under the current manual arrangement. */
function blockersForBox(
  boxId: string,
  placements: BoxPlacement[],
  boxById: Map<string, PlacedBox>,
  compartments: Compartment[],
): Set<string> {
  const target = placements.find((p) => p.id === boxId)
  if (!target || target.offGrid) return EMPTY_ID_SET
  const obstacles = placements
    .filter((p) => !p.offGrid && p.id !== boxId && boxById.has(p.id))
    .map((p) => ({ id: p.id, pos: p.gridPos, dims: p.dims }))
  return new Set(
    extractionBlockers({ id: boxId, pos: target.gridPos, dims: target.dims }, obstacles, compartments),
  )
}

export function CargoGrid3D({
  plan,
  focusedMissionId = null,
  missionColorFor,
  missionLabel,
  ghostBoxes,
  unloadSpotlight = null,
  stepper = null,
  onStep,
}: Props) {
  const rootRef = useRef<HTMLDivElement>(null)
  const mountRef = useRef<HTMLDivElement>(null)
  const sceneRef = useRef<SceneRefs | null>(null)
  const focusedMissionRef = useRef<string | null>(focusedMissionId)
  const spotlightRef = useRef<UnloadSpotlight | null>(unloadSpotlight)
  const pointerOverRef = useRef(false)
  const onStepRef = useRef(onStep)
  const hoveredBoxRef = useRef<string | null>(null)
  const draggingBoxRef = useRef<string | null>(null)
  const dragStateRef = useRef<DragState | null>(null)
  const missionLabelRef = useRef<(id: string) => string>(missionLabel ?? ((id) => id))
  const planRef = useRef(plan)
  const boxByIdRef = useRef(createBoxMap(plan))
  const [placements, setPlacements] = useState<BoxPlacement[]>(() => createOptimalPlacements(plan))
  const placementsRef = useRef(placements)
  const [activeView, setActiveView] = useState<ViewPreset>('iso')
  const [boxStyle, setBoxStyle] = useState<ContainerStyle>(loadSavedBoxStyle)
  const [hover, setHover] = useState<HoverInfo | null>(null)
  // Pointer-move-only tooltip position lives outside React state.
  const tooltipRef = useRef<HTMLDivElement | null>(null)
  const tooltipPosRef = useRef({ x: 12, y: 12 })
  // Dev perf HUD is written directly from the render wrapper.
  const perfHudRef = useRef<HTMLDivElement | null>(null)

  const changeBoxStyle = (style: ContainerStyle) => {
    setBoxStyle(style)
    try {
      localStorage.setItem(BOX_STYLE_KEY, style)
    } catch {
      /* run without persistence */
    }
  }

  // Manual drags can invalidate the witness's dig-free unload order.
  const digIssues = useMemo(() => {
    const boxById = createBoxMap(plan)
    const boxes = placements
      .filter((p) => !p.offGrid && boxById.has(p.id))
      .map((p) => ({
        id: p.id,
        pos: p.gridPos,
        dims: p.dims,
        deliverStop: boxById.get(p.id)!.deliverStop,
      }))
    return auditUnloadOrder(boxes, plan.compartments)
  }, [plan, placements])
  const hazardIds = useMemo(() => new Set(digIssues.flatMap((i) => i.blockerIds)), [digIssues])
  const digWarning = useMemo(() => {
    const first = digIssues[0]
    if (!first) return null
    const buried = plan.boxes.find((b) => b.id === first.buriedId)
    const label = buried ? missionLabel?.(buried.missionId) ?? buried.missionId : first.buriedId
    const more = digIssues.length > 1 ? ` · +${digIssues.length - 1} more` : ''
    return `${hazardIds.size} box${hazardIds.size > 1 ? 'es' : ''} bury ${label}'s stop-${first.deliverStop + 1} cargo — dig required${more}`
  }, [digIssues, hazardIds, plan, missionLabel])

  // Checked-off cargo without support is staged off-grid until later loads support it.
  const deferredNote = useMemo(() => {
    if (!plan.deferred.length) return null
    const scu = plan.deferred.reduce((a, b) => a + b.scu, 0)
    const missions = [...new Set(plan.deferred.map((b) => b.missionId))]
    const who =
      missions.length === 1 ? missionLabel?.(missions[0]) ?? missions[0] : `${missions.length} missions`
    return `Keep ${scu} SCU (${who}) on the staging pad for now — its dashed cell rests on cargo from a later load step`
  }, [plan, missionLabel])

  useEffect(() => {
    planRef.current = plan
    boxByIdRef.current = createBoxMap(plan)
  }, [plan])

  // Reconcile during render so plan changes do not paint one stale-placement frame.
  const [prevPlan, setPrevPlan] = useState(plan)
  if (prevPlan !== plan) {
    setPrevPlan(plan)
    setPlacements((current) => reconcilePlacements(current, plan))
  }

  useEffect(() => {
    placementsRef.current = placements
  }, [placements])

  useEffect(() => {
    focusedMissionRef.current = focusedMissionId
    applyBoxVisualState(
      sceneRef.current,
      focusedMissionId,
      hoveredBoxRef.current,
      draggingBoxRef.current,
      spotlightRef.current,
    )
  }, [focusedMissionId])

  useEffect(() => {
    spotlightRef.current = unloadSpotlight
    applyBoxVisualState(
      sceneRef.current,
      focusedMissionRef.current,
      hoveredBoxRef.current,
      draggingBoxRef.current,
      unloadSpotlight,
    )
  }, [unloadSpotlight])

  useEffect(() => {
    missionLabelRef.current = missionLabel ?? ((id) => id)
  }, [missionLabel])

  useEffect(() => {
    onStepRef.current = onStep
  }, [onStep])

  // One Three scene per component; render on demand so the page can idle.
  useEffect(() => {
    const mount = mountRef.current
    if (!mount) return

    const w = mount.clientWidth || 600
    const h = mount.clientHeight || 380

    const scene = new THREE.Scene()
    // No fog: zooming out made cargo look artificially shadowed.

    const camera = new THREE.PerspectiveCamera(45, w / h, 0.1, 1000)

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true })
    // Silence noisy ANGLE shader diagnostics; they are compile warnings, not runtime failures.
    renderer.debug.checkShaderErrors = false
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    renderer.setSize(w, h)
    renderer.outputColorSpace = THREE.SRGBColorSpace
    renderer.toneMapping = THREE.ACESFilmicToneMapping
    renderer.toneMappingExposure = 1.08
    renderer.shadowMap.enabled = true
    renderer.shadowMap.type = THREE.PCFSoftShadowMap
    renderer.setClearColor(0x000000, 0)
    mount.appendChild(renderer.domElement)

    // Perf HUD samples only rendered frames and writes outside React state.
    let perfLastT = 0
    let perfEmaMs = 0
    let perfWroteT = 0
    const render = () => {
      renderer.render(scene, camera)
      const now = performance.now()
      const dt = now - perfLastT
      perfLastT = now
      if (dt > 0 && dt < 100) perfEmaMs = perfEmaMs ? perfEmaMs * 0.88 + dt * 0.12 : dt
      if (now - perfWroteT > 200 && perfHudRef.current) {
        perfWroteT = now
        const info = renderer.info
        const fps = perfEmaMs > 0 ? Math.round(1000 / perfEmaMs) : 0
        perfHudRef.current.textContent =
          `${fps} fps · ${perfEmaMs.toFixed(1)} ms\n` +
          `${info.render.calls} draws · ${info.render.triangles.toLocaleString()} tris\n` +
          `${info.memory.geometries} geo · ${info.memory.textures} tex · ${info.programs?.length ?? 0} prog`
      }
    }

    // PMREM env maps are GPU-only, so context restore must rebuild them.
    const buildEnvironment = () => {
      const pmrem = new THREE.PMREMGenerator(renderer)
      const room = new RoomEnvironment()
      scene.environment?.dispose()
      scene.environment = pmrem.fromScene(room).texture
      room.dispose()
      pmrem.dispose()
    }
    buildEnvironment()
    scene.environmentIntensity = 0.32

    const controls = new OrbitControls(camera, renderer.domElement)
    // Damping needs frames while moving; the loop below self-terminates when settled.
    controls.enableDamping = true
    controls.dampingFactor = 0.1
    controls.minDistance = 5
    controls.maxDistance = 36
    controls.minPolarAngle = TOP_VIEW_EPSILON
    controls.maxPolarAngle = Math.PI * 0.5
    controls.rotateSpeed = 0.58
    controls.zoomSpeed = 0.72
    controls.panSpeed = 0.55
    // Custom smoothed wheel zoom replaces OrbitControls' direct wheel handling.
    controls.enableZoom = false
    controls.target.set(0, 1, 0)
    // Guarded kickCamera lets multiple events share one self-terminating rAF loop.
    let cameraAnimFrame = 0
    // dollyBy consumes accumulated wheel intent in fixed fractions per frame.
    let zoomIntent = 0
    const dollyBy = (factor: number) => {
      const offset = camera.position.clone().sub(controls.target)
      const dist = Math.min(controls.maxDistance, Math.max(controls.minDistance, offset.length() * factor))
      camera.position.copy(controls.target).add(offset.setLength(dist))
    }
    const animateCamera = () => {
      if (zoomIntent !== 0) {
        const step = zoomIntent * ZOOM_SMOOTH
        zoomIntent = Math.abs(zoomIntent - step) < 1e-4 ? 0 : zoomIntent - step
        dollyBy(Math.exp(step)) // positive wheel delta zooms out
      }
      const moving = controls.update()
      render()
      cameraAnimFrame = moving || zoomIntent !== 0 ? requestAnimationFrame(animateCamera) : 0
    }
    const kickCamera = () => {
      if (!cameraAnimFrame) cameraAnimFrame = requestAnimationFrame(animateCamera)
    }
    const onWheelZoom = (event: WheelEvent) => {
      event.preventDefault()
      const delta = Math.max(-ZOOM_DELTA_CAP, Math.min(ZOOM_DELTA_CAP, event.deltaY))
      zoomIntent += delta * ZOOM_WHEEL_STEP
      kickCamera()
    }
    controls.addEventListener('start', kickCamera)
    controls.addEventListener('change', kickCamera)
    renderer.domElement.addEventListener('wheel', onWheelZoom, { passive: false })

    scene.add(new THREE.HemisphereLight(0xdce8ff, 0x161a22, 1.7))

    // Shadow frustum is fitted after each layout rebuild.
    const key = new THREE.DirectionalLight(0xffffff, 2.35)
    key.position.set(6, 11, 7)
    key.castShadow = true
    key.shadow.mapSize.set(2048, 2048)
    // Normal bias avoids self-shadow stripes on flush-tiled box faces.
    key.shadow.normalBias = 0.04
    scene.add(key)
    scene.add(key.target)

    const rim = new THREE.DirectionalLight(0x8fb6ff, 0.85)
    rim.position.set(-8, 5, -6)
    scene.add(rim)

    const cargo = new THREE.Group()
    scene.add(cargo)

    // Scene-root glow grounds the hold without inflating cargo bounds.
    const floorGlow = new THREE.Mesh(
      new THREE.PlaneGeometry(1, 1),
      new THREE.MeshBasicMaterial({
        map: createFloorGlowTexture(),
        transparent: true,
        depthWrite: false,
      }),
    )
    floorGlow.rotation.x = -Math.PI / 2
    floorGlow.position.y = -0.06
    floorGlow.renderOrder = -1
    scene.add(floorGlow)

    const deferredLineMaterials: LineMaterial[] = []
    const onResize = () => {
      const nw = mount.clientWidth || 600
      const nh = mount.clientHeight || 380
      camera.aspect = nw / nh
      camera.updateProjectionMatrix()
      renderer.setSize(nw, nh)
      for (const m of deferredLineMaterials) m.resolution.set(nw, nh)
      render()
    }
    let resizeObserver: ResizeObserver | null = null
    if (typeof ResizeObserver !== 'undefined') {
      resizeObserver = new ResizeObserver(onResize)
      resizeObserver.observe(mount)
    } else {
      window.addEventListener('resize', onResize)
    }

    const raycaster = new THREE.Raycaster()
    const pointer = new THREE.Vector2()
    const refs: SceneRefs = {
      renderer,
      scene,
      camera,
      controls,
      cargo,
      keyLight: key,
      raycaster,
      pointer,
      boxes: [],
      currentGrid: plan.grid,
      currentCompartments: plan.compartments,
      currentView: 'iso',
      floorPlane: new THREE.Plane(new THREE.Vector3(0, 1, 0), 0),
      floorGlow,
      hazardIds: EMPTY_ID_SET,
      xrayIds: EMPTY_ID_SET,
      deferredLineMaterials,
      render,
    }
    sceneRef.current = refs

    const updatePointer = (event: PointerEvent) => {
      const rect = renderer.domElement.getBoundingClientRect()
      pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1
      pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1
      raycaster.setFromCamera(pointer, camera)
    }

    const onPointerMove = (event: PointerEvent) => {
      updatePointer(event)
      const drag = dragStateRef.current
      if (drag) {
        event.preventDefault()
        moveDraggedBox(refs, drag, placementsRef.current, boxByIdRef.current)
        return
      }

      const hit = raycaster.intersectObjects(refs.boxes, false)[0]?.object as CargoMesh | undefined
      const nextHovered = hit?.userData.boxId ?? null

      if (hit) {
        // Move tooltip without a React render per pointer event.
        const rootRect = rootRef.current?.getBoundingClientRect()
        const offsetX = rootRect ? event.clientX - rootRect.left : event.offsetX
        const offsetY = rootRect ? event.clientY - rootRect.top : event.offsetY
        const maxX = rootRect ? Math.max(12, rootRect.width - 232) : offsetX
        const maxY = rootRect ? Math.max(12, rootRect.height - 126) : offsetY
        tooltipPosRef.current = { x: Math.min(offsetX + 14, maxX), y: Math.min(offsetY + 14, maxY) }
        const tip = tooltipRef.current
        if (tip) {
          tip.style.left = `${tooltipPosRef.current.x}px`
          tip.style.top = `${tooltipPosRef.current.y}px`
        }
      }

      if (hoveredBoxRef.current !== nextHovered) {
        hoveredBoxRef.current = nextHovered
        // X-ray blockers for the hovered box.
        refs.xrayIds = nextHovered
          ? blockersForBox(nextHovered, placementsRef.current, boxByIdRef.current, refs.currentCompartments)
          : EMPTY_ID_SET
        applyBoxVisualState(refs, focusedMissionRef.current, nextHovered, draggingBoxRef.current, spotlightRef.current)
        // Hover state changes only when the target changes.
        setHover(
          hit
            ? {
                mission: missionLabelRef.current(hit.userData.missionId),
                commodity: hit.userData.commodity,
                scu: hit.userData.scu,
                dims: hit.userData.dims,
                blockers: refs.xrayIds.size,
              }
            : null,
        )
      }
    }

    const onPointerDown = (event: PointerEvent) => {
      if (event.button !== 0) return
      updatePointer(event)
      const hit = raycaster.intersectObjects(refs.boxes, false)[0]?.object as CargoMesh | undefined
      if (!hit) return

      const placement = placementsRef.current.find((p) => p.id === hit.userData.boxId)
      if (!placement) return
      // Boxes with cargo on top are not draggable.
      if (
        !placement.offGrid &&
        hasBoxOnTop(hit.userData.boxId, placement.gridPos, hit.userData.dims, placementsRef.current, boxByIdRef.current)
      ) {
        return
      }
      // Drag on the box's carry-height plane; ground projection breaks cell snapping.
      refs.floorPlane.constant = -hit.position.y
      const intersection = intersectFloor(refs)
      if (!intersection) return

      event.preventDefault()
      renderer.domElement.setPointerCapture(event.pointerId)
      refs.controls.enabled = false
      hoveredBoxRef.current = null
      refs.xrayIds = EMPTY_ID_SET
      draggingBoxRef.current = hit.userData.boxId
      setHover(null)
      dragStateRef.current = {
        boxId: hit.userData.boxId,
        mesh: hit,
        dims: hit.userData.dims,
        origin: {
          ...placement,
          gridPos: [...placement.gridPos],
          dims: [...placement.dims],
          worldPosition: placement.worldPosition ? [...placement.worldPosition] : undefined,
        },
        grabOffset: intersection.sub(hit.position),
        heightCell: placement.offGrid ? boxByIdRef.current.get(hit.userData.boxId)?.pos[2] ?? 0 : placement.gridPos[2],
        candidate: placement.offGrid
          ? { mode: 'offgrid', worldPosition: placement.worldPosition ?? [hit.position.x, hit.position.z], valid: true }
          : { mode: 'grid', pos: [...placement.gridPos], valid: true },
      }
      applyBoxVisualState(refs, focusedMissionRef.current, null, draggingBoxRef.current, spotlightRef.current)
    }

    const finishDrag = (event: PointerEvent) => {
      const drag = dragStateRef.current
      if (!drag) return

      if (renderer.domElement.hasPointerCapture(event.pointerId)) {
        renderer.domElement.releasePointerCapture(event.pointerId)
      }
      refs.controls.enabled = true
      refs.floorPlane.constant = 0
      dragStateRef.current = null
      draggingBoxRef.current = null

      const candidate = drag.candidate
      if (candidate.mode === 'grid' && candidate.valid) {
        setPlacements((current) =>
          current.map((placement) =>
            placement.id === drag.boxId
              ? { id: placement.id, gridPos: candidate.pos, offGrid: false, worldPosition: undefined, dims: drag.dims }
              : placement,
          ),
        )
      } else if (candidate.mode === 'offgrid') {
        setPlacements((current) =>
          current.map((placement) =>
            placement.id === drag.boxId
              ? { ...placement, offGrid: true, worldPosition: candidate.worldPosition, dims: drag.dims }
              : placement,
          ),
        )
      } else {
        // Invalid drops restore from authoritative placements.
        setPlacements((current) => [...current])
      }
      applyBoxVisualState(refs, focusedMissionRef.current, null, null, spotlightRef.current)
    }

    const onPointerLeave = () => {
      if (dragStateRef.current) return
      hoveredBoxRef.current = null
      refs.xrayIds = EMPTY_ID_SET
      setHover(null)
      applyBoxVisualState(refs, focusedMissionRef.current, null, draggingBoxRef.current, spotlightRef.current)
    }

    const isTypingTarget = (target: EventTarget | null) => {
      const el = target as HTMLElement | null
      return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable)
    }

    // Keyboard controls are active only while the pointer is over the view.
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
        if (!pointerOverRef.current || !onStepRef.current || isTypingTarget(event.target)) return
        event.preventDefault()
        onStepRef.current(event.key === 'ArrowRight' ? 1 : -1)
        return
      }
      if (event.key !== 'r' && event.key !== 'R') return
      const drag = dragStateRef.current
      if (!drag) return
      event.preventDefault()
      drag.dims = [drag.dims[1], drag.dims[0], drag.dims[2]]
      setMeshGeometry(drag.mesh, drag.dims)
      moveDraggedBox(refs, drag, placementsRef.current, boxByIdRef.current)
    }

    // On-demand rendering must explicitly repaint after WebGL context restore.
    const onContextRestored = () => {
      buildEnvironment()
      render()
    }

    renderer.domElement.addEventListener('webglcontextrestored', onContextRestored)
    renderer.domElement.addEventListener('pointerdown', onPointerDown)
    renderer.domElement.addEventListener('pointermove', onPointerMove)
    renderer.domElement.addEventListener('pointerup', finishDrag)
    renderer.domElement.addEventListener('pointercancel', finishDrag)
    renderer.domElement.addEventListener('pointerleave', onPointerLeave)
    window.addEventListener('keydown', onKeyDown)

    applyCameraView(refs, 'iso')
    render()

    return () => {
      if (resizeObserver) resizeObserver.disconnect()
      else window.removeEventListener('resize', onResize)
      renderer.domElement.removeEventListener('webglcontextrestored', onContextRestored)
      renderer.domElement.removeEventListener('pointerdown', onPointerDown)
      renderer.domElement.removeEventListener('pointermove', onPointerMove)
      renderer.domElement.removeEventListener('pointerup', finishDrag)
      renderer.domElement.removeEventListener('pointercancel', finishDrag)
      renderer.domElement.removeEventListener('pointerleave', onPointerLeave)
      window.removeEventListener('keydown', onKeyDown)
      if (cameraAnimFrame) cancelAnimationFrame(cameraAnimFrame)
      controls.removeEventListener('start', kickCamera)
      controls.removeEventListener('change', kickCamera)
      renderer.domElement.removeEventListener('wheel', onWheelZoom)
      controls.dispose()
      disposeObject(cargo)
      disposeObject(floorGlow)
      scene.environment?.dispose()
      renderer.dispose()
      if (renderer.domElement.parentNode === mount) mount.removeChild(renderer.domElement)
      sceneRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Rebuild grid hull and cargo meshes when the plan changes.
  useEffect(() => {
    const s = sceneRef.current
    if (!s) return
    const [X, Y] = plan.grid
    const gridChanged = !sameGrid(s.currentGrid, plan.grid)

    while (s.cargo.children.length) {
      const c = s.cargo.children.pop()!
      disposeObject(c)
    }
    s.boxes = []
    s.currentGrid = plan.grid
    s.currentCompartments = plan.compartments
    s.hazardIds = hazardIds
    // Hover X-ray is stale against the new box set.
    s.xrayIds = EMPTY_ID_SET

    // World mapping: gridX -> x, gridZ(height) -> y, gridY(length) -> z.
    const ox = -X / 2
    const oz = -Y / 2

    // Depth cueing separates near/far cargo only when zoomed well out.
    const span = Math.max(X, Y, 12)
    s.scene.fog = new THREE.Fog(0x12161f, span * 2.4, span * 7)
    s.floorGlow.scale.setScalar(span * 2.4)

    const colorByMission = new Map(plan.missionOrder.map((m, i) => [m, missionColorFor?.(m) ?? missionColor(i)]))
    const placementById = new Map(placements.map((placement) => [placement.id, placement]))
    s.cargo.add(createFloorPlate(X, Y))
    for (const c of plan.compartments) {
      const gx = ox + c.offset[0]
      const gz = oz + c.offset[1]
      s.cargo.add(createGridLines(c.dims[0], c.dims[1], gx, gz))
      const hull = createCargoHull(c)
      hull.position.set(gx + c.dims[0] / 2, 0, gz + c.dims[1] / 2)
      s.cargo.add(hull)
    }

    const anisotropy = s.renderer.capabilities.getMaxAnisotropy()
    for (const b of plan.boxes) {
      const placement = placementById.get(b.id) ?? { id: b.id, gridPos: b.pos, offGrid: false, dims: b.dims }
      const [bx, by, bz] = placement.dims
      const colorCss = colorByMission.get(b.missionId) ?? '#888888'
      // Detail is texture-baked; geometry stays flush to avoid stacked-box clipping.
      const materials = createContainerMaterials({
        style: boxStyle,
        cells: { w: bx, h: bz, d: by },
        scu: b.scu,
        color: colorCss,
        anisotropy,
      })
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(bx, bz, by), materials) as unknown as CargoMesh
      mesh.castShadow = true
      mesh.receiveShadow = true
      applyMeshPlacement(mesh, placement, plan.grid)
      mesh.userData = {
        kind: 'cargo-box',
        boxId: b.id,
        missionId: b.missionId,
        commodity: b.commodity,
        scu: b.scu,
        dims: placement.dims,
        baseColor: new THREE.Color(colorCss),
        style: boxStyle,
        deliverStop: b.deliverStop,
      }
      s.cargo.add(mesh)
      s.boxes.push(mesh)
    }

    // Ghosts guide the next load step without participating in raycasts.
    if (ghostBoxes?.length) {
      const firstId = [...ghostBoxes].sort((a, b) => a.pos[2] - b.pos[2])[0]?.id
      for (const g of ghostBoxes) {
        // Empty holds need the app-level color resolver for the next mission.
        const color = new THREE.Color(
          missionColorFor?.(g.missionId) ?? colorByMission.get(g.missionId) ?? '#888888',
        )
        const [bx, by, bz] = g.dims
        const first = g.id === firstId
        const shell = new THREE.Mesh(
          new THREE.BoxGeometry(bx, bz, by),
          new THREE.MeshBasicMaterial({
            color,
            transparent: true,
            opacity: first ? 0.22 : 0.12,
            depthWrite: false,
          }),
        )
        shell.add(
          new THREE.LineSegments(
            new THREE.EdgesGeometry(new THREE.BoxGeometry(bx, bz, by)),
            new THREE.LineBasicMaterial({ color, transparent: true, opacity: first ? 0.95 : 0.55 }),
          ),
        )
        shell.position.set(ox + g.pos[0] + bx / 2, g.pos[2] + bz / 2, oz + g.pos[1] + by / 2)
        s.cargo.add(shell)
      }
    }

    // Deferred boxes are real staged containers plus dashed destination silhouettes.
    s.deferredLineMaterials.length = 0
    if (plan.deferred.length) {
      const size = s.renderer.getSize(new THREE.Vector2())
      const dashedLine = (positions: number[], colorHex: number, opacity: number) => {
        const material = new LineMaterial({
          color: colorHex,
          linewidth: 2.5,
          dashed: true,
          dashSize: 0.22,
          gapSize: 0.14,
          transparent: true,
          opacity,
        })
        material.resolution.copy(size)
        s.deferredLineMaterials.push(material)
        const line = new LineSegments2(new LineSegmentsGeometry().setPositions(positions), material)
        line.computeLineDistances()
        return line
      }

      // Destination silhouettes show where staged cargo will eventually rest.
      const byMission = new Map<string, PlacedBox[]>()
      for (const d of plan.deferred) {
        const group = byMission.get(d.missionId)
        if (group) group.push(d)
        else byMission.set(d.missionId, [d])
      }
      for (const [missionId, group] of byMission) {
        const color = new THREE.Color(
          missionColorFor?.(missionId) ?? colorByMission.get(missionId) ?? '#888888',
        )
        const surface = unionSurfaceGeometry(group, ox, oz)
        // Union surface avoids double-thick translucent overlaps.
        s.cargo.add(
          new THREE.Mesh(
            surface,
            new THREE.MeshBasicMaterial({
              color,
              transparent: true,
              opacity: 0.135,
              depthWrite: false,
            }),
          ),
        )
        const material = new LineMaterial({
          color: color.getHex(),
          linewidth: 2,
          dashed: true,
          dashSize: 0.22,
          gapSize: 0.14,
          transparent: true,
          opacity: 0.75,
        })
        material.resolution.copy(size)
        s.deferredLineMaterials.push(material)
        const edges = new THREE.EdgesGeometry(surface, 10)
        const outline = new LineSegments2(new LineSegmentsGeometry().fromEdgesGeometry(edges), material)
        edges.dispose()
        outline.computeLineDistances()
        s.cargo.add(outline)
      }

      // Staged cargo joins hover/tooltip/spotlight, but not drag placement.
      const staged = [...plan.deferred].sort((a, b) => a.missionId.localeCompare(b.missionId))
      const gap = 0.35
      const rowMaxWidth = Math.max(X, 8)
      let cursorX = 0
      let rowZ = 0
      let rowDepth = 0
      let padW = 0
      let padD = 0
      const padZ0 = oz + Y + 2.2
      for (const d of staged) {
        const [bx, by, bz] = d.dims
        if (cursorX > 0 && cursorX + bx > rowMaxWidth) {
          rowZ += rowDepth + gap
          cursorX = 0
          rowDepth = 0
        }
        const colorCss = missionColorFor?.(d.missionId) ?? colorByMission.get(d.missionId) ?? '#888888'
        const materials = createContainerMaterials({
          style: boxStyle,
          cells: { w: bx, h: bz, d: by },
          scu: d.scu,
          color: colorCss,
          anisotropy,
        })
        const mesh = new THREE.Mesh(new THREE.BoxGeometry(bx, bz, by), materials) as unknown as CargoMesh
        mesh.castShadow = true
        mesh.receiveShadow = true
        mesh.position.set(ox + cursorX + bx / 2, bz / 2, padZ0 + rowZ + by / 2)
        mesh.userData = {
          kind: 'cargo-box',
          boxId: d.id,
          missionId: d.missionId,
          commodity: d.commodity,
          scu: d.scu,
          dims: d.dims,
          baseColor: new THREE.Color(colorCss),
          style: boxStyle,
          deliverStop: d.deliverStop,
        }
        s.cargo.add(mesh)
        s.boxes.push(mesh)
        padW = Math.max(padW, cursorX + bx)
        padD = Math.max(padD, rowZ + by)
        cursorX += bx + gap
        rowDepth = Math.max(rowDepth, by)
      }
      // Neutral pad outline under staged cargo.
      const m = 0.35
      const x0 = ox - m
      const x1 = ox + padW + m
      const z0 = padZ0 - m
      const z1 = padZ0 + padD + m
      const y = 0.02
      s.cargo.add(
        dashedLine(
          [x0, y, z0, x1, y, z0, x1, y, z0, x1, y, z1, x1, y, z1, x0, y, z1, x0, y, z1, x0, y, z0],
          0x93a7c9,
          0.55,
        ),
      )
    }

    fitShadowFrustum(s)
    if (gridChanged) applyCameraView(s, s.currentView)
    applyBoxVisualState(s, focusedMissionRef.current, hoveredBoxRef.current, draggingBoxRef.current, spotlightRef.current)
    s.render()
  }, [plan, placements, missionColorFor, boxStyle, ghostBoxes, hazardIds])

  const setView = (view: ViewPreset) => {
    setActiveView(view)
    const s = sceneRef.current
    if (!s) return
    // The camera jump invalidates the hover: without a pointermove the tooltip
    // would stay pinned at its old position describing a box no longer there.
    hoveredBoxRef.current = null
    s.xrayIds = EMPTY_ID_SET
    setHover(null)
    applyBoxVisualState(s, focusedMissionRef.current, null, draggingBoxRef.current, spotlightRef.current)
    applyCameraView(s, view)
  }

  const resetLayout = () => {
    hoveredBoxRef.current = null
    draggingBoxRef.current = null
    dragStateRef.current = null
    setHover(null)
    setPlacements(createOptimalPlacements(plan))
  }

  return (
    <div
      className="cargo3d"
      onPointerEnter={() => (pointerOverRef.current = true)}
      onPointerLeave={() => (pointerOverRef.current = false)}
      ref={rootRef}
    >
      <div className="cargo3d-toolbar" aria-label="Cargo view controls">
        {VIEW_PRESETS.map((view) => (
          <button
            className={`cargo3d-view-btn ${activeView === view.id ? 'active' : ''}`}
            key={view.id}
            onClick={() => setView(view.id)}
            type="button"
          >
            {view.label}
          </button>
        ))}
        <span aria-hidden="true" className="cargo3d-toolbar-sep" />
        <select
          className="cargo3d-style-select"
          onChange={(e) => changeBoxStyle(e.target.value as ContainerStyle)}
          title="Container style"
          value={boxStyle}
        >
          {CONTAINER_STYLE_OPTIONS.map((style) => (
            <option key={style.id} value={style.id}>
              {style.label}
            </option>
          ))}
        </select>
        <button className="cargo3d-reset-btn" onClick={resetLayout} type="button">
          Reset
        </button>
      </div>
      <div className="cargo3d-canvas" ref={mountRef} />
      <div
        ref={perfHudRef}
        aria-hidden="true"
        style={{
          position: 'absolute',
          top: 10,
          left: 12,
          zIndex: 4,
          font: '11px/1.5 ui-monospace, "Cascadia Code", monospace',
          color: '#a9c6ff',
          whiteSpace: 'pre',
          letterSpacing: '0.02em',
          // No panel — a soft shadow keeps the text legible whether it floats
          // over the dark void or a bright cargo face.
          textShadow: '0 1px 3px rgba(0, 0, 0, 0.85), 0 0 2px rgba(0, 0, 0, 0.7)',
          pointerEvents: 'none',
          userSelect: 'none',
        }}
      />
      {(digWarning || deferredNote) && (
        <div className="cargo3d-notices">
          {digWarning && (
            <div className="cargo3d-warning" role="alert">
              ⚠ {digWarning}
            </div>
          )}
          {deferredNote && <div className="cargo3d-info">ⓘ {deferredNote}</div>}
        </div>
      )}
      {stepper && onStep && (
        <div className="cargo3d-stepper" aria-label="Route step controls">
          <button
            className="cargo3d-step-btn"
            disabled={stepper.index <= 0}
            onClick={() => onStep(-1)}
            title="Previous step (←)"
            type="button"
          >
            ‹
          </button>
          <div className="cargo3d-step-text">
            <span className="cargo3d-step-count">
              Step {stepper.index} / {stepper.total}
            </span>
            <span className="cargo3d-step-label">
              {stepper.color && (
                <span className="cargo3d-step-dot" style={{ background: stepper.color }} />
              )}
              {stepper.label}
            </span>
          </div>
          <button
            className="cargo3d-step-btn"
            disabled={stepper.index >= stepper.total}
            onClick={() => onStep(1)}
            title="Next step (→)"
            type="button"
          >
            ›
          </button>
        </div>
      )}
      {hover && (
        <div
          ref={tooltipRef}
          className="cargo3d-tooltip"
          style={{ left: tooltipPosRef.current.x, top: tooltipPosRef.current.y }}
        >
          <strong>{hover.commodity}</strong>
          <span>{hover.mission}</span>
          <span>
            {hover.scu} SCU · {hover.dims[0]} x {hover.dims[1]} x {hover.dims[2]}
          </span>
          <span className={hover.blockers ? 'cargo3d-tooltip-blocked' : 'cargo3d-tooltip-clear'}>
            {hover.blockers
              ? `blocked by ${hover.blockers} box${hover.blockers > 1 ? 'es' : ''}`
              : 'clear to extract'}
          </span>
        </div>
      )}
    </div>
  )
}

/** Key-light direction stays fixed while the light position fits each scene. */
const KEY_LIGHT_DIR = new THREE.Vector3(6, 11, 7).normalize()

/** Fit the key-light shadow frustum to the current cargo bounds. */
function fitShadowFrustum(refs: SceneRefs) {
  const bounds = new THREE.Box3().setFromObject(refs.cargo)
  if (bounds.isEmpty()) return
  const sphere = bounds.getBoundingSphere(new THREE.Sphere())
  const radius = sphere.radius + 0.5
  const light = refs.keyLight
  light.target.position.copy(sphere.center)
  light.position.copy(sphere.center).addScaledVector(KEY_LIGHT_DIR, radius * 2)
  const cam = light.shadow.camera
  cam.left = -radius
  cam.right = radius
  cam.top = radius
  cam.bottom = -radius
  // Content lies within [distance - r, distance + r] along the light axis.
  cam.near = radius
  cam.far = radius * 3
  cam.updateProjectionMatrix()
}

/** Axis-view margins account for canvas overlays. */
const FIT_MARGIN_W = 1.08
const FIT_MARGIN_V = 1.3

/** Camera distance that frames projected extents for an axis view. */
function fitAxisViewDistance(refs: SceneRefs, view: 'top' | 'front' | 'side', center: THREE.Vector3): number {
  const bounds = new THREE.Box3().setFromObject(refs.cargo)
  if (bounds.isEmpty()) {
    const [X, Y, Z] = refs.currentGrid
    bounds.set(new THREE.Vector3(-X / 2, 0, -Y / 2), new THREE.Vector3(X / 2, Z, Y / 2))
  }
  // fwd points from target to camera; right/up span the screen plane.
  const frames: Record<'top' | 'front' | 'side', [THREE.Vector3, THREE.Vector3, THREE.Vector3]> = {
    top: [new THREE.Vector3(0, 1, 0), new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 0, 1)],
    front: [new THREE.Vector3(0, 0, 1), new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 1, 0)],
    side: [new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 0, 1), new THREE.Vector3(0, 1, 0)],
  }
  // Front follows the longer horizontal axis; keep in lockstep with applyCameraView.
  const foreAftX = refs.currentGrid[0] > refs.currentGrid[1]
  const key = foreAftX && view === 'front' ? 'side' : foreAftX && view === 'side' ? 'front' : view
  const [fwd, right, up] = frames[key]
  const tanHalfV = Math.tan((refs.camera.fov * Math.PI) / 360)
  const tanHalfW = tanHalfV * refs.camera.aspect
  const corner = new THREE.Vector3()
  let distance = refs.controls.minDistance
  for (let i = 0; i < 8; i++) {
    corner.set(
      i & 1 ? bounds.max.x : bounds.min.x,
      i & 2 ? bounds.max.y : bounds.min.y,
      i & 4 ? bounds.max.z : bounds.min.z,
    ).sub(center)
    const need = Math.max(
      (Math.abs(corner.dot(up)) * FIT_MARGIN_V) / tanHalfV,
      (Math.abs(corner.dot(right)) * FIT_MARGIN_W) / tanHalfW,
    )
    distance = Math.max(distance, corner.dot(fwd) + need)
  }
  return distance
}

function applyCameraView(refs: SceneRefs, view: ViewPreset) {
  const [X, Y, Z] = refs.currentGrid
  const center = new THREE.Vector3(0, Math.max(0.75, Z / 2), 0)
  const distance =
    view === 'iso' ? Math.max(X, Y, Z, 8) * 1.62 : fitAxisViewDistance(refs, view, center)
  // Keep this direction swap in lockstep with fitAxisViewDistance.
  const foreAftX = X > Y
  const directions: Record<ViewPreset, THREE.Vector3> = {
    iso: new THREE.Vector3(0.86, 0.72, 1.08),
    top: new THREE.Vector3(0, 1, TOP_VIEW_EPSILON),
    front: foreAftX ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 0, 1),
    side: foreAftX ? new THREE.Vector3(0, 0, 1) : new THREE.Vector3(1, 0, 0),
  }
  const upVectors: Record<ViewPreset, THREE.Vector3> = {
    iso: new THREE.Vector3(0, 1, 0),
    top: new THREE.Vector3(0, 1, 0),
    front: new THREE.Vector3(0, 1, 0),
    side: new THREE.Vector3(0, 1, 0),
  }
  refs.currentView = view
  refs.camera.up.copy(upVectors[view])
  refs.camera.position.copy(center).add(directions[view].normalize().multiplyScalar(distance))
  refs.camera.near = Math.max(0.05, distance / 80)
  refs.camera.far = distance * 5
  refs.camera.updateProjectionMatrix()
  refs.camera.lookAt(center)
  refs.controls.target.copy(center)
  refs.controls.enabled = true
  refs.renderer.domElement.style.cursor = ''
  // Custom grids can exceed the stock zoom limit.
  refs.controls.maxDistance = Math.max(36, distance * 1.25)
  refs.controls.update()
  refs.render()
}

function applyBoxVisualState(
  refs: SceneRefs | null,
  focusedMissionId: string | null,
  hoveredBoxId: string | null,
  draggingBoxId: string | null,
  spotlight: UnloadSpotlight | null,
) {
  if (!refs) return
  for (const box of refs.boxes) {
    const boxId = box.userData.boxId
    // Same-stop unload cargo stays visible; only cargo continuing onward dims.
    const isSameStopUnload = !!spotlight && box.userData.deliverStop === spotlight.stopIndex
    const isSpotlit = isSameStopUnload && box.userData.missionId === spotlight.missionId
    // Legend focus wins over automatic unload spotlighting.
    const isFocused = focusedMissionId
      ? box.userData.missionId === focusedMissionId
      : spotlight
        ? isSameStopUnload
        : true
    const isHovered = boxId === hoveredBoxId
    const isDragging = boxId === draggingBoxId
    const step = isDragging ? 2 : isHovered ? 1 : isSpotlit && !focusedMissionId ? 1 : 0
    // Warning tints outrank focus/hover dimming.
    const tint: BoxTint = isDragging
      ? 'none'
      : refs.hazardIds.has(boxId)
        ? 'hazard'
        : refs.xrayIds.has(boxId)
          ? 'xray'
          : 'none'
    applyBoxMaterials(box, isFocused || tint !== 'none', step, tint)
    // No scale pop: flush-tiled boxes would clip into neighbors.
  }
  refs.render()
}

/** Apply one visual ladder step: idle, hover, or drag/valid-preview. */
function applyBoxMaterials(box: CargoMesh, isFocused: boolean, step: 0 | 1 | 2, tint: BoxTint = 'none') {
  const { style, baseColor } = box.userData
  const strength = EMISSIVE_LADDER[style][step]
  const tintColor = tint === 'hazard' ? HAZARD_TINT : tint === 'xray' ? XRAY_TINT : null
  for (const material of box.material) {
    if (tintColor) {
      if (style === 'ion') {
        // Glow linework carries the warning hue.
        material.color.set(tint === 'hazard' ? 0xb0685f : 0xa9945f)
        if (material.emissiveMap) material.emissive.copy(tintColor).multiplyScalar(1.2 + strength * 0.2)
      } else {
        material.color.copy(baseColor).lerp(tintColor, 0.72)
        material.emissive.copy(tintColor).multiplyScalar(0.08 + strength * 0.4)
      }
    } else if (style === 'cell') {
      material.color.copy(baseColor)
      material.emissive.copy(baseColor).multiplyScalar(strength)
    } else if (style === 'lid') {
      material.color.set(0xffffff)
      material.emissive.setScalar(strength)
    } else {
      // Ion's bottom face has no emissive map and stays dark.
      material.color.set(0xffffff)
      if (material.emissiveMap)
        material.emissive
          .copy(baseColor)
          .multiplyScalar(strength * (isFocused ? 1 : ION_DIM_GLOW_BOOST))
    }
    // Recompile only when transparent actually flips.
    const nextTransparent = !isFocused
    if (material.transparent !== nextTransparent) {
      material.transparent = nextTransparent
      material.needsUpdate = true
    }
    material.opacity = isFocused ? 1 : DIM_OPACITY[style]
    // Dimmed transparent boxes must not depth-cull boxes behind them.
    material.depthWrite = isFocused
  }
}

function createOptimalPlacements(plan: LoadoutPlan): BoxPlacement[] {
  return plan.boxes.map((box) => ({
    id: box.id,
    gridPos: [...box.pos],
    offGrid: false,
    dims: [...box.dims],
  }))
}

function reconcilePlacements(current: BoxPlacement[], plan: LoadoutPlan): BoxPlacement[] {
  const currentById = new Map(current.map((placement) => [placement.id, placement]))
  const boxById = createBoxMap(plan)
  const next: BoxPlacement[] = []
  // Fallback parking row sits opposite the deferred staging pad.
  let parkCursor = 0

  for (const box of plan.boxes) {
    const optimal: BoxPlacement = {
      id: box.id,
      gridPos: [...box.pos],
      offGrid: false,
      dims: [...box.dims],
    }
    const previous = currentById.get(box.id)
    const preserved = previous
      ? {
          id: previous.id,
          gridPos: [...previous.gridPos] as [number, number, number],
          offGrid: previous.offGrid,
          worldPosition: previous.worldPosition ? ([...previous.worldPosition] as [number, number]) : undefined,
          dims: [...previous.dims] as [number, number, number],
        }
      : null

    if (preserved && canUsePlacement(preserved, box, plan, next, boxById)) {
      next.push(preserved)
    } else if (canUsePlacement(optimal, box, plan, next, boxById)) {
      next.push(optimal)
    } else {
      // Do not force invalid boxes into the grid; park them for manual recovery.
      const [bx, by] = box.dims
      next.push({
        id: box.id,
        gridPos: [...box.pos],
        offGrid: true,
        worldPosition: [-plan.grid[0] / 2 + parkCursor + bx / 2, -plan.grid[1] / 2 - 2.2 - by / 2],
        dims: [...box.dims],
      })
      parkCursor += bx + 0.35
    }
  }

  // Preserve reference equality when nothing changed.
  if (next.length === current.length && next.every((p, i) => samePlacement(p, current[i]))) {
    return current
  }
  return next
}

function samePlacement(a: BoxPlacement, b: BoxPlacement): boolean {
  return (
    a.id === b.id &&
    a.offGrid === b.offGrid &&
    a.gridPos[0] === b.gridPos[0] && a.gridPos[1] === b.gridPos[1] && a.gridPos[2] === b.gridPos[2] &&
    a.dims[0] === b.dims[0] && a.dims[1] === b.dims[1] && a.dims[2] === b.dims[2] &&
    (a.worldPosition?.[0] === b.worldPosition?.[0]) && (a.worldPosition?.[1] === b.worldPosition?.[1])
  )
}

function createBoxMap(plan: LoadoutPlan): Map<string, PlacedBox> {
  return new Map(plan.boxes.map((box) => [box.id, box]))
}

function canUsePlacement(
  placement: BoxPlacement,
  box: PlacedBox,
  plan: LoadoutPlan,
  accepted: BoxPlacement[],
  boxById: Map<string, PlacedBox>,
) {
  if (!sameBoxShape(placement.dims, box.dims)) return false
  if (placement.offGrid) return true

  const [x, y, z] = placement.gridPos
  const [w, d, h] = placement.dims
  const [gridX, gridY, gridZ] = plan.grid
  if (x < 0 || y < 0 || z < 0 || x + w > gridX || y + d > gridY || z + h > gridZ) return false
  const insideBay = plan.compartments.some(
    (c) =>
      compartmentAllowsBox(c, box.scu) &&
      x >= c.offset[0] && x + w <= c.offset[0] + c.dims[0] &&
      y >= c.offset[1] && y + d <= c.offset[1] + c.dims[1] &&
      z >= c.offset[2] && z + h <= c.offset[2] + c.dims[2],
  )
  if (!insideBay) return false

  const occupied = (cx: number, cy: number, cz: number) => {
    for (const p of accepted) {
      if (p.offGrid) continue
      if (!boxById.has(p.id)) continue
      const [pw, pd, ph] = p.dims
      if (
        cx >= p.gridPos[0] && cx < p.gridPos[0] + pw &&
        cy >= p.gridPos[1] && cy < p.gridPos[1] + pd &&
        cz >= p.gridPos[2] && cz < p.gridPos[2] + ph
      )
        return true
    }
    return false
  }

  for (let cz = z; cz < z + h; cz++)
    for (let cy = y; cy < y + d; cy++)
      for (let cx = x; cx < x + w; cx++)
        if (occupied(cx, cy, cz)) return false

  if (z === 0) return true
  for (let cy = y; cy < y + d; cy++)
    for (let cx = x; cx < x + w; cx++)
      if (!occupied(cx, cy, z - 1)) return false

  return true
}

function sameBoxShape(a: [number, number, number], b: [number, number, number]) {
  return a[2] === b[2] && ((a[0] === b[0] && a[1] === b[1]) || (a[0] === b[1] && a[1] === b[0]))
}

function sameGrid(a: [number, number, number], b: [number, number, number]) {
  return a[0] === b[0] && a[1] === b[1] && a[2] === b[2]
}

function applyMeshPlacement(
  mesh: CargoMesh,
  placement: BoxPlacement,
  grid: [number, number, number],
) {
  const [gridX, gridY] = grid
  const [bx, by, bz] = placement.dims
  if (placement.offGrid) {
    const [x, z] = placement.worldPosition ?? [mesh.position.x, mesh.position.z]
    mesh.position.set(x, bz / 2, z)
    return
  }

  const ox = -gridX / 2
  const oz = -gridY / 2
  mesh.position.set(
    ox + placement.gridPos[0] + bx / 2,
    placement.gridPos[2] + bz / 2,
    oz + placement.gridPos[1] + by / 2,
  )
}

function intersectFloor(refs: SceneRefs) {
  const hit = new THREE.Vector3()
  return refs.raycaster.ray.intersectPlane(refs.floorPlane, hit)
}

function moveDraggedBox(
  refs: SceneRefs,
  drag: DragState,
  placements: BoxPlacement[],
  boxById: Map<string, PlacedBox>,
) {
  const box = boxById.get(drag.boxId)
  const floorPoint = intersectFloor(refs)
  if (!box || !floorPoint) return

  const desiredCenter = floorPoint.clone().sub(drag.grabOffset)
  const candidate = placementCandidateFromWorld(
    drag.boxId,
    desiredCenter,
    drag.heightCell,
    drag.dims,
    refs.currentGrid,
    refs.currentCompartments,
    placements,
    boxById,
  )
  drag.candidate = candidate

  if (candidate.mode === 'grid') {
    const preview: BoxPlacement = { id: drag.boxId, gridPos: candidate.pos, offGrid: false, dims: drag.dims }
    applyMeshPlacement(drag.mesh, preview, refs.currentGrid)
    setDragPreviewVisual(drag.mesh, candidate.valid)
  } else {
    drag.mesh.position.set(desiredCenter.x, drag.dims[2] / 2, desiredCenter.z)
    setDragPreviewVisual(drag.mesh, true)
  }
  refs.render()
}

function placementCandidateFromWorld(
  boxId: string,
  center: THREE.Vector3,
  heightCell: number,
  dims: [number, number, number],
  grid: [number, number, number],
  compartments: Compartment[],
  placements: BoxPlacement[],
  boxById: Map<string, PlacedBox>,
): DragCandidate {
  // Snap from the box center and footprint, not the raw cursor.
  const boxScu = boxById.get(boxId)?.scu ?? dims[0] * dims[1] * dims[2]
  const snap = resolveBoxCell(center.x, center.z, dims, boxScu, compartments, grid, heightCell)
  if (!snap.inGrid) {
    return { mode: 'offgrid', worldPosition: [center.x, center.z], valid: true }
  }
  // Rest on the highest fully supported surface under the footprint.
  const { z, valid } = gravityDrop(boxId, snap.pos[0], snap.pos[1], dims, grid, placements, boxById)
  // The footprint must fit inside one bay, not spill into a gap.
  const insideBay = compartments.some(
    (c) =>
      compartmentAllowsBox(c, boxScu) &&
      snap.pos[0] >= c.offset[0] && snap.pos[0] + dims[0] <= c.offset[0] + c.dims[0] &&
      snap.pos[1] >= c.offset[1] && snap.pos[1] + dims[1] <= c.offset[1] + c.dims[1],
  )
  return { mode: 'grid', pos: [snap.pos[0], snap.pos[1], z], valid: valid && insideBay }
}

// Per-drag occupancy cache: gravityDrop runs on every pointer move.
let occCache: {
  placements: BoxPlacement[]
  boxId: string
  gx: number
  gy: number
  gz: number
  data: Uint8Array
} | null = null

function occupancyExcluding(
  boxId: string,
  grid: [number, number, number],
  placements: BoxPlacement[],
  boxById: Map<string, PlacedBox>,
): Uint8Array {
  const [gx, gy, gz] = grid
  const c = occCache
  if (c && c.placements === placements && c.boxId === boxId && c.gx === gx && c.gy === gy && c.gz === gz) {
    return c.data
  }
  const data = new Uint8Array(gx * gy * gz)
  for (const p of placements) {
    if (p.id === boxId || p.offGrid || !boxById.has(p.id)) continue
    const [pw, pd, ph] = p.dims
    const x1 = Math.min(gx, p.gridPos[0] + pw)
    const y1 = Math.min(gy, p.gridPos[1] + pd)
    const z1 = Math.min(gz, p.gridPos[2] + ph)
    for (let cz = Math.max(0, p.gridPos[2]); cz < z1; cz++)
      for (let cy = Math.max(0, p.gridPos[1]); cy < y1; cy++)
        for (let cx = Math.max(0, p.gridPos[0]); cx < x1; cx++)
          data[cx + cy * gx + cz * gx * gy] = 1
  }
  occCache = { placements, boxId, gx, gy, gz, data }
  return data
}

function gravityDrop(
  boxId: string,
  x: number,
  y: number,
  dims: [number, number, number],
  grid: [number, number, number],
  placements: BoxPlacement[],
  boxById: Map<string, PlacedBox>,
): { z: number; valid: boolean } {
  const [w, d, h] = dims
  const [gridX, gridY, gridZ] = grid
  const filled = occupancyExcluding(boxId, grid, placements, boxById)
  const occ = (cx: number, cy: number, cz: number): boolean =>
    cx >= 0 && cy >= 0 && cz >= 0 && cx < gridX && cy < gridY && cz < gridZ &&
    filled[cx + cy * gridX + cz * gridX * gridY] === 1
  // Highest filled surface under any cell of the footprint.
  let restZ = 0
  for (let cx = x; cx < x + w; cx++)
    for (let cy = y; cy < y + d; cy++) {
      let s = 0
      while (s < gridZ && occ(cx, cy, s)) s++
      if (s > restZ) restZ = s
    }
  if (restZ + h > gridZ) return { z: restZ, valid: false }
  // Clear above and fully supported below.
  for (let cx = x; cx < x + w; cx++)
    for (let cy = y; cy < y + d; cy++) {
      if (restZ > 0 && !occ(cx, cy, restZ - 1)) return { z: restZ, valid: false }
      for (let cz = restZ; cz < restZ + h; cz++)
        if (occ(cx, cy, cz)) return { z: restZ, valid: false }
    }
  return { z: restZ, valid: true }
}

function setMeshGeometry(mesh: CargoMesh, dims: [number, number, number]) {
  const [bx, by, bz] = dims
  mesh.geometry.dispose()
  mesh.geometry = new THREE.BoxGeometry(bx, bz, by)
  // Rotation changes face cell counts, so swap to matching cached textures.
  for (const material of mesh.material) material.dispose()
  mesh.material = createContainerMaterials({
    style: mesh.userData.style,
    cells: { w: bx, h: bz, d: by },
    scu: mesh.userData.scu,
    color: `#${mesh.userData.baseColor.getHexString()}`,
  })
  mesh.userData.dims = dims
}

function hasBoxOnTop(
  boxId: string,
  pos: [number, number, number],
  dims: [number, number, number],
  placements: BoxPlacement[],
  boxById: Map<string, PlacedBox>,
): boolean {
  const topZ = pos[2] + dims[2]
  for (const p of placements) {
    if (p.id === boxId || p.offGrid) continue
    const o = boxById.get(p.id)
    if (!o || p.gridPos[2] !== topZ) continue
    const [pw, pd] = p.dims
    if (
      pos[0] < p.gridPos[0] + pw && pos[0] + dims[0] > p.gridPos[0] &&
      pos[1] < p.gridPos[1] + pd && pos[1] + dims[1] > p.gridPos[1]
    )
      return true
  }
  return false
}

function setDragPreviewVisual(mesh: CargoMesh, valid: boolean) {
  if (valid) {
    applyBoxMaterials(mesh, true, 2)
    return
  }
  const invalid = new THREE.Color(0xe2574a)
  for (const material of mesh.material) {
    if (mesh.userData.style === 'ion') {
      // Ion warning hue lives in the glow linework.
      material.color.set(0xb0685f)
      if (material.emissiveMap) material.emissive.copy(invalid).multiplyScalar(1.5)
    } else {
      material.color.copy(invalid)
      material.emissive.copy(invalid).multiplyScalar(0.08)
    }
  }
}

function createFloorGlowTexture() {
  const size = 256
  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size
  const ctx = canvas.getContext('2d')!
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2)
  g.addColorStop(0, 'rgba(96, 124, 176, 0.30)')
  g.addColorStop(0.45, 'rgba(80, 102, 148, 0.12)')
  g.addColorStop(1, 'rgba(80, 102, 148, 0)')
  ctx.fillStyle = g
  ctx.fillRect(0, 0, size, size)
  const tex = new THREE.CanvasTexture(canvas)
  tex.colorSpace = THREE.SRGBColorSpace
  return tex
}

function createFloorPlate(width: number, depth: number) {
  const group = new THREE.Group()
  const plate = new THREE.Mesh(
    new THREE.PlaneGeometry(width + 0.65, depth + 0.65),
    new THREE.ShadowMaterial({ color: 0x05070b, opacity: 0.2 }),
  )
  plate.rotation.x = -Math.PI / 2
  plate.position.y = -0.025
  plate.receiveShadow = true
  group.add(plate)

  const bevel = new THREE.LineSegments(
    new THREE.EdgesGeometry(new THREE.BoxGeometry(width + 0.22, 0.08, depth + 0.22)),
    new THREE.LineBasicMaterial({ color: 0x3e4654, transparent: true, opacity: 0.46 }),
  )
  bevel.position.y = -0.045
  group.add(bevel)
  return group
}

function createGridLines(width: number, depth: number, ox: number, oz: number) {
  const points: number[] = []
  for (let x = 0; x <= width; x++) {
    points.push(ox + x, 0.012, oz, ox + x, 0.012, oz + depth)
  }
  for (let z = 0; z <= depth; z++) {
    points.push(ox, 0.012, oz + z, ox + width, 0.012, oz + z)
  }
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(points, 3))
  return new THREE.LineSegments(
    geometry,
    new THREE.LineBasicMaterial({ color: 0x566071, transparent: true, opacity: 0.38 }),
  )
}

function createCargoHull(compartment: Compartment) {
  const [width, depth, height] = compartment.dims
  const group = new THREE.Group()
  const hullGeo = new THREE.BoxGeometry(width, height, depth)
  const shell = new THREE.Mesh(
    hullGeo,
    new THREE.MeshBasicMaterial({
      color: 0x9aa7bd,
      transparent: true,
      opacity: 0.035,
      depthWrite: false,
      side: THREE.BackSide,
    }),
  )
  shell.position.y = height / 2
  group.add(shell)

  const edges = new THREE.LineSegments(
    new THREE.EdgesGeometry(new THREE.BoxGeometry(width, height, depth)),
    new THREE.LineBasicMaterial({ color: 0x8792a6, transparent: true, opacity: 0.64 }),
  )
  edges.position.y = height / 2
  group.add(edges)
  group.add(createOpeningGlyph(compartment))
  return group
}

/** Marks the compartment opening used by the dig-free extraction model. */
function createOpeningGlyph(compartment: Compartment) {
  const [width, depth, height] = compartment.dims
  const opening = compartmentOpening(compartment)
  const group = new THREE.Group()
  const points: number[] = []

  if (opening === 'top') {
    const y = height + 0.02
    const arm = Math.min(0.6, Math.min(width, depth) * 0.25)
    const inX = width / 2 - 0.08
    const inZ = depth / 2 - 0.08
    for (const sx of [-1, 1]) {
      for (const sz of [-1, 1]) {
        points.push(sx * inX, y, sz * inZ, sx * (inX - arm), y, sz * inZ)
        points.push(sx * inX, y, sz * inZ, sx * inX, y, sz * (inZ - arm))
      }
    }
  } else {
    // Grid Y maps to world z.
    const dx = opening === '+x' ? 1 : opening === '-x' ? -1 : 0
    const dz = opening === '+y' ? 1 : opening === '-y' ? -1 : 0
    const half = dx !== 0 ? width / 2 : depth / 2
    const lateral = Math.min(1.1, (dx !== 0 ? depth : width) * 0.3)
    const y = 0.02
    const at = (t: number, l: number): [number, number, number] =>
      dx !== 0 ? [dx * t, y, l] : [l, y, dz * t]
    for (let k = 0; k < 2; k++) {
      const tip = half + 0.55 + k * 0.55
      const back = tip - 0.4
      points.push(...at(back, -lateral), ...at(tip, 0))
      points.push(...at(back, lateral), ...at(tip, 0))
    }

    // Door-face frame.
    const framePoints: number[] = []
    const lx = (dx !== 0 ? depth : width) / 2 - 0.08
    const face = (l: number, yy: number): [number, number, number] =>
      dx !== 0 ? [dx * (half + 0.015), yy, l] : [l, yy, dz * (half + 0.015)]
    const yLo = 0.06
    const yHi = height - 0.06
    framePoints.push(...face(-lx, yLo), ...face(lx, yLo))
    framePoints.push(...face(lx, yLo), ...face(lx, yHi))
    framePoints.push(...face(lx, yHi), ...face(-lx, yHi))
    framePoints.push(...face(-lx, yHi), ...face(-lx, yLo))
    const frameGeometry = new THREE.BufferGeometry()
    frameGeometry.setAttribute('position', new THREE.Float32BufferAttribute(framePoints, 3))
    group.add(
      new THREE.LineSegments(
        frameGeometry,
        new THREE.LineBasicMaterial({ color: 0xa8c2ea, transparent: true, opacity: 0.55 }),
      ),
    )
  }

  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(points, 3))
  group.add(
    new THREE.LineSegments(
      geometry,
      new THREE.LineBasicMaterial({ color: 0xa8c2ea, transparent: true, opacity: 0.6 }),
    ),
  )
  return group
}


