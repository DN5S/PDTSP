import { describe, it, expect } from 'vitest'
import type { Compartment } from '../ships/grids'
import { handlingCost } from './handlingCost'
import { oracle, verifyWitness, type OracleItem } from './loadFeasibility'
import { bestWitnessForItems } from './witnessOptimizer'
import { validateGeometry, auditDigFree } from './witnessAudit'

const item = (id: string, deliverStop: number, boxes: [number, number, number][]): OracleItem => ({
  legId: id,
  missionId: id,
  commodity: 'Ore',
  scu: boxes.reduce((a, b) => a + b[0] * b[1] * b[2], 0),
  boxes,
  loadStop: 0,
  deliverStop,
})

function compOfBox(pos: [number, number, number], dims: [number, number, number], comps: Compartment[]): number {
  return comps.findIndex((c) =>
    pos[0] >= c.offset[0] && pos[0] + dims[0] <= c.offset[0] + c.dims[0] &&
    pos[1] >= c.offset[1] && pos[1] + dims[1] <= c.offset[1] + c.dims[1] &&
    pos[2] >= c.offset[2] && pos[2] + dims[2] <= c.offset[2] + c.dims[2])
}

function bboxGap(a: { minX: number; maxX: number; minY: number; maxY: number }, b: { minX: number; maxX: number; minY: number; maxY: number }): number {
  const gap = (a0: number, a1: number, b0: number, b1: number) => {
    if (a1 <= b0) return b0 - a1
    if (b1 <= a0) return a0 - b1
    return 0
  }
  return Math.max(gap(a.minX, a.maxX, b.minX, b.maxX), gap(a.minY, a.maxY, b.minY, b.maxY))
}

function stopBboxes(boxes: { deliverStop: number; pos: [number, number, number]; dims: [number, number, number] }[]) {
  const out = new Map<number, { minX: number; maxX: number; minY: number; maxY: number }>()
  for (const b of boxes) {
    const cur = out.get(b.deliverStop)
    const next = {
      minX: b.pos[0],
      maxX: b.pos[0] + b.dims[0],
      minY: b.pos[1],
      maxY: b.pos[1] + b.dims[1],
    }
    if (cur) {
      cur.minX = Math.min(cur.minX, next.minX)
      cur.maxX = Math.max(cur.maxX, next.maxX)
      cur.minY = Math.min(cur.minY, next.minY)
      cur.maxY = Math.max(cur.maxY, next.maxY)
    } else {
      out.set(b.deliverStop, next)
    }
  }
  return out
}

describe('bestWitnessForItems', () => {
  it('chooses a lower-handling witness for the same route in a large single hold', () => {
    const comp: Compartment[] = [{ offset: [0, 0, 0], dims: [10, 2, 2], blockingModel: 'vertical+depth', openingAxis: '+x' }]
    const items = [item('A', 1, [[2, 2, 2]])]
    const baseline = oracle(items, comp)
    expect(baseline.status).toBe('feasible')
    if (baseline.status !== 'feasible') throw new Error('baseline should be feasible')

    const best = bestWitnessForItems(items, comp, {
      seed: baseline.boxes,
      alphaMilli: 1000,
      deltaMilli: 0,
      nodeBudget: 2000,
    })
    expect(best).not.toBeNull()

    const baseH = handlingCost(baseline.boxes, comp)
    const bestH = handlingCost(best!, comp)
    expect(bestH.totalL).toBeLessThan(baseH.totalL)
    expect(best![0].pos[0]).toBeGreaterThan(baseline.boxes[0].pos[0])
    expect(verifyWitness(best!, comp)).toBe(true)
    expect(validateGeometry(best!, comp).ok).toBe(true)
    expect(auditDigFree(best!, comp)).toEqual({ ok: true })
  })

  it('soft delivery zones do not become hard virtual walls', () => {
    const comp: Compartment[] = [{ offset: [0, 0, 0], dims: [6, 2, 2], blockingModel: 'vertical+depth', openingAxis: '+x' }]
    const items = [
      item('A', 1, [[2, 2, 2]]),
      item('B', 2, [[2, 2, 2]]),
    ]
    const v = oracle(items, comp, { softZoneByDeliverStop: true, nodeBudget: 20_000 })
    expect(v.status).toBe('feasible')
    if (v.status !== 'feasible') throw new Error('soft-zone witness should be feasible')
    expect(verifyWitness(v.boxes, comp)).toBe(true)
  })

  it('prefers one delivery stop per compartment over shaving slide length in a two-bay hold', () => {
    const comp: Compartment[] = [
      { offset: [0, 0, 0], dims: [2, 8, 2], blockingModel: 'vertical+depth', openingAxis: '-y' },
      { offset: [4, 0, 0], dims: [2, 8, 2], blockingModel: 'vertical+depth', openingAxis: '-y' },
    ]
    const items = [
      item('Checkmate', 1, [[2, 2, 2], [2, 2, 2]]),
      item('Other', 2, [[2, 2, 2], [2, 2, 2]]),
    ]
    const baseline = oracle(items, comp)
    expect(baseline.status).toBe('feasible')
    if (baseline.status !== 'feasible') throw new Error('baseline should be feasible')

    const best = bestWitnessForItems(items, comp, {
      seed: baseline.boxes,
      alphaMilli: 40,
      deltaMilli: 160,
      nodeBudget: 20_000,
    })
    expect(best).not.toBeNull()

    const compsByStop = new Map<number, Set<number>>()
    for (const b of best!) {
      const set = compsByStop.get(b.deliverStop) ?? new Set<number>()
      set.add(compOfBox(b.pos, b.dims, comp))
      compsByStop.set(b.deliverStop, set)
    }
    expect(compsByStop.get(1)?.size).toBe(1)
    expect(compsByStop.get(2)?.size).toBe(1)
    expect([...compsByStop.get(1)!][0]).not.toBe([...compsByStop.get(2)!][0])
    expect(verifyWitness(best!, comp)).toBe(true)
    expect(validateGeometry(best!, comp).ok).toBe(true)
    expect(auditDigFree(best!, comp)).toEqual({ ok: true })
  })

  it('uses slack in a RAFT-like single hold as visible buffer between delivery territories', () => {
    const comp: Compartment[] = [{ offset: [0, 0, 0], dims: [8, 12, 2], blockingModel: 'vertical+depth', openingAxis: '+y' }]
    const boxes: [number, number, number][] = [[2, 2, 2], [2, 2, 2], [2, 2, 2], [2, 2, 2]]
    const items = [
      item('Checkmate', 1, boxes),
      item('Other', 2, boxes),
    ]
    const baseline = oracle(items, comp)
    expect(baseline.status).toBe('feasible')
    if (baseline.status !== 'feasible') throw new Error('baseline should be feasible')

    const best = bestWitnessForItems(items, comp, {
      seed: baseline.boxes,
      alphaMilli: 40,
      deltaMilli: 160,
      nodeBudget: 20_000,
    })
    expect(best).not.toBeNull()
    const bboxes = stopBboxes(best!)
    expect(bboxGap(bboxes.get(1)!, bboxes.get(2)!)).toBeGreaterThanOrEqual(1)
    expect(verifyWitness(best!, comp)).toBe(true)
    expect(validateGeometry(best!, comp).ok).toBe(true)
    expect(auditDigFree(best!, comp)).toEqual({ ok: true })
  })
})
