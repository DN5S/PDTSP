// Shared 3D packing primitives (grid geometry). Extracted from loadout.ts so the
// display packer (loadout.ts) and the hard-LIFO feasibility oracle
// (loadFeasibility.ts) share one implementation of fit/support/fill.
//
// Coordinates are compartment-LOCAL cells [x, y, z]; z is height (gravity down).
// A "grid" here is just (dims, occ): dims=[x,y,z], occ is a flat occupancy array
// indexed by cellIndex. For the display packer occ is a Uint8Array (0/1). The
// oracle uses its own occupant-id grid but reuses the pure geometry helpers below.

export type Dims3 = [number, number, number]

/** X/Y-plane rotations only — a container's up-axis (z) is fixed. */
export function orientations(dims: Dims3): Dims3[] {
  const [x, y, z] = dims
  return x === y ? [[x, y, z]] : [[x, y, z], [y, x, z]]
}

/** Does a box (dims) fit inside a single cell region, allowing X/Y rotation? */
export function boxFits(box: Dims3, cell: Dims3): boolean {
  const [bx, by, bz] = box
  const [cx, cy, cz] = cell
  return bz <= cz && ((bx <= cx && by <= cy) || (bx <= cy && by <= cx))
}

function cellIndex(dims: Dims3, x: number, y: number, z: number): number {
  return x + y * dims[0] + z * dims[0] * dims[1]
}

/** In-bounds and every covered cell empty (occ === 0). */
export function fits(
  dims: Dims3, occ: Uint8Array,
  lx: number, ly: number, lz: number, w: number, d: number, h: number,
): boolean {
  const [cx, cy, cz] = dims
  if (lx + w > cx || ly + d > cy || lz + h > cz) return false
  for (let z = lz; z < lz + h; z++)
    for (let y = ly; y < ly + d; y++)
      for (let x = lx; x < lx + w; x++) if (occ[cellIndex(dims, x, y, z)]) return false
  return true
}

export function fill(
  dims: Dims3, occ: Uint8Array,
  lx: number, ly: number, lz: number, w: number, d: number, h: number,
  value = 1,
): void {
  for (let z = lz; z < lz + h; z++)
    for (let y = ly; y < ly + d; y++)
      for (let x = lx; x < lx + w; x++) occ[cellIndex(dims, x, y, z)] = value
}

/** Full support: on the floor, or every cell directly below the footprint filled. */
export function supported(
  dims: Dims3, occ: Uint8Array,
  lx: number, ly: number, lz: number, w: number, d: number,
): boolean {
  if (lz === 0) return true
  for (let y = ly; y < ly + d; y++)
    for (let x = lx; x < lx + w; x++)
      if (!occ[cellIndex(dims, x, y, lz - 1)]) return false
  return true
}
