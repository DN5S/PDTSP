// Pure bay-authoring operations for the grid editor: duplicating a bay (or the
// whole layout) with automatic non-overlapping placement. Drawing a real ship
// is mostly REPETITION — rows of identical bays (Railen 6 pods, Ironclad twin
// holds, Hull-series stacks) — so copying must be one click, not re-typing
// size, door and position per bay.

import type { Compartment } from '../ships/grids'
import { gridBounds } from '../ships/grids'

export const cloneBay = (c: Compartment): Compartment =>
  ({ ...c, offset: [...c.offset] as [number, number, number], dims: [...c.dims] as [number, number, number] })

function overlap(a: Compartment, b: Compartment): boolean {
  return (
    a.offset[0] < b.offset[0] + b.dims[0] && b.offset[0] < a.offset[0] + a.dims[0] &&
    a.offset[1] < b.offset[1] + b.dims[1] && b.offset[1] < a.offset[1] + a.dims[1] &&
    a.offset[2] < b.offset[2] + b.dims[2] && b.offset[2] < a.offset[2] + a.dims[2]
  )
}

const fits = (c: Compartment, all: Compartment[]) => all.every((o) => !overlap(c, o))

/**
 * A free offset for a copy of `src` among `all` (deterministic): first the slot
 * right of the source (1-cell gap, the built-in grids' idiom), then behind it,
 * then a floor-level row-major scan — so repeated copies tile a neat row and
 * wrap to the next rank when the row is blocked.
 */
export function freeSpotFor(src: Compartment, all: Compartment[]): [number, number, number] {
  const at = (x: number, y: number, z: number): Compartment =>
    ({ ...src, offset: [x, y, z] as [number, number, number] })
  const [sx, sy, sz] = src.offset
  const beside: [number, number, number] = [sx + src.dims[0] + 1, sy, sz]
  if (fits(at(...beside), all)) return beside
  const behind: [number, number, number] = [sx, sy + src.dims[1] + 1, sz]
  if (fits(at(...behind), all)) return behind
  const [bx, by] = gridBounds(all)
  for (let y = 0; y <= by + 1; y++)
    for (let x = 0; x <= bx + 1; x++)
      if (fits(at(x, y, sz), all)) return [x, y, sz]
  // Nothing free inside the current footprint — extend it.
  return [bx + 1, 0, sz]
}

/** Copy of bay `i` (size, door, max box), auto-placed; appended to the list. */
export function duplicateBay(all: Compartment[], i: number): Compartment[] {
  const copy = cloneBay(all[i])
  copy.offset = freeSpotFor(all[i], all)
  return [...all, copy]
}

/** The whole layout copied once, shifted behind the current set (+Y, 1-cell
 *  gap) — "the same thing again", e.g. a second deck row doubling capacity. */
export function duplicateLayout(all: Compartment[]): Compartment[] {
  const dy = gridBounds(all)[1] + 1
  return [
    ...all,
    ...all.map((c) => {
      const copy = cloneBay(c)
      copy.offset[1] += dy
      return copy
    }),
  ]
}
