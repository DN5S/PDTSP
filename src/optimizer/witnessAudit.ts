// TEST-SUPPORT: witness audits independent of the packer's blocking helpers.
// They re-check geometry/support and dig-free extraction from occupancy cells so
// shared bugs in the oracle's `blocks()` model do not mask bad witnesses.

import type { OraclePlacedBox } from './loadFeasibility'
import { type Compartment, compartmentBlocking, compartmentOpeningAxis } from '../ships/grids'

export type WitnessAudit = { ok: true } | { ok: false; reason: string }

/** Containing compartment index, or -1. Positions are global cells. */
function compOf(b: OraclePlacedBox, comps: Compartment[]): number {
  return comps.findIndex((c) =>
    b.pos[0] >= c.offset[0] && b.pos[0] + b.dims[0] <= c.offset[0] + c.dims[0] &&
    b.pos[1] >= c.offset[1] && b.pos[1] + b.dims[1] <= c.offset[1] + c.dims[1] &&
    b.pos[2] >= c.offset[2] && b.pos[2] + b.dims[2] <= c.offset[2] + c.dims[2])
}

/** Static occupancy audit: inside compartments, no overlap, fully supported. */
export function validateGeometry(
  boxes: OraclePlacedBox[], comps: Compartment[],
): { ok: false; reason: string } | { ok: true; peakPod: number[] } {
  const peakPod = new Array<number>(comps.length).fill(0)
  if (!boxes.length) return { ok: true, peakPod }
  const maxStop = Math.max(...boxes.map((b) => b.deliverStop))
  for (let s = 0; s <= maxStop; s++) {
    const onboard = boxes.filter((b) => b.loadStop <= s && b.deliverStop > s)
    const occ = new Map<string, string>()
    const podScu = new Array<number>(comps.length).fill(0)
    for (const b of onboard) {
      const ci = compOf(b, comps)
      if (ci < 0) return { ok: false, reason: `box ${b.id} spans/escapes compartments at stop ${s}` }
      podScu[ci] += b.scu
      for (let z = b.pos[2]; z < b.pos[2] + b.dims[2]; z++)
        for (let y = b.pos[1]; y < b.pos[1] + b.dims[1]; y++)
          for (let x = b.pos[0]; x < b.pos[0] + b.dims[0]; x++) {
            const k = `${x},${y},${z}`
            if (occ.has(k)) return { ok: false, reason: `overlap at ${k} (${b.id} vs ${occ.get(k)}) stop ${s}` }
            occ.set(k, b.id)
          }
    }
    // Non-floor boxes need every footprint cell supported below.
    for (const b of onboard) {
      const ci = compOf(b, comps)
      if (b.pos[2] === comps[ci].offset[2]) continue
      for (let y = b.pos[1]; y < b.pos[1] + b.dims[1]; y++)
        for (let x = b.pos[0]; x < b.pos[0] + b.dims[0]; x++)
          if (!occ.has(`${x},${y},${b.pos[2] - 1}`)) return { ok: false, reason: `unsupported ${b.id} at stop ${s}` }
    }
    for (let i = 0; i < comps.length; i++) peakPod[i] = Math.max(peakPod[i], podScu[i])
  }
  return { ok: true, peakPod }
}

/** Dig-free audit over the delivery timeline. */
export function auditDigFree(boxes: OraclePlacedBox[], comps: Compartment[]): WitnessAudit {
  const stops = [...new Set(boxes.map((b) => b.deliverStop))].sort((a, b) => a - b)
  for (const s of stops) {
    for (const u of boxes) {
      if (u.deliverStop !== s) continue
      const ci = compOf(u, comps)
      if (ci < 0) return { ok: false, reason: `box ${u.id} spans/escapes compartments` }
      const c = comps[ci]
      const model = compartmentBlocking(c)
      if (model === 'none') continue

      // Still-onboard obstacles in the same compartment.
      const cells = new Set<string>()
      for (const o of boxes) {
        if (o.loadStop >= s || o.deliverStop <= s) continue
        if (compOf(o, comps) !== ci) continue
        for (let z = o.pos[2]; z < o.pos[2] + o.dims[2]; z++)
          for (let y = o.pos[1]; y < o.pos[1] + o.dims[1]; y++)
            for (let x = o.pos[0]; x < o.pos[0] + o.dims[0]; x++) cells.add(`${x},${y},${z}`)
      }
      if (!cells.size) continue

      const xEnd = u.pos[0] + u.dims[0]
      const yEnd = u.pos[1] + u.dims[1]
      const zTop = u.pos[2] + u.dims[2]
      const sweep = (x0: number, x1: number, y0: number, y1: number, z0: number, z1: number): string | null => {
        for (let z = z0; z < z1; z++)
          for (let y = y0; y < y1; y++)
            for (let x = x0; x < x1; x++)
              if (cells.has(`${x},${y},${z}`)) return `${x},${y},${z}`
        return null
      }

      if (model === 'vertical') {
        // Top opening: clear column above the footprint.
        const hit = sweep(u.pos[0], xEnd, u.pos[1], yEnd, zTop, c.offset[2] + c.dims[2])
        if (hit) return { ok: false, reason: `stop ${s}: ${u.id} cannot be lifted out — cargo above at ${hit}` }
        continue
      }

      // Horizontal door: nothing rests on it, and its tunnel to the door is clear.
      const resting = sweep(u.pos[0], xEnd, u.pos[1], yEnd, zTop, zTop + 1)
      if (resting) return { ok: false, reason: `stop ${s}: later-delivered cargo rests on ${u.id} at ${resting}` }
      const axis = compartmentOpeningAxis(c)
      let hit: string | null
      if (axis === '+x') hit = sweep(xEnd, c.offset[0] + c.dims[0], u.pos[1], yEnd, u.pos[2], zTop)
      else if (axis === '-x') hit = sweep(c.offset[0], u.pos[0], u.pos[1], yEnd, u.pos[2], zTop)
      else if (axis === '+y') hit = sweep(u.pos[0], xEnd, yEnd, c.offset[1] + c.dims[1], u.pos[2], zTop)
      else hit = sweep(u.pos[0], xEnd, c.offset[1], u.pos[1], u.pos[2], zTop)
      if (hit) return { ok: false, reason: `stop ${s}: ${u.id} blocked toward the ${axis} door at ${hit}` }
    }
  }
  return { ok: true }
}
