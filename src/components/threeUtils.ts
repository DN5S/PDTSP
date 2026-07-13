// Shared Three.js helpers for the cargo 3D views.

import * as THREE from 'three'

export interface CellBoxLike {
  /** Min-corner cell position [x, y, z] in ship space (z = height). */
  pos: [number, number, number]
  /** Cell dimensions [x, y, z]. */
  dims: [number, number, number]
}

/**
 * Boundary surface of the union of the boxes' cells, as world-space triangles
 * (grid x -> world x + ox, grid y -> world z + oz, grid z -> world y). Interior
 * faces between touching cells are omitted, so a cluster of boxes reads as ONE
 * silhouette — per-box outlines turn dense overlays into wireframe soup.
 * EdgesGeometry on the result yields only the cluster's corner lines (coplanar
 * seams are below its threshold angle).
 */
export function unionSurfaceGeometry(boxes: CellBoxLike[], ox: number, oz: number): THREE.BufferGeometry {
  const occupied = new Set<string>()
  for (const b of boxes)
    for (let z = b.pos[2]; z < b.pos[2] + b.dims[2]; z++)
      for (let y = b.pos[1]; y < b.pos[1] + b.dims[1]; y++)
        for (let x = b.pos[0]; x < b.pos[0] + b.dims[0]; x++) occupied.add(`${x},${y},${z}`)

  const positions: number[] = []
  const quad = (a: number[], b: number[], c: number[], d: number[]) =>
    positions.push(...a, ...b, ...c, ...a, ...c, ...d)

  for (const key of occupied) {
    const [cx, cy, cz] = key.split(',').map(Number)
    const x0 = ox + cx, x1 = x0 + 1
    const z0 = oz + cy, z1 = z0 + 1
    const y0 = cz, y1 = cz + 1
    if (!occupied.has(`${cx + 1},${cy},${cz}`)) quad([x1, y0, z0], [x1, y1, z0], [x1, y1, z1], [x1, y0, z1])
    if (!occupied.has(`${cx - 1},${cy},${cz}`)) quad([x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0])
    if (!occupied.has(`${cx},${cy + 1},${cz}`)) quad([x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1])
    if (!occupied.has(`${cx},${cy - 1},${cz}`)) quad([x0, y0, z0], [x0, y1, z0], [x1, y1, z0], [x1, y0, z0])
    if (!occupied.has(`${cx},${cy},${cz + 1}`)) quad([x0, y1, z0], [x0, y1, z1], [x1, y1, z1], [x1, y1, z0])
    if (!occupied.has(`${cx},${cy},${cz - 1}`)) quad([x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1])
  }

  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
  return geometry
}

/** Recursively dispose an object's geometries, materials, and material textures.
 *  Call before dropping a Group/Mesh from the scene so its GPU resources are freed. */
export function disposeObject(root: THREE.Object3D): void {
  root.traverse((object) => {
    const d = object as THREE.Object3D & {
      geometry?: THREE.BufferGeometry
      material?: THREE.Material | THREE.Material[]
    }
    // All THREE.Sprite instances share ONE module-level geometry singleton —
    // disposing it deallocates the quad under every live sprite (same shared-
    // singleton hazard GridEditor3D documents for ArrowHelper). The sprite's
    // material and its canvas texture ARE per-instance and are still released.
    if (!(object as THREE.Sprite).isSprite) d.geometry?.dispose()
    if (Array.isArray(d.material)) d.material.forEach(disposeMaterial)
    else if (d.material) disposeMaterial(d.material)
  })
}

function disposeMaterial(material: THREE.Material): void {
  const mapped = material as THREE.Material & {
    map?: THREE.Texture | null
    emissiveMap?: THREE.Texture | null
  }
  // Textures flagged `userData.shared` belong to the containerFaces cache and
  // outlive any one scene — the cache owns their lifetime, not the material.
  if (mapped.map && !mapped.map.userData.shared) mapped.map.dispose()
  if (mapped.emissiveMap && mapped.emissiveMap !== mapped.map && !mapped.emissiveMap.userData.shared) {
    mapped.emissiveMap.dispose()
  }
  material.dispose()
}
