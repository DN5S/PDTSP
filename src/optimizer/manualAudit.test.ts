// "IKEA manual" simulator — runs in the regular suite as a GATE: no produced
// checklist may contain a blocked step (baseline 2026-07-07, action-order
// checklists: 37 blocked / 26 interleave over 24 plans; opOrder checklists:
// 0 / 0).
//
// The 3D loadout + step checklist IS an instruction manual the player follows
// in game. This harness follows it page by page and grades every step:
//   ok         — doable exactly as written, in the order written
//   interleave — doable, but only by alternating boxes with ANOTHER step at
//                the same stop (annoying; a manual footnote would be needed)
//   blocked    — no within-stop order makes it possible (real manual defect:
//                digging or a walled-off position)
// Loads are checked for insertion paths, unloads for extraction paths — the
// latter is NEW coverage: auditDigFree treats a stop's unloads as one batch,
// but the manual lists them leg by leg.
//
// Usefulness test: (1) does it catch real defects in CURRENT plans?
// (2) does it quantify how much destination zoning improved the manual?

import { describe, it, expect } from 'vitest'
import { optimizeRoute, type PlannerLeg } from './pdp'
import { buildRouteSteps } from './loadout'
import { clusteredWitness, itemsFromPlan } from './loadFeasibility'
import { computeOpOrder } from './stepOrder'
import { SHIP_GRIDS, gridCapacity, compartmentBlocking, compartmentOpeningAxis, type Compartment } from '../ships/grids'
import type { Ship, RoutePlan, LoadoutBox } from '../domain/types'
import type { DistanceResolver } from './distanceMatrix'

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
const f1 = (x: number) => Math.round(x * 10) / 10
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

// --- the manual simulator ---

interface ManualReport {
  ok: number
  interleave: number
  blocked: number
  notes: string[]
}

function compOf(b: LoadoutBox, comps: Compartment[]): number {
  return comps.findIndex((c) =>
    b.pos[0] >= c.offset[0] && b.pos[0] + b.dims[0] <= c.offset[0] + c.dims[0] &&
    b.pos[1] >= c.offset[1] && b.pos[1] + b.dims[1] <= c.offset[1] + c.dims[1] &&
    b.pos[2] >= c.offset[2] && b.pos[2] + b.dims[2] <= c.offset[2] + c.dims[2])
}

