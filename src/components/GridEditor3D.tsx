// Ship cargo-grid editor. Users author rectangular bays and the extraction face
// that feeds the hard-LIFO oracle; the saved grid overrides built-in geometry.

import { useEffect, useMemo, useRef, useState } from 'react'
import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import type { Ship } from '../domain/types'
import {
  type Compartment, type OpeningFace,
  compartmentOpening, withOpening, gridBounds,
} from '../ships/grids'
import { gridFileName, parseGridFile, serializeGrid } from '../ships/gridExchange'
import { cloneBay, duplicateBay, duplicateLayout, freeSpotFor } from './gridEditorOps'
import { disposeObject } from './threeUtils'

interface Props {
  ship: Ship
  initial: Compartment[]
  builtin: Compartment[] | null
  onSave: (compartments: Compartment[]) => void
  onClose: () => void
}

const OPENING_FACES: { id: OpeningFace; label: string }[] = [
  { id: 'top', label: 'Top ↑' },
  { id: '+x', label: '+X' },
  { id: '-x', label: '−X' },
  { id: '+y', label: '+Y' },
  { id: '-y', label: '−Y' },
]

const SELECTED_COLOR = 0x5b8cff
const BAY_COLOR = 0x8792a6
const DOOR_COLOR = 0x46c08a

const clone = (comps: Compartment[]): Compartment[] => comps.map((c) => ({ ...c, offset: [...c.offset], dims: [...c.dims] }))
const newBay = (): Compartment => ({ offset: [0, 0, 0], dims: [4, 4, 2] })
const bayScu = (c: Compartment) => c.dims[0] * c.dims[1] * c.dims[2]

/** Overlapping bays are invalid authoring input. */
function baysOverlap(a: Compartment, b: Compartment): boolean {
  return (
    a.offset[0] < b.offset[0] + b.dims[0] && b.offset[0] < a.offset[0] + a.dims[0] &&
    a.offset[1] < b.offset[1] + b.dims[1] && b.offset[1] < a.offset[1] + a.dims[1] &&
    a.offset[2] < b.offset[2] + b.dims[2] && b.offset[2] < a.offset[2] + a.dims[2]
  )
}

interface Refs {
  renderer: THREE.WebGLRenderer
  scene: THREE.Scene
  camera: THREE.PerspectiveCamera
  controls: OrbitControls
  holds: THREE.Group
  raycaster: THREE.Raycaster
  pointer: THREE.Vector2
  picks: THREE.Mesh[]
  bounds: [number, number, number]
  render: () => void
}

