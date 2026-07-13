// Standard Star Citizen cargo container sizes and how a leg's SCU decomposes
// into physical boxes. Dimensions are in 1-SCU cells [x, y, z] (z = height);
// boxes may be rotated in the X/Y plane when placed.

export interface BoxSize {
  scu: number
  /** Cell dimensions [x, y, z]. */
  dims: [number, number, number]
}

// Largest first — used for greedy decomposition and packing.
export const BOX_SIZES: BoxSize[] = [
  { scu: 32, dims: [8, 2, 2] },
  { scu: 24, dims: [6, 2, 2] },
  { scu: 16, dims: [4, 2, 2] },
  { scu: 8, dims: [2, 2, 2] },
  { scu: 4, dims: [2, 2, 1] },
  { scu: 2, dims: [1, 2, 1] },
  { scu: 1, dims: [1, 1, 1] },
]

/**
 * Largest container a ship accepts, from its UEX `containerSizes`. An empty list
 * means UEX has no data — treated as UNKNOWN (no ship-side limit), not "accepts
 * nothing" (8 real ships ship with an empty list).
 */
export function shipMaxBoxScu(containerSizes: number[] | undefined): number {
  return containerSizes?.length ? Math.max(...containerSizes) : Infinity
}

/**
 * Break `scu` into standard boxes, largest first. `maxScu` caps the box size
 * (a mission's max container size); defaults to the largest standard box.
 */
export function decomposeToBoxes(scu: number, maxScu = 32): BoxSize[] {
  const boxes: BoxSize[] = []
  let remaining = Math.max(0, Math.floor(scu))
  const usable = BOX_SIZES.filter((b) => b.scu <= maxScu)
  while (remaining > 0) {
    const fit = usable.find((b) => b.scu <= remaining)
    if (!fit) break // remaining < smallest usable box
    boxes.push(fit)
    remaining -= fit.scu
  }
  return boxes
}