function simulateManual(plan: RoutePlan, comps: Compartment[]): ManualReport {
  const boxes = plan.loadout!
  const report: ManualReport = { ok: 0, interleave: 0, blocked: 0, notes: [] }

  // Present-cargo state as an occupancy map (global cells; compartments are disjoint).
  const cells = new Map<string, string>() // cellKey -> boxId
  const presentIds = new Set<string>()
  const cellsOf = (b: LoadoutBox): string[] => {
    const out: string[] = []
    for (let z = b.pos[2]; z < b.pos[2] + b.dims[2]; z++)
      for (let y = b.pos[1]; y < b.pos[1] + b.dims[1]; y++)
        for (let x = b.pos[0]; x < b.pos[0] + b.dims[0]; x++) out.push(`${x},${y},${z}`)
    return out
  }
  const put = (b: LoadoutBox) => {
    presentIds.add(b.id)
    for (const k of cellsOf(b)) cells.set(k, b.id)
  }
  const take = (b: LoadoutBox) => {
    presentIds.delete(b.id)
    for (const k of cellsOf(b)) cells.delete(k)
  }
  const occupiedByOther = (x0: number, x1: number, y0: number, y1: number, z0: number, z1: number, selfId: string): boolean => {
    for (let z = z0; z < z1; z++)
      for (let y = y0; y < y1; y++)
        for (let x = x0; x < x1; x++) {
          const id = cells.get(`${x},${y},${z}`)
          if (id !== undefined && id !== selfId) return true
        }
    return false
  }

  // Path check (same for carrying IN and OUT — the tunnel/column geometry is
  // symmetric): 'vertical' needs the column above clear; 'vertical+depth' needs
  // nothing resting on top AND the door tunnel clear.
  const pathClear = (b: LoadoutBox, forInsert: boolean): boolean => {
    const ci = compOf(b, comps)
    if (ci < 0) return false
    const c = comps[ci]
    const model = compartmentBlocking(c)
    if (model === 'none') return true
    const xEnd = b.pos[0] + b.dims[0]
    const yEnd = b.pos[1] + b.dims[1]
    const zTop = b.pos[2] + b.dims[2]
    if (model === 'vertical') {
      return !occupiedByOther(b.pos[0], xEnd, b.pos[1], yEnd, zTop, c.offset[2] + c.dims[2], b.id)
    }
    // vertical+depth: extraction additionally requires nothing resting on top.
    if (!forInsert && occupiedByOther(b.pos[0], xEnd, b.pos[1], yEnd, zTop, zTop + 1, b.id)) return false
    const axis = compartmentOpeningAxis(c)
    if (axis === '+x') return !occupiedByOther(xEnd, c.offset[0] + c.dims[0], b.pos[1], yEnd, b.pos[2], zTop, b.id)
    if (axis === '-x') return !occupiedByOther(c.offset[0], b.pos[0], b.pos[1], yEnd, b.pos[2], zTop, b.id)
    if (axis === '+y') return !occupiedByOther(b.pos[0], xEnd, yEnd, c.offset[1] + c.dims[1], b.pos[2], zTop, b.id)
    return !occupiedByOther(b.pos[0], xEnd, c.offset[1], b.pos[1], b.pos[2], zTop, b.id)
  }

  // Distance from the door plane to the box's door-facing face (0 = at the
  // door). 'vertical'/'none' compartments have no horizontal door → 0.
  const doorDepth = (b: LoadoutBox): number => {
    const ci = compOf(b, comps)
    if (ci < 0) return 0
    const c = comps[ci]
    if (compartmentBlocking(c) !== 'vertical+depth') return 0
    switch (compartmentOpeningAxis(c)) {
      case '+x': return c.offset[0] + c.dims[0] - (b.pos[0] + b.dims[0])
      case '-x': return b.pos[0] - c.offset[0]
      case '+y': return c.offset[1] + c.dims[1] - (b.pos[1] + b.dims[1])
      case '-y': return b.pos[1] - c.offset[1]
    }
  }

  // Perform a set of movements the way a player would: carry IN deepest-first
  // and bottom-up, take OUT door-side-first and top-down. Greedy over that
  // order with a retry loop, so "leftovers" means no sensible order works.
  const perform = (todo: LoadoutBox[], forInsert: boolean): LoadoutBox[] => {
    const left = [...todo].sort((a, b) =>
      forInsert
        ? doorDepth(b) - doorDepth(a) || a.pos[2] - b.pos[2]
        : doorDepth(a) - doorDepth(b) || b.pos[2] - a.pos[2],
    )
    for (;;) {
      const i = left.findIndex((b) => pathClear(b, forInsert))
      if (i < 0) return left
      const b = left.splice(i, 1)[0]
      if (forInsert) put(b)
      else take(b)
      if (!left.length) return left
    }
  }

  // Follow the manual the player actually sees: buildRouteSteps' checklist. A
  // step with boxIds moves exactly those boxes (opOrder plans); legacy steps
  // move every box of their legs at that stop.
  const byId = new Map(boxes.map((b) => [b.id, b]))
  for (const step of buildRouteSteps(plan)) {
    const si = step.stopIndex
    const isLoad = step.kind === 'load'
    const stepBoxes = step.boxIds
      ? step.boxIds.flatMap((id) => byId.get(id) ?? [])
      : boxes.filter(
          (b) =>
            step.actions.some((a) => a.missionId === b.missionId && a.legId === b.legId) &&
            (isLoad ? b.loadStop === si : b.deliverStop === si),
        )
    if (!stepBoxes.length) continue
    const stepIdSet = new Set(stepBoxes.map((b) => b.id))
    const left = perform(stepBoxes, isLoad)
    if (!left.length) {
      report.ok++
      continue
    }
    // Rescue: allow interleaving with the OTHER same-stop moves of the same
    // kind (their boxes would move at this stop anyway).
    const peers = boxes.filter(
      (b) =>
        (isLoad ? b.loadStop === si : b.deliverStop === si) &&
        !stepIdSet.has(b.id) &&
        (isLoad ? !presentIds.has(b.id) : presentIds.has(b.id)),
    )
    const snapshotCells = new Map(cells)
    const snapshotIds = new Set(presentIds)
    const leftover = perform([...left, ...peers], isLoad)
    const thisStepDone = !leftover.some((b) => stepIdSet.has(b.id))
    // Restore, then force-apply ONLY this step so later steps are graded from
    // the manual's intended state.
    cells.clear()
    for (const [k, v] of snapshotCells) cells.set(k, v)
    presentIds.clear()
    for (const id of snapshotIds) presentIds.add(id)
    for (const b of left) (isLoad ? put : take)(b)
    if (thisStepDone) {
      report.interleave++
      report.notes.push(`stop ${si}: ${step.kind} ${step.missionId} needs interleaving with other ${step.kind}s`)
    } else {
      report.blocked++
      report.notes.push(`stop ${si}: ${step.kind} ${step.missionId} is BLOCKED (no within-stop order works)`)
    }
  }
  return report
}

