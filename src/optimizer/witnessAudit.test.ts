import { describe, it, expect } from 'vitest'
import { auditDigFree, validateGeometry } from './witnessAudit'
import type { OraclePlacedBox } from './loadFeasibility'
import type { Compartment } from '../ships/grids'

// The audit is the suite's independent tripwire for the dig-free guarantee, so it
// must itself be proven to FIRE on hand-built violations (not just pass valid
// witnesses — a checker that never fails verifies nothing).

const box = (
  id: string, pos: [number, number, number], dims: [number, number, number],
  loadStop: number, deliverStop: number,
): OraclePlacedBox => ({
  id, missionId: 'M', legId: id, commodity: 'Ti', scu: dims[0] * dims[1] * dims[2],
  pos, dims, loadStop, deliverStop,
})

describe('auditDigFree (independent extraction audit)', () => {
  const topPod: Compartment[] = [{ offset: [0, 0, 0], dims: [4, 4, 4], blockingModel: 'vertical' }]
  const doorHold: Compartment[] = [{ offset: [0, 0, 0], dims: [2, 6, 3], openingAxis: '+y' }] // vertical+depth default

  it('passes side-by-side cargo in a top-opening pod', () => {
    const w = [box('a', [0, 0, 0], [2, 2, 2], 0, 1), box('b', [2, 2, 0], [2, 2, 2], 0, 2)]
    expect(auditDigFree(w, topPod)).toEqual({ ok: true })
    expect(validateGeometry(w, topPod).ok).toBe(true)
  })

  it('fails when a later-delivered box sits above one being lifted out (vertical)', () => {
    const w = [box('a', [0, 0, 0], [2, 2, 2], 0, 1), box('b', [0, 0, 2], [2, 2, 2], 0, 2)]
    const v = auditDigFree(w, topPod)
    expect(v.ok).toBe(false)
    if (!v.ok) expect(v.reason).toMatch(/lifted out/)
  })

  it('fails when a later-delivered box blocks the tunnel to the door (vertical+depth)', () => {
    // a sits deep (away from the +y door), b between a and the door, delivered later.
    const w = [box('a', [0, 0, 0], [2, 2, 2], 0, 1), box('b', [0, 2, 0], [2, 2, 2], 0, 2)]
    const v = auditDigFree(w, doorHold)
    expect(v.ok).toBe(false)
    if (!v.ok) expect(v.reason).toMatch(/door/)
  })

  it('passes the same layout when delivery order matches depth (near-door first)', () => {
    const w = [box('a', [0, 0, 0], [2, 2, 2], 0, 2), box('b', [0, 2, 0], [2, 2, 2], 0, 1)]
    expect(auditDigFree(w, doorHold)).toEqual({ ok: true })
  })

  it('fails when later-delivered cargo rests on the box being slid out', () => {
    const w = [box('a', [0, 0, 0], [2, 2, 1], 0, 1), box('b', [0, 0, 1], [2, 2, 1], 0, 2)]
    const v = auditDigFree(w, doorHold)
    expect(v.ok).toBe(false)
    if (!v.ok) expect(v.reason).toMatch(/rests on/)
  })

  it('allows sliding under a non-resting bridge (weaker than the oracle, by design)', () => {
    // b hovers a full cell above a — a slides out beneath it. (Support is
    // validateGeometry's concern, not the extraction audit's.)
    const w = [box('a', [0, 0, 0], [2, 2, 1], 0, 1), box('b', [0, 0, 2], [2, 2, 1], 0, 2)]
    expect(auditDigFree(w, doorHold)).toEqual({ ok: true })
  })

  it('ignores same-stop deliveries and same-stop loads as obstacles', () => {
    const w = [
      box('a', [0, 0, 0], [2, 2, 1], 0, 1), // stacked pair coming off together
      box('b', [0, 0, 1], [2, 2, 1], 0, 1),
      box('c', [0, 2, 0], [2, 2, 2], 1, 2), // loaded AT stop 1, after the unloads
    ]
    expect(auditDigFree(w, doorHold)).toEqual({ ok: true })
  })

  it('validateGeometry rejects floating and overlapping cargo', () => {
    const floating = [box('a', [0, 0, 2], [2, 2, 1], 0, 1)]
    expect(validateGeometry(floating, doorHold).ok).toBe(false)
    const overlapping = [box('a', [0, 0, 0], [2, 2, 2], 0, 1), box('b', [0, 1, 0], [2, 2, 2], 0, 2)]
    expect(validateGeometry(overlapping, doorHold).ok).toBe(false)
  })
})
