// Insertion (loading-path) audit — part of the regular suite as a GATE.
//
// User report: following the plan step by step, some cargo cannot physically be
// carried IN — the model only guaranteed dig-free EXTRACTION. Two mechanisms,
// audited separately:
//   (A) CHECKLIST ORDER: same-stop loads are sequenced mission-by-mission in
//       the plan's action order; an earlier-listed mission placed nearer the
//       door (or stacked above) walls off a later-listed mission's position.
//       In game the batch is order-free, so this is fixable by REORDERING.
//   (B) MODEL GAP: a mid-route load's path is blocked by cargo already onboard
//       from earlier stops — no within-stop reordering can fix that.
//
// History: production fixes were rolled back 2026-07-04 and this file was a
// VITE_VERIFY-gated measurement (baseline 2026-07-07: A 14/14, B 0/14). The
// oracle now enforces the insertion corridor at placement time (insertOk in
// loadFeasibility.ts — the insertion-side half of the blocking-interval
// condition), so the B-check is promoted from measurement to GUARANTEE:
// expect(B) === 0 runs on every regular test run.

import { describe, it, expect } from 'vitest'
import { optimizeRoute, type PlannerLeg } from './pdp'
import { buildRouteSteps } from './loadout'
import { SHIP_GRIDS, gridCapacity, compartmentBlocking, compartmentOpeningAxis, type Compartment } from '../ships/grids'
import type { Ship, RoutePlan, LoadoutBox } from '../domain/types'
import type { DistanceResolver } from './distanceMatrix'

/** Self-contained order-free insertion audit (model gap B): cargo loaded at an
 *  EARLIER stop must not block a box's way in — lowering column ('vertical'),
 *  door tunnel ('vertical+depth'). Same-stop cargo exempt (order-free batch). */
function auditLoadFree(boxes: LoadoutBox[], comps: Compartment[]): { ok: true } | { ok: false; reason: string } {
  const stops = [...new Set(boxes.map((b) => b.loadStop))].sort((a, b) => a - b)
  for (const s of stops) {
    for (const u of boxes) {
      if (u.loadStop !== s) continue
      const ci = compOf(u, comps)
      if (ci < 0) return { ok: false, reason: `box ${u.id} spans/escapes compartments` }
      const c = comps[ci]
      const model = compartmentBlocking(c)
      if (model === 'none') continue
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
            for (let x = x0; x < x1; x++) if (cells.has(`${x},${y},${z}`)) return `${x},${y},${z}`
        return null
      }
      if (model === 'vertical') {
        const hit = sweep(u.pos[0], xEnd, u.pos[1], yEnd, zTop, c.offset[2] + c.dims[2])
        if (hit) return { ok: false, reason: `stop ${s}: ${u.id} cannot be lowered in — cargo above at ${hit}` }
        continue
      }
      const axis = compartmentOpeningAxis(c)
      let hit: string | null
      if (axis === '+x') hit = sweep(xEnd, c.offset[0] + c.dims[0], u.pos[1], yEnd, u.pos[2], zTop)
      else if (axis === '-x') hit = sweep(c.offset[0], u.pos[0], u.pos[1], yEnd, u.pos[2], zTop)
      else if (axis === '+y') hit = sweep(u.pos[0], xEnd, yEnd, c.offset[1] + c.dims[1], u.pos[2], zTop)
      else hit = sweep(u.pos[0], xEnd, c.offset[1], u.pos[1], u.pos[2], zTop)
      if (hit) return { ok: false, reason: `stop ${s}: ${u.id} cannot be carried in past the ${axis} door — cargo at ${hit}` }
    }
  }
  return { ok: true }
}