// --- instances ---

function genRailen(rng: () => number, fillTarget: number): { legs: PlannerLeg[]; resolver: DistanceResolver } {
  const N = 5 + Math.floor(rng() * 3)
  const pts: [number, number][] = Array.from({ length: N }, () => [rng() * 400, rng() * 400])
  const resolver = planeResolver(pts)
  const legs: PlannerLeg[] = []
  let id = 0
  const add = (p: number, q: number, scu: number) =>
    legs.push({ id: `l${id++}`, missionId: `m${1 + (id % 4)}`, commodity: 'Waste', scu, maxBoxScu: 8, pickupId: `S${p}`, dropoffId: `S${q}` })
  for (let v = 1; v < N; v++) add(0, v, 30 + Math.floor(rng() * 70))
  const extras = 1 + Math.floor(rng() * 3)
  for (let e = 0; e < extras; e++) {
    const p = rng() < 0.7 ? 0 : Math.floor(rng() * (N - 1))
    const q = p + 1 + Math.floor(rng() * (N - 1 - p))
    add(p, q, 20 + Math.floor(rng() * 50))
  }
  const target = 640 * fillTarget
  const total = legs.reduce((a, l) => a + l.scu, 0)
  const f = target / total
  for (const l of legs) l.scu = Math.max(8, Math.round(l.scu * f))
  return { legs, resolver }
}

// Single 2-high layer (8-SCU boxes are 2 cells tall): double-layer v+depth
// bays sit in the oracle's known undecidable regime and every order gets
// rejected — a harness-realism trap, not a simulator concern.
const HERMES_LIKE: Compartment[] = [
  { offset: [0, 0, 0], dims: [4, 12, 2], blockingModel: 'vertical+depth', openingAxis: '-y' },
  { offset: [6, 0, 0], dims: [4, 12, 2], blockingModel: 'vertical+depth', openingAxis: '-y' },
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
  if (total > cap * 0.75) {
    const f = (cap * 0.75) / total
    for (const l of legs) l.scu = Math.max(4, Math.floor(l.scu * f))
  }
  return { legs, resolver }
}