export function GridEditor3D({ ship, initial, builtin, onSave, onClose }: Props) {
  const [comps, setComps] = useState<Compartment[]>(() => clone(initial))
  const [sel, setSel] = useState<number>(initial.length ? 0 : -1)
  const [ioStatus, setIoStatus] = useState<{ warn: boolean; text: string } | null>(null)
  // Freeze bounds during drag so auto-centering cannot pull the bay from the cursor.
  const [dragFreeze, setDragFreeze] = useState<[number, number, number] | null>(null)
  const mountRef = useRef<HTMLDivElement>(null)
  const importInputRef = useRef<HTMLInputElement>(null)
  const refsRef = useRef<Refs | null>(null)
  const selectRef = useRef<(i: number) => void>(() => {})
  const compsRef = useRef<Compartment[]>([])
  const moveBayRef = useRef<(i: number, offset: [number, number, number]) => void>(() => {})
  const freezeRef = useRef<(b: [number, number, number] | null) => void>(() => {})

  const liveBounds = useMemo<[number, number, number]>(() => {
    if (!comps.length) return [8, 8, 3]
    const [x, y, z] = gridBounds(comps)
    return [Math.max(x, 4), Math.max(y, 4), Math.max(z, 2)]
  }, [comps])
  const bounds = dragFreeze ?? liveBounds

  const capacity = comps.reduce((a, c) => a + bayScu(c), 0)
  const overlaps = useMemo(() => {
    const bad = new Set<number>()
    for (let i = 0; i < comps.length; i++)
      for (let j = i + 1; j < comps.length; j++)
        if (baysOverlap(comps[i], comps[j])) { bad.add(i); bad.add(j) }
    return bad
  }, [comps])

  useEffect(() => { selectRef.current = setSel }, [])
  useEffect(() => { compsRef.current = comps }, [comps])
  useEffect(() => {
    moveBayRef.current = (i, offset) =>
      setComps((cur) => cur.map((c, k) => (k === i ? { ...c, offset } : c)))
    freezeRef.current = setDragFreeze
  }, [])

  // One Three scene, rendered on demand.
  useEffect(() => {
    const mount = mountRef.current
    if (!mount) return
    const w = mount.clientWidth || 600
    const h = mount.clientHeight || 420

    const scene = new THREE.Scene()
    const camera = new THREE.PerspectiveCamera(45, w / h, 0.1, 1000)
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true })
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    renderer.setSize(w, h)
    renderer.outputColorSpace = THREE.SRGBColorSpace
    renderer.setClearColor(0x000000, 0)
    mount.appendChild(renderer.domElement)

    const render = () => renderer.render(scene, camera)
    const controls = new OrbitControls(camera, renderer.domElement)
    controls.enableDamping = false
    controls.minDistance = 4
    controls.maxDistance = 80
    controls.maxPolarAngle = Math.PI * 0.5
    controls.rotateSpeed = 0.6
    controls.target.set(0, 1, 0)
    controls.addEventListener('change', render)

    scene.add(new THREE.HemisphereLight(0xdce8ff, 0x161a22, 1.9))
    const key = new THREE.DirectionalLight(0xffffff, 1.4)
    key.position.set(6, 12, 8)
    scene.add(key)

    const holds = new THREE.Group()
    scene.add(holds)

    const raycaster = new THREE.Raycaster()
    const pointer = new THREE.Vector2()
    const refs: Refs = {
      renderer, scene, camera, controls, holds, raycaster, pointer,
      picks: [], bounds: [8, 8, 3], render,
    }
    refsRef.current = refs

    const castPointer = (event: PointerEvent) => {
      const rect = renderer.domElement.getBoundingClientRect()
      pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1
      pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1
      raycaster.setFromCamera(pointer, camera)
    }

    // Drag bays across their own floor plane; Z changes only through the field.
    interface DragSession {
      index: number
      plane: THREE.Plane
      grab: THREE.Vector3
      start: [number, number, number]
      last: [number, number]
    }
    let drag: DragSession | null = null

    const onPointerDown = (event: PointerEvent) => {
      if (event.button !== 0) return
      castPointer(event)
      const hit = raycaster.intersectObjects(refs.picks, false)[0]?.object
      if (!hit) return
      const index = hit.userData.index as number
      selectRef.current(index)
      const comp = compsRef.current[index]
      if (!comp) return
      const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -comp.offset[2])
      const grab = new THREE.Vector3()
      if (!raycaster.ray.intersectPlane(plane, grab)) return
      controls.enabled = false
      // Keep the drag alive when the cursor outruns the canvas.
      try { renderer.domElement.setPointerCapture(event.pointerId) } catch { /* no active pointer */ }
      freezeRef.current([...refs.bounds] as [number, number, number])
      drag = {
        index, plane, grab,
        start: [...comp.offset] as [number, number, number],
        last: [comp.offset[0], comp.offset[1]],
      }
    }

    const onPointerMove = (event: PointerEvent) => {
      if (!drag) return
      castPointer(event)
      const pt = new THREE.Vector3()
      if (!raycaster.ray.intersectPlane(drag.plane, pt)) return
      const nx = Math.max(0, drag.start[0] + Math.round(pt.x - drag.grab.x))
      const ny = Math.max(0, drag.start[1] + Math.round(pt.z - drag.grab.z)) // world z maps to data Y
      if (nx === drag.last[0] && ny === drag.last[1]) return
      drag.last = [nx, ny]
      moveBayRef.current(drag.index, [nx, ny, drag.start[2]])
    }

    const endDrag = (event: PointerEvent) => {
      if (!drag) return
      drag = null
      controls.enabled = true
      try { renderer.domElement.releasePointerCapture(event.pointerId) } catch { /* already released */ }
      freezeRef.current(null)
    }

    const onResize = () => {
      const nw = mount.clientWidth || 600
      const nh = mount.clientHeight || 420
      camera.aspect = nw / nh
      camera.updateProjectionMatrix()
      renderer.setSize(nw, nh)
      render()
    }
    // On-demand rendering must explicitly repaint after WebGL context restore.
    const onContextRestored = () => render()

    let ro: ResizeObserver | null = null
    if (typeof ResizeObserver !== 'undefined') { ro = new ResizeObserver(onResize); ro.observe(mount) }
    else window.addEventListener('resize', onResize)
    renderer.domElement.addEventListener('webglcontextrestored', onContextRestored)
    renderer.domElement.addEventListener('pointerdown', onPointerDown)
    renderer.domElement.addEventListener('pointermove', onPointerMove)
    renderer.domElement.addEventListener('pointerup', endDrag)
    renderer.domElement.addEventListener('pointercancel', endDrag)

    fitCamera(refs, [8, 8, 3])
    render()

    return () => {
      if (ro) ro.disconnect()
      else window.removeEventListener('resize', onResize)
      renderer.domElement.removeEventListener('webglcontextrestored', onContextRestored)
      renderer.domElement.removeEventListener('pointerdown', onPointerDown)
      renderer.domElement.removeEventListener('pointermove', onPointerMove)
      renderer.domElement.removeEventListener('pointerup', endDrag)
      renderer.domElement.removeEventListener('pointercancel', endDrag)
      controls.removeEventListener('change', render)
      controls.dispose()
      disposeObject(holds)
      renderer.dispose()
      if (renderer.domElement.parentNode === mount) mount.removeChild(renderer.domElement)
      refsRef.current = null
    }
  }, [])

  // Rebuild bays when compartments, selection, or bounds change.
  useEffect(() => {
    const s = refsRef.current
    if (!s) return
    const boundsChanged = s.bounds[0] !== bounds[0] || s.bounds[1] !== bounds[1] || s.bounds[2] !== bounds[2]
    while (s.holds.children.length) disposeObject(s.holds.children.pop()!)
    s.picks = []
    s.bounds = bounds

    s.holds.add(buildFloor(bounds))
    comps.forEach((c, i) => {
      const { group, pick } = buildBay(c, i === sel, overlaps.has(i), bounds)
      pick.userData.index = i
      s.picks.push(pick)
      s.holds.add(group)
    })

    if (boundsChanged) fitCamera(s, bounds)
    s.render()
  }, [comps, sel, bounds, overlaps])

  const selected = sel >= 0 && sel < comps.length ? comps[sel] : null

  const update = (i: number, patch: Partial<Compartment>) =>
    setComps((cur) => cur.map((c, k) => (k === i ? { ...c, ...patch } : c)))
  const setDim = (i: number, axis: 0 | 1 | 2, value: number) =>
    setComps((cur) => cur.map((c, k) => (k === i ? { ...c, dims: c.dims.map((d, a) => (a === axis ? Math.max(1, value || 1) : d)) as [number, number, number] } : c)))
  const setOff = (i: number, axis: 0 | 1 | 2, value: number) =>
    setComps((cur) => cur.map((c, k) => (k === i ? { ...c, offset: c.offset.map((o, a) => (a === axis ? Math.max(0, value || 0) : o)) as [number, number, number] } : c)))

  // New bays inherit the selected bay because real holds are often repeated rows.
  const addBay = () => {
    setComps((cur) => {
      if (!cur.length) return [newBay()]
      const template = cur[sel >= 0 && sel < cur.length ? sel : cur.length - 1]
      const copy = cloneBay(template)
      copy.offset = freeSpotFor(template, cur)
      return [...cur, copy]
    })
    setSel(comps.length)
  }
  const dupBay = (i: number) => {
    setComps((cur) => duplicateBay(cur, i))
    setSel(comps.length)
  }
  const dupLayout = () => setComps((cur) => duplicateLayout(cur))
  const removeBay = (i: number) => {
    setComps((cur) => cur.filter((_, k) => k !== i))
    setSel((s) => (s === i ? -1 : s > i ? s - 1 : s))
  }

  // Import loads into the editor for review; Save grid writes to localStorage.
  const exportGrid = () => {
    const blob = new Blob([serializeGrid(ship.name, comps)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = gridFileName(ship.name)
    link.click()
    URL.revokeObjectURL(url)
    setIoStatus({ warn: false, text: `Exported ${gridFileName(ship.name)}` })
  }
  const importGrid = async (file: File | undefined) => {
    if (!file) return
    try {
      const parsed = parseGridFile(await file.text())
      setComps(parsed.compartments)
      setSel(0)
      setIoStatus(
        parsed.ship && parsed.ship !== ship.name
          ? { warn: true, text: `Imported a grid drawn for "${parsed.ship}" — check it fits the ${ship.name}, then Save.` }
          : { warn: false, text: 'Grid imported — review it, then Save grid.' },
      )
    } catch (error) {
      setIoStatus({ warn: true, text: `Import failed: ${error instanceof Error ? error.message : String(error)}` })
    }
  }

  return (
    <section className="grideditor">
      <div className="grideditor-head">
        <h2>Cargo grid · {ship.name}</h2>
        <div className="grideditor-head-right">
          <span className="muted">{comps.length} bay{comps.length === 1 ? '' : 's'} · {capacity} SCU</span>
          <button className="seg-btn" onClick={onClose} type="button">Cancel</button>
          <button className="grideditor-save" onClick={() => { onSave(comps); onClose() }} type="button">Save grid</button>
        </div>
      </div>

      <div className="grideditor-body">
        <div className="grideditor-canvas" ref={mountRef} />

        <aside className="grideditor-panel">
          <p className="grideditor-hint">
            Each bay is a rectangular hold. Set its size and the <strong>door</strong> cargo
            comes out of. <strong>Drag a bay</strong> in the view to move it across the floor.
            Floor is always the bottom — a box needs full support under it, and pulling a
            lower box drops whatever sits on it.
          </p>

          <div className="bay-list">
            {comps.map((c, i) => (
              <div className={`bay-row ${i === sel ? 'active' : ''} ${overlaps.has(i) ? 'bad' : ''}`} key={i}>
                <button className="bay-row-main" onClick={() => setSel(i)} type="button">
                  <span className="bay-name">Bay {i + 1}</span>
                  <span className="bay-meta">{c.dims[0]}×{c.dims[1]}×{c.dims[2]} · {openingLabel(compartmentOpening(c))}</span>
                </button>
                <button className="icon-btn" onClick={() => dupBay(i)} title="Duplicate bay (same size & door, placed beside)" type="button">⧉</button>
                <button className="icon-btn" onClick={() => removeBay(i)} title="Delete bay" type="button">✕</button>
              </div>
            ))}
            <button className="ghost-btn block" onClick={addBay} type="button">+ Add bay{comps.length ? ' (copies the selected one)' : ''}</button>
            {comps.length > 0 && (
              <button className="ghost-btn block" onClick={dupLayout} title="Copy every bay once, placed behind the current set" type="button">
                ⧉ Duplicate whole layout → {capacity * 2} SCU
              </button>
            )}
          </div>

          {selected ? (
            <div className="bay-edit">
              <div className="field-row">
                <label>Position</label>
                <div className="xyz">
                  <NumField label="X" value={selected.offset[0]} onChange={(v) => setOff(sel, 0, v)} />
                  <NumField label="Y" value={selected.offset[1]} onChange={(v) => setOff(sel, 1, v)} />
                  <NumField label="Z" value={selected.offset[2]} onChange={(v) => setOff(sel, 2, v)} />
                </div>
              </div>
              <div className="field-row">
                <label>Size (cells)</label>
                <div className="xyz">
                  <NumField label="W" value={selected.dims[0]} min={1} onChange={(v) => setDim(sel, 0, v)} />
                  <NumField label="L" value={selected.dims[1]} min={1} onChange={(v) => setDim(sel, 1, v)} />
                  <NumField label="H" value={selected.dims[2]} min={1} onChange={(v) => setDim(sel, 2, v)} />
                </div>
              </div>
              <div className="field-row">
                <label>Door (extraction)</label>
                <div className="seg wrap">
                  {OPENING_FACES.map((f) => (
                    <button
                      className={`seg-btn ${compartmentOpening(selected) === f.id ? 'active' : ''}`}
                      key={f.id}
                      onClick={() => update(sel, withOpening(selected, f.id))}
                      type="button"
                    >
                      {f.label}
                    </button>
                  ))}
                </div>
              </div>
              <div className="field-row">
                <label>Max box</label>
                <select
                  className="maxbox-select"
                  value={selected.maxBoxScu ?? ''}
                  onChange={(e) => update(sel, { maxBoxScu: e.target.value ? Number(e.target.value) : undefined })}
                >
                  <option value="">Any that fits</option>
                  {[1, 2, 4, 8, 16, 24, 32].map((s) => (
                    <option key={s} value={s}>≤ {s} SCU</option>
                  ))}
                </select>
              </div>
              {overlaps.has(sel) && <p className="warn small">This bay overlaps another — cargo can't span a gap, so bays must not intersect.</p>}
            </div>
          ) : (
            <p className="muted empty">Select a bay to edit it, or add one.</p>
          )}

          <div className="grideditor-foot">
            {builtin && (
              <button className="seg-btn" onClick={() => { setComps(clone(builtin)); setSel(builtin.length ? 0 : -1) }} type="button">
                Reset to built-in
              </button>
            )}
            <button className="seg-btn" disabled={!comps.length} onClick={exportGrid} type="button">
              Export JSON
            </button>
            <button className="seg-btn" onClick={() => importInputRef.current?.click()} type="button">
              Import JSON
            </button>
            <input
              accept=".json,application/json"
              hidden
              onChange={(e) => {
                void importGrid(e.target.files?.[0])
                e.target.value = ''
              }}
              ref={importInputRef}
              type="file"
            />
          </div>
          {ioStatus && (
            <p className={`small ${ioStatus.warn ? 'warn' : 'muted'}`}>{ioStatus.text}</p>
          )}
        </aside>
      </div>
    </section>
  )
}

function NumField({ label, value, min, onChange }: { label: string; value: number; min?: number; onChange: (v: number) => void }) {
  return (
    <label className="numfield">
      <span>{label}</span>
      <input
        type="number"
        min={min ?? 0}
        value={value}
        onChange={(e) => onChange(Math.round(Number(e.target.value)))}
      />
    </label>
  )
}

function openingLabel(face: OpeningFace): string {
  return face === 'top' ? 'top ↑' : `door ${face}`
}

// Three builders share CargoGrid3D's world mapping: data X -> world x,
// data Z(height) -> world y, data Y(length) -> world z.

function worldOrigin(bounds: [number, number, number]) {
  return { ox: -bounds[0] / 2, oz: -bounds[1] / 2 }
}

function buildBay(c: Compartment, selected: boolean, bad: boolean, bounds: [number, number, number]) {
  const group = new THREE.Group()
  const { ox, oz } = worldOrigin(bounds)
  const [w, d, hgt] = c.dims
  const [cx, cy, cz] = c.offset
  const centerX = ox + cx + w / 2
  const centerY = cz + hgt / 2
  const centerZ = oz + cy + d / 2

  const color = bad ? 0xe2574a : selected ? SELECTED_COLOR : BAY_COLOR

  // Fill is also the click target.
  const fill = new THREE.Mesh(
    new THREE.BoxGeometry(w, hgt, d),
    new THREE.MeshBasicMaterial({
      color,
      transparent: true,
      opacity: bad ? 0.16 : selected ? 0.16 : 0.06,
      depthWrite: false,
      side: THREE.DoubleSide,
    }),
  )
  fill.position.set(centerX, centerY, centerZ)
  group.add(fill)

  const edges = new THREE.LineSegments(
    new THREE.EdgesGeometry(new THREE.BoxGeometry(w, hgt, d)),
    new THREE.LineBasicMaterial({ color, transparent: true, opacity: selected ? 0.95 : 0.6 }),
  )
  edges.position.set(centerX, centerY, centerZ)
  group.add(edges)

  group.add(gridLines(w, d, ox + cx, oz + cy, cz))

  group.add(doorArrow(compartmentOpening(c), c, bounds))

  return { group, pick: fill }
}

// Own the arrow geometries; ArrowHelper shares internals that our disposer would corrupt.
function doorArrow(face: OpeningFace, c: Compartment, bounds: [number, number, number]): THREE.Object3D {
  const { ox, oz } = worldOrigin(bounds)
  const [w, d, hgt] = c.dims
  const [cx, cy, cz] = c.offset
  const midX = ox + cx + w / 2
  const midY = cz + hgt / 2
  const midZ = oz + cy + d / 2
  let dir: THREE.Vector3
  let origin: THREE.Vector3
  switch (face) {
    case '+x': dir = new THREE.Vector3(1, 0, 0); origin = new THREE.Vector3(ox + cx + w, midY, midZ); break
    case '-x': dir = new THREE.Vector3(-1, 0, 0); origin = new THREE.Vector3(ox + cx, midY, midZ); break
    case '+y': dir = new THREE.Vector3(0, 0, 1); origin = new THREE.Vector3(midX, midY, oz + cy + d); break
    case '-y': dir = new THREE.Vector3(0, 0, -1); origin = new THREE.Vector3(midX, midY, oz + cy); break
    case 'top': dir = new THREE.Vector3(0, 1, 0); origin = new THREE.Vector3(midX, cz + hgt, midZ); break
  }
  const len = Math.min(1.6, Math.max(0.8, Math.min(w, d, hgt)))
  const shaftLen = len * 0.6
  const headLen = len * 0.4
  const mat = new THREE.MeshBasicMaterial({ color: DOOR_COLOR })
  const shaft = new THREE.Mesh(new THREE.CylinderGeometry(len * 0.04, len * 0.04, shaftLen, 8), mat)
  shaft.position.y = shaftLen / 2
  const head = new THREE.Mesh(new THREE.ConeGeometry(len * 0.15, headLen, 12), mat)
  head.position.y = shaftLen + headLen / 2
  const arrow = new THREE.Group()
  arrow.add(shaft, head)
  arrow.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.normalize())
  arrow.position.copy(origin)
  return arrow
}

function gridLines(width: number, depth: number, ox: number, oz: number, y: number) {
  const pts: number[] = []
  for (let x = 0; x <= width; x++) pts.push(ox + x, y + 0.01, oz, ox + x, y + 0.01, oz + depth)
  for (let z = 0; z <= depth; z++) pts.push(ox, y + 0.01, oz + z, ox + width, y + 0.01, oz + z)
  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3))
  return new THREE.LineSegments(geo, new THREE.LineBasicMaterial({ color: 0x566071, transparent: true, opacity: 0.34 }))
}

function buildFloor(bounds: [number, number, number]) {
  const [X, Y] = bounds
  const plate = new THREE.Mesh(
    new THREE.PlaneGeometry(X + 1, Y + 1),
    new THREE.MeshBasicMaterial({ color: 0x0b0e14, transparent: true, opacity: 0.5, side: THREE.DoubleSide }),
  )
  plate.rotation.x = -Math.PI / 2
  plate.position.y = -0.02
  return plate
}

function fitCamera(refs: Refs, bounds: [number, number, number]) {
  const [X, Y, Z] = bounds
  const center = new THREE.Vector3(0, Math.max(0.75, Z / 2), 0)
  const span = Math.max(X, Y, Z, 6)
  const distance = span * 1.7
  refs.camera.position.copy(center).add(new THREE.Vector3(0.86, 0.72, 1.08).normalize().multiplyScalar(distance))
  refs.camera.near = Math.max(0.05, distance / 80)
  refs.camera.far = distance * 6
  refs.camera.updateProjectionMatrix()
  refs.camera.lookAt(center)
  refs.controls.target.copy(center)
  refs.controls.update()
}
