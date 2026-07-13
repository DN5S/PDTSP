// Door-aware placement diagnostic — NOT part of the regular suite (guarded by
// VITE_VERIFY). Run with:
//   PowerShell:  $env:VITE_VERIFY='1'; npx vitest run src/optimizer/doorPlacement.test.ts
//
// Hypothesis (user report): the oracle's candidate sweep ignores the
// compartment's opening axis — it always scans z↑, y↑, x↑ from the offset
// corner. For '-x'/'-y' doors that means cargo is packed AGAINST THE DOOR
// first; for x-axis doors the y-outer sweep strings boxes along a wall lane
// all the way to the door. Both are physically awkward to load in game.
//
// Metric: mean normalized door-closeness of box centers along the door axis
// (0 = flush against the deep wall, 1 = at the door plane). A convenient
// loadout should be LOW when the hold is half-full.

import { describe, it, expect } from 'vitest'
import { oracle, verifyWitness, type OracleItem } from './loadFeasibility'
import { validateGeometry, auditDigFree } from './witnessAudit'
import { compartmentOpeningAxis, type Compartment } from '../ships/grids'
import type { Dims3 } from './packPrimitives'

const B8: Dims3 = [2, 2, 2]
const mk = (legId: string, loadStop: number, deliverStop: number, boxes: Dims3[]): OracleItem => ({
  legId, missionId: legId, commodity: 'X',
  scu: boxes.reduce((a, b) => a + b[0] * b[1] * b[2], 0),
  boxes, loadStop, deliverStop,
})

const f2 = (x: number) => Math.round(x * 100) / 100

function doorCloseness(comp: Compartment, boxes: { pos: [number, number, number]; dims: [number, number, number] }[]): number {
  const axis = compartmentOpeningAxis(comp)
  const vals = boxes.map((b) => {
    const cx = (b.pos[0] - comp.offset[0]) + b.dims[0] / 2
    const cy = (b.pos[1] - comp.offset[1]) + b.dims[1] / 2
    switch (axis) {
      case '+x': return cx / comp.dims[0]
      case '-x': return 1 - cx / comp.dims[0]
      case '+y': return cy / comp.dims[1]
      case '-y': return 1 - cy / comp.dims[1]
    }
  })
  return vals.reduce((a, b) => a + b, 0) / Math.max(vals.length, 1)
}

const RUN = import.meta.env.VITE_VERIFY === '1'
const d = RUN ? describe : describe.skip

d('door-aware placement diagnostic', () => {
  it('measures door-closeness of half-full single-mission loads per opening axis', { timeout: 60_000 }, () => {
    console.log('\n=== door-closeness (0 = deep wall, 1 = door) — half-full, single mission ===')
    const cases: { label: string; comp: Compartment }[] = [
      { label: "door +y (y-outer sweep, deep=y0)  ", comp: { offset: [0, 0, 0], dims: [4, 8, 2], blockingModel: 'vertical+depth', openingAxis: '+y' } },
      { label: "door -y (y-outer sweep, deep=yMAX)", comp: { offset: [0, 0, 0], dims: [4, 8, 2], blockingModel: 'vertical+depth', openingAxis: '-y' } },
      { label: "door +x (x is DEPTH, deep=x0)     ", comp: { offset: [0, 0, 0], dims: [8, 4, 2], blockingModel: 'vertical+depth', openingAxis: '+x' } },
      { label: "door -x (x is DEPTH, deep=xMAX)   ", comp: { offset: [0, 0, 0], dims: [8, 4, 2], blockingModel: 'vertical+depth', openingAxis: '-x' } },
    ]
    for (const c of cases) {
      // 4 x 8-SCU boxes = 32 SCU into a 64-SCU hold (half full).
      const v = oracle([mk('a', 0, 1, [B8, B8, B8, B8])], [c.comp], { nodeBudget: 200_000 })
      if (v.status !== 'feasible') {
        console.log(`  ${c.label}: ${v.status}`)
        continue
      }
      const geo = validateGeometry(v.boxes, [c.comp])
      const dig = auditDigFree(v.boxes, [c.comp])
      const lifo = verifyWitness(v.boxes, [c.comp])
      const closeness = doorCloseness(c.comp, v.boxes)
      const poss = v.boxes.map((b) => `(${b.pos.join(',')})`).join(' ')
      console.log(`  ${c.label}: closeness ${f2(closeness)}  audits ${geo.ok && dig.ok && lifo ? 'ok' : 'FAIL'}  boxes ${poss}`)
    }

    // Two-mission LIFO case on a '-y' door: later-delivered must sit deeper
    // (high y); earlier-delivered toward the door. Check both position order
    // and overall closeness.
    {
      const comp: Compartment = { offset: [0, 0, 0], dims: [4, 8, 2], blockingModel: 'vertical+depth', openingAxis: '-y' }
      const A = mk('early', 0, 1, [B8, B8])
      const B = mk('late', 0, 2, [B8, B8])
      const v = oracle([A, B], [comp], { nodeBudget: 200_000 })
      if (v.status === 'feasible') {
        const early = v.boxes.filter((b) => b.legId === 'early')
        const late = v.boxes.filter((b) => b.legId === 'late')
        const avgY = (bs: typeof early) => bs.reduce((a, b) => a + b.pos[1], 0) / bs.length
        console.log(
          `  door -y two missions: early avg y ${f2(avgY(early))} (door side = LOW y), late avg y ${f2(avgY(late))}` +
            `  | closeness ${f2(doorCloseness(comp, v.boxes))} | lifo ${verifyWitness(v.boxes, [comp])}`,
        )
      } else {
        console.log(`  door -y two missions: ${v.status}`)
      }
    }
    console.log('')
    expect(true).toBe(true)
  })
})