describe('manual audit: follow every plan like an IKEA manual', () => {
  it('grades current plans and quantifies what zoning did for the manual', { timeout: 600_000 }, () => {
    const rows: string[] = []
    let plans = 0
    let cleanPlans = 0
    const agg = { ok: 0, interleave: 0, blocked: 0 }
    const aggBase = { ok: 0, interleave: 0, blocked: 0 }
    const examples: string[] = []

    const study = (label: string, legs: PlannerLeg[], resolver: DistanceResolver, comps: Compartment[], s: Ship) => {
      const plan = optimizeRoute(legs, s, resolver, { compartments: comps, oracleNodeBudget: 10_000, timeBudgetMs: 6000 })
      if (!plan.feasible || !plan.loadout) {
        rows.push(`  ${label}: infeasible — ${plan.reason ?? 'no loadout witness'}`)
        return
      }
      plans++
      const now = simulateManual(plan, comps)
      // Baseline: same route/steps, but the mission-clustered (pre-zoning) witness.
      const items = itemsFromPlan(legs, plan)
      const baseWitness = clusteredWitness(items, comps, { nodeBudget: 4000 })
      // The baseline witness needs its OWN execution order — reusing the zoned
      // witness's opOrder against different positions would grade a stale manual.
      const base = baseWitness
        ? simulateManual({ ...plan, loadout: baseWitness, opOrder: computeOpOrder(baseWitness, comps) }, comps)
        : null
      agg.ok += now.ok
      agg.interleave += now.interleave
      agg.blocked += now.blocked
      if (base) {
        aggBase.ok += base.ok
        aggBase.interleave += base.interleave
        aggBase.blocked += base.blocked
      }
      if (now.interleave === 0 && now.blocked === 0) cleanPlans++
      else if (examples.length < 4) examples.push(`${label}: ${now.notes[0]}`)
      rows.push(
        `  ${label}: steps ok ${now.ok} / interleave ${now.interleave} / blocked ${now.blocked}` +
          (base ? `   (pre-zoning witness: ${base.ok}/${base.interleave}/${base.blocked})` : ''),
      )
    }

    console.log('\n=== manual audit (ok / interleave / blocked steps per plan) ===')

    const railenComps = SHIP_GRIDS.find((g) => g.match === 'Railen')!.compartments
    const railenShip = mkShip('Gatac Railen', 640)
    for (const fill of [0.5, 0.65, 0.8]) {
      for (let k = 0; k < 4; k++) {
        const seed = Math.round(fill * 100) * 1000 + k
        const { legs, resolver } = genRailen(mulberry32(seed), fill)
        study(`Railen ${Math.round(fill * 100)}% seed=${seed}`, legs, resolver, railenComps, railenShip)
      }
    }

    const hermesShip = mkShip('Hermes-like', gridCapacity(HERMES_LIKE))
    for (let k = 0; k < 6; k++) {
      const { legs, resolver } = genHermesLike(mulberry32(400_000 + k))
      study(`Hermes-like seed=${400_000 + k}`, legs, resolver, HERMES_LIKE, hermesShip)
    }

    const raft = SHIP_GRIDS.find((g) => g.match === 'RAFT')!.compartments
    const raftShip = mkShip('Argo RAFT', gridCapacity(raft))
    for (let k = 0; k < 6; k++) {
      const rng = mulberry32(500_000 + k)
      const N = 4 + Math.floor(rng() * 2)
      const pts: [number, number][] = Array.from({ length: N }, () => [rng() * 200, rng() * 200])
      const resolver = planeResolver(pts)
      const legs: PlannerLeg[] = []
      for (let v = 1; v < N; v++)
        legs.push({ id: `l${v}`, missionId: `m${v}`, commodity: 'Waste', scu: 16 + Math.floor(rng() * 30), maxBoxScu: 8, pickupId: 'S0', dropoffId: `S${v}` })
      study(`RAFT seed=${500_000 + k}`, legs, resolver, raft, raftShip)
    }

    console.log(rows.join('\n'))
    const totalSteps = agg.ok + agg.interleave + agg.blocked
    const totalBase = aggBase.ok + aggBase.interleave + aggBase.blocked
    console.log(`  plans: ${plans}, fully-clean manuals: ${cleanPlans}`)
    console.log(
      `  steps now:        ok ${agg.ok}/${totalSteps} (${f1((agg.ok / Math.max(totalSteps, 1)) * 100)}%), interleave ${agg.interleave}, blocked ${agg.blocked}`,
    )
    console.log(
      `  steps pre-zoning: ok ${aggBase.ok}/${totalBase} (${f1((aggBase.ok / Math.max(totalBase, 1)) * 100)}%), interleave ${aggBase.interleave}, blocked ${aggBase.blocked}`,
    )
    for (const e of examples) console.log(`  e.g. ${e}`)
    console.log('')
    expect(plans).toBeGreaterThan(0)
    // GATE (was measurement): no produced checklist may contain a step with no
    // executable within-stop order — the opOrder checklist must be followable
    // exactly as written.
    expect(agg.blocked).toBe(0)
  })
})
