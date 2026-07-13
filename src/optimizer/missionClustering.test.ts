import { describe, it, expect } from 'vitest'
import { optimizeRoute, type PlannerLeg } from './pdp'
import { verifyWitness } from './loadFeasibility'
import { SHIP_GRIDS, type Compartment } from '../ships/grids'
import type { Ship, LoadoutBox } from '../domain/types'
import type { DistanceResolver } from './distanceMatrix'

// Mission-clustering diagnostic. The hard-LIFO oracle guarantees a dig-free unload,
// but its placement is mission-AGNOSTIC: identical-looking cargo of different
// missions gets scattered/mixed across the hold, which is tedious to gather at a
// per-mission freight elevator. This measures how mixed a witness is, so the soft
// clustering bias can be shown to reduce it WITHOUT breaking feasibility.

interface MixingMetrics {
  totalBoxes: number
  podsUsed: number
  mixedPods: number
  crossMissionStacks: number
  podSpread: Record<string, number>
}

/** Which compartment a placed box lives in (by position containment). */
function compOf(b: LoadoutBox, comps: Compartment[]): number {
  return comps.findIndex((c) =>
    b.pos[0] >= c.offset[0] && b.pos[0] + b.dims[0] <= c.offset[0] + c.dims[0] &&
    b.pos[1] >= c.offset[1] && b.pos[1] + b.dims[1] <= c.offset[1] + c.dims[1] &&
    b.pos[2] >= c.offset[2] && b.pos[2] + b.dims[2] <= c.offset[2] + c.dims[2])
}

const xyOverlap = (a: LoadoutBox, b: LoadoutBox) =>
  a.pos[0] < b.pos[0] + b.dims[0] && b.pos[0] < a.pos[0] + a.dims[0] &&
  a.pos[1] < b.pos[1] + b.dims[1] && b.pos[1] < a.pos[1] + a.dims[1]

/** Measure mixing over a set of simultaneously-onboard boxes. */
function mixingMetrics(boxes: LoadoutBox[], comps: Compartment[]): MixingMetrics {
  const byPod = new Map<number, LoadoutBox[]>()
  for (const b of boxes) {
    const ci = compOf(b, comps)
    const arr = byPod.get(ci)
    if (arr) arr.push(b)
    else byPod.set(ci, [b])
  }

  let mixedPods = 0
  for (const arr of byPod.values()) {
    if (new Set(arr.map((b) => b.missionId)).size > 1) mixedPods++
  }

  // A box rests on a DIFFERENT mission's box if any box directly below its
  // footprint (top face touching its bottom, in the same pod) is another mission.
  let crossMissionStacks = 0
  for (const b of boxes) {
    const ci = compOf(b, comps)
    if (b.pos[2] === comps[ci].offset[2]) continue // on the pod floor
    const below = (byPod.get(ci) ?? []).filter(
      (o) => o !== b && o.pos[2] + o.dims[2] === b.pos[2] && xyOverlap(o, b),
    )
    if (below.some((o) => o.missionId !== b.missionId)) crossMissionStacks++
  }

  const podsByMission = new Map<string, Set<number>>()
  for (const b of boxes) {
    const set = podsByMission.get(b.missionId) ?? new Set<number>()
    set.add(compOf(b, comps))
    podsByMission.set(b.missionId, set)
  }
  const podSpread: Record<string, number> = {}
  for (const [m, set] of podsByMission) podSpread[m] = set.size

  return { totalBoxes: boxes.length, podsUsed: byPod.size, mixedPods, crossMissionStacks, podSpread }
}