const mulberry32 = (seed: number) => {
  let a = seed >>> 0
  return () => {
    a += 0x6d2b79f5
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
const mkShip = (name: string, scu: number): Ship => ({ id: 1, name, scu, containerSizes: [1, 2, 4, 8, 16, 32] })

function planeResolver(pts: [number, number][]): DistanceResolver {
  return {
    between(a, b) {
      if (a === b) return { gm: 0, estimated: false, unreachable: false }
      const pa = pts[Number(a.slice(1))]
      const pb = pts[Number(b.slice(1))]
      return { gm: Math.round(Math.hypot(pa[0] - pb[0], pa[1] - pb[1])), estimated: false, unreachable: false }
    },
  }
}

// --- (A) checklist-order insertion audit: same-stop loads in plan action order ---

function compOf(b: LoadoutBox, comps: Compartment[]): number {
  return comps.findIndex((c) =>
    b.pos[0] >= c.offset[0] && b.pos[0] + b.dims[0] <= c.offset[0] + c.dims[0] &&
    b.pos[1] >= c.offset[1] && b.pos[1] + b.dims[1] <= c.offset[1] + c.dims[1] &&
    b.pos[2] >= c.offset[2] && b.pos[2] + b.dims[2] <= c.offset[2] + c.dims[2])
}

function auditChecklistOrder(plan: RoutePlan, comps: Compartment[]): { ok: true } | { ok: false; reason: string } {
  const boxes = plan.loadout!
  const byId = new Map(boxes.map((b) => [b.id, b]))
  const byLeg = new Map<string, LoadoutBox[]>()
  for (const b of boxes) {
    const arr = byLeg.get(`${b.missionId}:${b.legId}`)
    if (arr) arr.push(b)
    else byLeg.set(`${b.missionId}:${b.legId}`, [b])
  }
  // Replay the ACTUAL checklist (buildRouteSteps) box by box over live occupancy:
  // every load must have a clear way in at the moment its step reaches it. Steps
  // carrying boxIds are followed verbatim; legacy steps move their legs' boxes in
  // listed order.
  const cells = new Set<string>()
  const eachCell = (b: LoadoutBox, f: (k: string) => void) => {
    const ci = compOf(b, comps)
    for (let z = b.pos[2]; z < b.pos[2] + b.dims[2]; z++)
      for (let y = b.pos[1]; y < b.pos[1] + b.dims[1]; y++)
        for (let x = b.pos[0]; x < b.pos[0] + b.dims[0]; x++) f(`${x},${y},${z},${ci}`)
  }
  for (const step of buildRouteSteps(plan)) {
    const stepBoxes = step.boxIds
      ? step.boxIds.flatMap((id) => byId.get(id) ?? [])
      : step.actions.flatMap((a) =>
          (byLeg.get(`${a.missionId}:${a.legId}`) ?? []).filter((b) =>
            step.kind === 'load' ? b.loadStop === step.stopIndex : b.deliverStop === step.stopIndex,
          ),
        )
    if (step.kind === 'unload') {
      for (const b of stepBoxes) eachCell(b, (k) => cells.delete(k))
      continue
    }
    for (const u of stepBoxes) {
      const ci = compOf(u, comps)
      const c = comps[ci]
      const model = compartmentBlocking(c)
      if (model === 'none') { eachCell(u, (k) => cells.add(k)); continue }
      const has = (x0: number, x1: number, y0: number, y1: number, z0: number, z1: number): string | null => {
        for (let z = z0; z < z1; z++)
          for (let y = y0; y < y1; y++)
            for (let x = x0; x < x1; x++) if (cells.has(`${x},${y},${z},${ci}`)) return `${x},${y},${z}`
        return null
      }
      const xEnd = u.pos[0] + u.dims[0]
      const yEnd = u.pos[1] + u.dims[1]
      const zTop = u.pos[2] + u.dims[2]
      let hit: string | null
      if (model === 'vertical') hit = has(u.pos[0], xEnd, u.pos[1], yEnd, zTop, c.offset[2] + c.dims[2])
      else {
        const axis = compartmentOpeningAxis(c)
        if (axis === '+x') hit = has(xEnd, c.offset[0] + c.dims[0], u.pos[1], yEnd, u.pos[2], zTop)
        else if (axis === '-x') hit = has(c.offset[0], u.pos[0], u.pos[1], yEnd, u.pos[2], zTop)
        else if (axis === '+y') hit = has(u.pos[0], xEnd, yEnd, c.offset[1] + c.dims[1], u.pos[2], zTop)
        else hit = has(u.pos[0], xEnd, c.offset[1], u.pos[1], u.pos[2], zTop)
      }
      if (hit) {
        return { ok: false, reason: `stop ${step.stopIndex}: loading ${u.missionId}:${u.legId} (${u.id}) in checklist order is blocked at ${hit}` }
      }
      eachCell(u, (k) => cells.add(k))
    }
  }
  return { ok: true }
}

// --- instances ---

function genGridB(rng: () => number, N: number): { legs: PlannerLeg[]; resolver: DistanceResolver } {
  const pts: [number, number][] = Array.from({ length: N }, () => [rng() * 200, rng() * 200])
  const resolver = planeResolver(pts)
  const legs: PlannerLeg[] = []
  let id = 0
  const add = (p: number, q: number, scu: number) =>
    legs.push({ id: `l${id++}`, missionId: `m${1 + (id % 3)}`, commodity: 'Waste', scu, maxBoxScu: 8, pickupId: `S${p}`, dropoffId: `S${q}` })
  for (let i = 1; i < N; i++) add(0, i, 8 + Math.floor(rng() * 33))
  const extras = Math.floor(rng() * 2)
  for (let e = 0; e < extras; e++) {
    const p = Math.floor(rng() * N)
    let q = Math.floor(rng() * N)
    if (q === p) q = (q + 1) % N
    add(p, q, 8 + Math.floor(rng() * 25))
  }
  const total = legs.reduce((a, l) => a + l.scu, 0)
  if (total > 160) {
    const f = 160 / total
    for (const l of legs) l.scu = Math.max(4, Math.floor(l.scu * f))
  }
  return { legs, resolver }
}

/** Hermes-like custom grid: two long v+depth bays, doors at -y. */
const HERMES_LIKE: Compartment[] = [
  { offset: [0, 0, 0], dims: [4, 12, 3], blockingModel: 'vertical+depth', openingAxis: '-y' },
  { offset: [6, 0, 0], dims: [4, 12, 3], blockingModel: 'vertical+depth', openingAxis: '-y' },
]

function genHermesLike(rng: () => number): { legs: PlannerLeg[]; resolver: DistanceResolver } {
  const N = 5 + Math.floor(rng() * 3)
  const pts: [number, number][] = Array.from({ length: N }, () => [rng() * 300, rng() * 300])
  const resolver = planeResolver(pts)
  const legs: PlannerLeg[] = []
  let id = 0
  const add = (p: number, q: number, scu: number) =>
    legs.push({ id: `l${id++}`, missionId: `m${1 + (id % 4)}`, commodity: 'Waste', scu, maxBoxScu: 8, pickupId: `S${p}`, dropoffId: `S${q}` })
  for (let v = 1; v < N; v++) add(0, v, 20 + Math.floor(rng() * 60))
  const extras = 1 + Math.floor(rng() * 3)
  for (let e = 0; e < extras; e++) {
    const p = rng() < 0.5 ? 0 : Math.floor(rng() * (N - 1))
    const q = p + 1 + Math.floor(rng() * (N - 1 - p))
    add(p, q, 15 + Math.floor(rng() * 40))
  }
  const cap = gridCapacity(HERMES_LIKE)
  const total = legs.reduce((a, l) => a + l.scu, 0)
  if (total > cap * 0.8) {
    const f = (cap * 0.8) / total
    for (const l of legs) l.scu = Math.max(4, Math.floor(l.scu * f))
  }
  return { legs, resolver }
}

describe('insertion audit: loading paths of produced plans', () => {
  it('model-gap (B) violations are impossible; checklist-order (A) is measured', { timeout: 600_000 }, () => {
    const rows: string[] = []
    let planCount = 0
    let aViol = 0
    let bViol = 0
    const aExamples: string[] = []
    const bExamples: string[] = []

    const study = (label: string, legs: PlannerLeg[], resolver: DistanceResolver, comps: Compartment[], ship: Ship) => {
      // Node-budget gate sized for suite runtime: grinding (unknown-heavy)
      // instances cost ~11 nodes/ms, so 10k nodes ≈ the old 300ms-wall gate on
      // the machine it was tuned on — but deterministic everywhere.
      const plan = optimizeRoute(legs, ship, resolver, { compartments: comps, oracleNodeBudget: 10_000, timeBudgetMs: 6000 })
      if (!plan.feasible || !plan.loadout) {
        rows.push(`  ${label}: infeasible/no loadout — skipped`)
        return
      }
      planCount++
      const a = auditChecklistOrder(plan, comps)
      const b = auditLoadFree(plan.loadout, comps)
      if (!a.ok) {
        aViol++
        if (aExamples.length < 3) aExamples.push(`${label}: ${a.reason}`)
        // Is this a genuine LEG-LEVEL CYCLE (mutual obstruction), or an ordering bug?
        const boxes = plan.loadout!
        for (let s = 0; s < plan.stops.length; s++) {
          const loadKeys = plan.stops[s].actions.filter((x) => x.kind === 'load').map((x) => `${x.missionId}:${x.legId}`)
          const bs = loadKeys.map((k) => boxes.filter((b) => `${b.missionId}:${b.legId}` === k && b.loadStop === s))
          const ovl = (a0: number, a1: number, b0: number, b1: number) => a0 < b1 && b0 < a1
          const obstructs = (p: LoadoutBox, q: LoadoutBox): boolean => {
            const ci = compOf(q, comps)
            if (ci < 0 || compOf(p, comps) !== ci) return false
            const c = comps[ci]
            const model = compartmentBlocking(c)
            if (model === 'none') return false
            if (model === 'vertical') {
              return ovl(p.pos[0], p.pos[0] + p.dims[0], q.pos[0], q.pos[0] + q.dims[0]) &&
                ovl(p.pos[1], p.pos[1] + p.dims[1], q.pos[1], q.pos[1] + q.dims[1]) &&
                ovl(p.pos[2], p.pos[2] + p.dims[2], q.pos[2] + q.dims[2], c.offset[2] + c.dims[2])
            }
            if (!ovl(p.pos[2], p.pos[2] + p.dims[2], q.pos[2], q.pos[2] + q.dims[2])) return false
            const ax = compartmentOpeningAxis(c)
            if (ax === '+x') return ovl(p.pos[1], p.pos[1] + p.dims[1], q.pos[1], q.pos[1] + q.dims[1]) && ovl(p.pos[0], p.pos[0] + p.dims[0], q.pos[0] + q.dims[0], c.offset[0] + c.dims[0])
            if (ax === '-x') return ovl(p.pos[1], p.pos[1] + p.dims[1], q.pos[1], q.pos[1] + q.dims[1]) && ovl(p.pos[0], p.pos[0] + p.dims[0], c.offset[0], q.pos[0])
            if (ax === '+y') return ovl(p.pos[0], p.pos[0] + p.dims[0], q.pos[0], q.pos[0] + q.dims[0]) && ovl(p.pos[1], p.pos[1] + p.dims[1], q.pos[1] + q.dims[1], c.offset[1] + c.dims[1])
            return ovl(p.pos[0], p.pos[0] + p.dims[0], q.pos[0], q.pos[0] + q.dims[0]) && ovl(p.pos[1], p.pos[1] + p.dims[1], c.offset[1], q.pos[1])
          }
          for (let i = 0; i < loadKeys.length; i++)
            for (let j = i + 1; j < loadKeys.length; j++) {
              const iBlocksJ = bs[i].some((p) => bs[j].some((q) => obstructs(p, q)))
              const jBlocksI = bs[j].some((p) => bs[i].some((q) => obstructs(p, q)))
              if (iBlocksJ && jBlocksI && aExamples.length < 6)
                aExamples.push(`${label}: CYCLE at stop ${s} — ${loadKeys[i]} ⇄ ${loadKeys[j]} mutually obstruct`)
            }
        }
      }
      if (!b.ok) {
        bViol++
        if (bExamples.length < 3) bExamples.push(`${label}: ${b.reason}`)
      }
      rows.push(`  ${label}: checklist-order ${a.ok ? 'ok' : 'BLOCKED'} | order-free ${b.ok ? 'ok' : 'BLOCKED'}`)
    }

    // Railen fixture (vertical pods, mid-route pickup at Rod's Fuel).
    {
      const railen = SHIP_GRIDS.find((g) => g.match === 'Railen')!.compartments
      const loc = ['Ruin', 'Stanton Gateway', 'Starlight', 'Megumi', "Rat's Nest", 'Checkmate', "Rod's Fuel"]
      const idx = (name: string) => `S${loc.indexOf(name)}`
      const resolver: DistanceResolver = {
        between: (a, b) => (a === b ? { gm: 0, estimated: false, unreachable: false }
          : { gm: Math.abs(Number(a.slice(1)) - Number(b.slice(1))) * 15, estimated: false, unreachable: false }),
      }
      const L = (id: string, m: string, c: string, scu: number, from: string, to: string): PlannerLeg =>
        ({ id, missionId: m, commodity: c, scu, maxBoxScu: 8, pickupId: idx(from), dropoffId: idx(to) })
      const legs: PlannerLeg[] = [
        L('m1a', 'M1', 'Waste', 72, 'Ruin', 'Stanton Gateway'), L('m1b', 'M1', 'Waste', 67, 'Ruin', 'Starlight'),
        L('m2a', 'M2', 'Waste', 59, 'Ruin', 'Megumi'), L('m2b', 'M2', 'Waste', 41, 'Ruin', "Rat's Nest"), L('m2c', 'M2', 'Waste', 58, 'Ruin', 'Starlight'),
        L('m3a', 'M3', 'Potassium', 61, "Rod's Fuel", 'Ruin'),
        L('m4a', 'M4', 'Waste', 43, 'Ruin', 'Checkmate'), L('m4b', 'M4', 'Waste', 23, 'Ruin', "Rod's Fuel"), L('m4c', 'M4', 'Waste', 94, 'Ruin', 'Stanton Gateway'),
        L('m5a', 'M5', 'Waste', 88, 'Ruin', 'Stanton Gateway'), L('m5b', 'M5', 'Waste', 78, 'Ruin', 'Starlight'),
      ]
      study('Railen fixture (vertical pods)', legs, resolver, railen, mkShip('Gatac Railen', 640))
    }

    // RAFT (single v+depth bay), suite-B style instances.
    {
      const raft = SHIP_GRIDS.find((g) => g.match === 'RAFT')!.compartments
      const ship = mkShip('Argo RAFT', gridCapacity(raft))
      for (let k = 0; k < 10; k++) {
        const N = 5 + (k % 2)
        const { legs, resolver } = genGridB(mulberry32((N === 5 ? 50_000 : 60_000) + k), N)
        study(`RAFT seed=${(N === 5 ? 50_000 : 60_000) + k}`, legs, resolver, raft, ship)
      }
    }

    // Hermes-like two-bay v+depth custom grid.
    {
      const ship = mkShip('RSI Hermes-like', gridCapacity(HERMES_LIKE))
      for (let k = 0; k < 8; k++) {
        const { legs, resolver } = genHermesLike(mulberry32(300_000 + k))
        study(`Hermes-like seed=${300_000 + k}`, legs, resolver, HERMES_LIKE, ship)
      }
    }

    console.log('\n=== insertion-path audit of current plans ===')
    for (const r of rows) console.log(r)
    console.log(`  plans audited: ${planCount}`)
    console.log(`  (A) checklist-order violations: ${aViol}/${planCount}`)
    for (const e of aExamples) console.log(`      e.g. ${e}`)
    console.log(`  (B) order-free (model gap) violations: ${bViol}/${planCount}`)
    for (const e of bExamples) console.log(`      e.g. ${e}`)
    console.log('')
    expect(planCount).toBeGreaterThan(0)
    // GATES (were measurements):
    //  (B) the oracle's insertOk makes model-gap violations structurally
    //      impossible — every witness box has a clear way in past cargo already
    //      onboard when it loads;
    //  (A) the checklist's opOrder (topological over blocking pairs) makes every
    //      plan executable exactly as written, step by step, box by box.
    expect(bViol).toBe(0)
    expect(aViol).toBe(0)
  })
})
