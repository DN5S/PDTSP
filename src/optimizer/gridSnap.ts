// Box-based grid snapping for drag placement, compartment-aware.
//
// The drag target is decided from the BOX (its centre + footprint), not the raw
// cursor point. The box centre must land inside a compartment's footprint (not
// the gap between bays); the snapped min-corner is then clamped so the box stays
// within that compartment.

import { compartmentAllowsBox, type Compartment } from '../ships/grids'

export interface SnapResult {
  /** True when the box centre is over a compartment (not a gap / outside). */
  inGrid: boolean
  /** Clamped min-corner cell [x, y, z] in ship space; meaningful when inGrid. */
  pos: [number, number, number]
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v))

/**
 * Resolve where a box lands from its desired world centre. The world is centred
 * on the compartments' bounding box: ship-space x = world x + bounds[0]/2,
 * ship-space y = world z + bounds[1]/2. A box centre over a compartment snaps and
 * clamps inside it; over a gap or outside, it's off-grid.
 */
export function resolveBoxCell(
  centreX: number,
  centreZ: number,
  dims: [number, number, number],
  scu: number,
  compartments: Compartment[],
  bounds: [number, number, number],
  heightCell: number,
): SnapResult {
  const ox = -bounds[0] / 2
  const oz = -bounds[1] / 2
  const sx = centreX - ox // ship-space x (0..bounds[0])
  const sy = centreZ - oz // ship-space y (0..bounds[1])

  const comp = compartments.find(
    (c) =>
      compartmentAllowsBox(c, scu) &&
      sx >= c.offset[0] &&
      sx <= c.offset[0] + c.dims[0] &&
      sy >= c.offset[1] &&
      sy <= c.offset[1] + c.dims[1],
  )
  if (!comp) return { inGrid: false, pos: [0, 0, heightCell] }

  const [boxX, boxY] = dims
  const localX = clamp(Math.round(sx - comp.offset[0] - boxX / 2), 0, Math.max(0, comp.dims[0] - boxX))
  const localY = clamp(Math.round(sy - comp.offset[1] - boxY / 2), 0, Math.max(0, comp.dims[1] - boxY))
  return { inGrid: true, pos: [comp.offset[0] + localX, comp.offset[1] + localY, heightCell] }
}