// The real Railen 4-mission subset (all picked up at Ruin Station, 600/640 SCU peak).
// Same as railenSample.test.ts Phase 2, which produces an 84-box dig-free witness.
function railenSample() {
  const railen = SHIP_GRIDS.find((g) => g.match === 'Railen')!.compartments
  const loc = ['Ruin', 'Stanton Gateway', 'Starlight', 'Megumi', "Rat's Nest", 'Checkmate']
  const idx = (name: string) => `S${loc.indexOf(name)}`
  const resolver: DistanceResolver = {
    between: (a, b) => (a === b ? { gm: 0, estimated: false, unreachable: false }
      : { gm: Math.abs(Number(a.slice(1)) - Number(b.slice(1))) * 15, estimated: false, unreachable: false }),
  }
  const ship: Ship = { id: 1, name: 'Gatac Railen', scu: 640, containerSizes: [1, 2, 4, 8, 16, 32] }
  const L = (id: string, m: string, scu: number, from: string, to: string): PlannerLeg =>
    ({ id, missionId: m, commodity: 'Waste', scu, maxBoxScu: 8, pickupId: idx(from), dropoffId: idx(to) })
  const legs: PlannerLeg[] = [
    L('m1a', 'M1', 72, 'Ruin', 'Stanton Gateway'), L('m1b', 'M1', 67, 'Ruin', 'Starlight'),
    L('m2a', 'M2', 59, 'Ruin', 'Megumi'), L('m2b', 'M2', 41, 'Ruin', "Rat's Nest"), L('m2c', 'M2', 58, 'Ruin', 'Starlight'),
    L('m4a', 'M4', 43, 'Ruin', 'Checkmate'), L('m4c', 'M4', 94, 'Ruin', 'Stanton Gateway'),
    L('m5a', 'M5', 88, 'Ruin', 'Stanton Gateway'), L('m5b', 'M5', 78, 'Ruin', 'Starlight'),
  ]
  return { railen, legs, ship, resolver }
}

describe('mission clustering in the loadout', () => {
  it('Railen 4-mission peak load: soft clustering keeps missions together (dig-free unchanged)', () => {
    const { railen, legs, ship, resolver } = railenSample()
    const plan = optimizeRoute(legs, ship, resolver, { compartments: railen, oracleNodeBudget: 200_000 })

    expect(plan.feasible).toBe(true)
    expect(plan.loadout).toBeDefined()
    // Hard constraint: the witness is still a valid dig-free loadout.
    expect(verifyWitness(plan.loadout!, railen)).toBe(true)

    // Peak interval: everything loaded at stop 0, nothing yet delivered.
    const peak = plan.loadout!.filter((b) => b.loadStop <= 0 && b.deliverStop > 0)
    const m = mixingMetrics(peak, railen)

    const spreadSum = Object.values(m.podSpread).reduce((a, b) => a + b, 0)

    // PRIMARY objective (user decision 2026-07-04): destination cohesion —
    // "this stop = this pod". Count how many pods each delivery stop's cargo
    // occupies at the peak.
    const zonesByStop = new Map<number, Set<number>>()
    for (const b of plan.loadout!) {
      const set = zonesByStop.get(b.deliverStop) ?? new Set<number>()
      set.add(compOf(b, railen))
      zonesByStop.set(b.deliverStop, set)
    }
    const zoneSizes = [...zonesByStop.values()].map((s) => s.size)
    const avgZonesPerStop = zoneSizes.reduce((a, b) => a + b, 0) / zoneSizes.length

    /* eslint-disable no-console */
    console.log(`\n=== Railen 4-mission mixing metrics (${m.totalBoxes} boxes, ${m.podsUsed} pods) ===`)
    console.log(`zones per delivery stop (avg):  ${Math.round(avgZonesPerStop * 10) / 10}`)
    console.log(`mixed pods (>1 mission):        ${m.mixedPods} / ${m.podsUsed}`)
    console.log(`cross-mission stacks (on-top):  ${m.crossMissionStacks} / ${m.totalBoxes}`)
    console.log(`per-mission pod spread:         ${Object.entries(m.podSpread).map(([k, v]) => `${k}→${v}`).join('  ')}  (sum ${spreadSum})`)
    console.log('')
    /* eslint-enable no-console */

    // Regression guards for the DESTINATION-FIRST hierarchy (user decision
    // 2026-07-04): a delivery stop's cargo should be gathered in few pods, and
    // missions stay separated only INSIDE that constraint. Reference points on
    // this fixture: mission-agnostic packer ≈ 2.4+ zones/stop, 6/6 mixed pods,
    // 32/84 cross-mission stacks, spread sum 16; destination-zoned witness
    // measures 1.8 zones/stop, 4/6, 20/84, sum 11. Thresholds sit between the
    // zoned result and the scattered baseline so regressions fail loudly.
    expect(avgZonesPerStop).toBeLessThanOrEqual(2.0)
    expect(m.mixedPods).toBeLessThanOrEqual(5)
    expect(m.crossMissionStacks).toBeLessThanOrEqual(26)
    expect(spreadSum).toBeLessThanOrEqual(14)
  })
})
