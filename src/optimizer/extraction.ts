// Extraction blocking over the 3D view's CURRENT placements.
//
// witnessAudit.ts audits the oracle's witness; this module answers the same
// physics questions for the live view after the user drags boxes around:
//   - which boxes must move before `target` can be extracted (X-ray hover)?
//   - does the current arrangement keep every future unload dig-free (audit)?
//
// Semantics mirror the witnessAudit spec exactly — the deliberately WEAKER
// slide model, so every arrangement the oracle accepts passes and a warning is
// always a real dig:
//   'vertical'       — lifted straight out: the full column above the footprint,
//                      up to the compartment ceiling, must be clear.
//   'vertical+depth' — slid out at its own level: nothing may rest on top, and
//                      the tunnel from its door-facing face to the door plane
//                      must be clear.
//   'none'           — independent access, never blocked.

import { type Compartment, compartmentBlocking, compartmentOpeningAxis } from '../ships/grids'

export interface CellBox {
  id: string
  /** Min-corner cell position in ship space (compartment offsets applied). */
  pos: [number, number, number]
  dims: [number, number, number]
}

/** Index of the compartment fully containing the box, or -1 (off-grid/spanning). */
function containing(b: CellBox, comps: Compartment[]): number {
  return comps.findIndex(
    (c) =>
      b.pos[0] >= c.offset[0] && b.pos[0] + b.dims[0] <= c.offset[0] + c.dims[0] &&
      b.pos[1] >= c.offset[1] && b.pos[1] + b.dims[1] <= c.offset[1] + c.dims[1] &&
      b.pos[2] >= c.offset[2] && b.pos[2] + b.dims[2] <= c.offset[2] + c.dims[2],
  )
}

/** Half-open cell region [x0,x1) x [y0,y1) x [z0,z1). */
type Region = [number, number, number, number, number, number]

function intersects(b: CellBox, r: Region): boolean {
  return (
    b.pos[0] < r[1] && b.pos[0] + b.dims[0] > r[0] &&
    b.pos[1] < r[3] && b.pos[1] + b.dims[1] > r[2] &&
    b.pos[2] < r[5] && b.pos[2] + b.dims[2] > r[4]
  )
}

/** Regions that must be free of cargo for `target` to leave compartment `c`. */
function blockedRegions(target: CellBox, c: Compartment): Region[] {
  const model = compartmentBlocking(c)
  if (model === 'none') return []
  const [x, y, z] = target.pos
  const xEnd = x + target.dims[0]
  const yEnd = y + target.dims[1]
  const zTop = z + target.dims[2]

  if (model === 'vertical') {
    return [[x, xEnd, y, yEnd, zTop, c.offset[2] + c.dims[2]]]
  }

  // 'vertical+depth': the resting layer directly on top, plus the door tunnel
  // at the box's own level.
  const regions: Region[] = [[x, xEnd, y, yEnd, zTop, zTop + 1]]
  const axis = compartmentOpeningAxis(c)
  if (axis === '+x') regions.push([xEnd, c.offset[0] + c.dims[0], y, yEnd, z, zTop])
  else if (axis === '-x') regions.push([c.offset[0], x, y, yEnd, z, zTop])
  else if (axis === '+y') regions.push([x, xEnd, yEnd, c.offset[1] + c.dims[1], z, zTop])
  else regions.push([x, xEnd, c.offset[1], y, z, zTop])
  return regions
}

/**
 * Ids of `obstacles` that must move before `target` can be extracted right now.
 * Only cargo sharing the target's compartment can block; a target outside every
 * compartment (off-grid) can't be judged and reports no blockers.
 */
export function extractionBlockers(
  target: CellBox,
  obstacles: CellBox[],
  comps: Compartment[],
): string[] {
  const ci = containing(target, comps)
  if (ci < 0) return []
  const regions = blockedRegions(target, comps[ci])
  if (!regions.length) return []
  return obstacles
    .filter(
      (o) =>
        o.id !== target.id &&
        containing(o, comps) === ci &&
        regions.some((r) => intersects(o, r)),
    )
    .map((o) => o.id)
}

export interface DigIssue {
  buriedId: string
  deliverStop: number
  blockerIds: string[]
}

/**
 * Simulate the remaining unloads in stop order over the CURRENT arrangement:
 * a departing box may only be blocked by cargo that leaves LATER (same-stop
 * deliveries come off together, matching the oracle's convention). Returns one
 * issue per buried box; empty means the arrangement stays dig-free.
 */
export function auditUnloadOrder(
  boxes: (CellBox & { deliverStop?: number })[],
  comps: Compartment[],
): DigIssue[] {
  const dated = boxes.filter((b): b is CellBox & { deliverStop: number } => b.deliverStop !== undefined)
  const stops = [...new Set(dated.map((b) => b.deliverStop))].sort((a, b) => a - b)
  const issues: DigIssue[] = []
  for (const s of stops) {
    const obstacles = dated.filter((o) => o.deliverStop > s)
    for (const u of dated) {
      if (u.deliverStop !== s) continue
      const blockerIds = extractionBlockers(u, obstacles, comps)
      if (blockerIds.length) issues.push({ buriedId: u.id, deliverStop: s, blockerIds })
    }
  }
  return issues
}
