// Door-direction symmetry probe — NOT part of the regular suite (guarded by
// VITE_VERIFY). Run with:
//   PowerShell:  $env:VITE_VERIFY='1'; npx vitest run src/optimizer/doorSymmetry.test.ts
//
// Mathematical fact: a bay with door '-y' is the exact mirror image (y ↦ L-1-y)
// of the same bay with door '+y'. The mapping is a bijection preserving fits,
// support, and every blocking relation — so the two problems are EQUALLY
// feasible, always. Any verdict difference is therefore a solver artifact.
// This probe runs identical cargo through both orientations and reports the
// verdicts + time, and checks WHICH failure mode '-y' produces (it must be
// 'unknown-budget', i.e. search starvation — an 'infeasible-proven' would be a
// soundness bug).

import { describe, it, expect } from 'vitest'
import { oracle, type OracleItem } from './loadFeasibility'
import type { Compartment } from '../ships/grids'
import type { Dims3 } from './packPrimitives'

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

const bays = (axis: '+y' | '-y'): Compartment[] => [
  { offset: [0, 0, 0], dims: [4, 18, 2], blockingModel: 'vertical+depth', openingAxis: axis },
  { offset: [6, 0, 0], dims: [4, 18, 2], blockingModel: 'vertical+depth', openingAxis: axis },
]

const B8: Dims3 = [2, 2, 2]

/** Hub run: everything loads at stop 0, delivers at stops 1..S-1. */
function genItems(_rng: () => number, totalScu: number, S: number): OracleItem[] {
  const items: OracleItem[] = []
  const per = Math.floor(totalScu / (S - 1) / 8) * 8
  for (let v = 1; v < S; v++) {
    const boxes: Dims3[] = Array.from({ length: Math.max(1, per / 8) }, () => B8)
    items.push({
      legId: `l${v}`, missionId: `m${v}`, commodity: 'Waste',
      scu: boxes.length * 8, boxes, loadStop: 0, deliverStop: v,
    })
  }
  return items
}

const RUN = import.meta.env.VITE_VERIFY === '1'
const d = RUN ? describe : describe.skip

d('door symmetry: identical cargo, mirrored doors', () => {
  it("'+y' vs '-y' verdicts on the user's actual Hermes bay dimensions (4x18x2 x2)", { timeout: 600_000 }, () => {
    console.log("\n=== identical cargo, door '+y' vs '-y' (user's real Hermes dims) ===")
    const rows: string[] = []
    let asymmetries = 0
    let unsound = 0
    for (const fillPct of [50, 65, 80]) {
      for (let k = 0; k < 3; k++) {
        const rng = mulberry32(fillPct * 100 + k)
        const S = 4 + Math.floor(rng() * 3) // 4..6 stops
        const items = genItems(rng, Math.round((288 * fillPct) / 100), S)
        let t0 = performance.now()
        const plus = oracle(items, bays('+y'), { nodeBudget: 200_000 })
        const plusMs = performance.now() - t0
        t0 = performance.now()
        const minus = oracle(items, bays('-y'), { nodeBudget: 200_000 })
        const minusMs = performance.now() - t0
        if (plus.status !== minus.status) asymmetries++
        if (minus.status === 'infeasible-proven' && plus.status === 'feasible') unsound++
        rows.push(
          `  fill ${fillPct}% S=${S} (${items.reduce((a, i) => a + i.scu, 0)} SCU):` +
            `  +y → ${plus.status} (${f1(plusMs)}ms)   -y → ${minus.status} (${f1(minusMs)}ms)`,
        )
      }
    }
    console.log(rows.join('\n'))
    console.log(`  verdict asymmetries (mathematically impossible if solver were direction-neutral): ${asymmetries}/9`)
    console.log(`  soundness violations ('-y' PROVEN infeasible while '+y' feasible): ${unsound}\n`)
    expect(unsound).toBe(0) // proof claims must never differ — budget starvation may
  })
})
