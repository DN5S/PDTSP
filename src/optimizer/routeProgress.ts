import type { RoutePlan } from '../domain/types'
import { buildRouteSteps } from './loadout'

/** A stable string signature of a route, used to detect when the plan changed (to
 *  reset checklist progress). Built from the CHECKLIST STEPS, not raw stop actions:
 *  the checklist counts through buildRouteSteps' order, and load-step order at a
 *  stop depends on the loadout witness (bottom-of-hold first). A grid edit or ship
 *  swap that reorders the steps must therefore change the signature — otherwise a
 *  kept step count would silently mark different loads as done. */
export function routeSignature(plan: RoutePlan | null): string {
  if (!plan?.feasible) return ''
  const stops = plan.stops.map((s) => s.locationId).join(',')
  const steps = buildRouteSteps(plan)
    .map((st) =>
      // Per-action scu matters: two legs of one mission sharing both stops must
      // not collide when their SCUs swap/recombine to the same step total. Box
      // ids (opOrder plans) pin the exact boxes a step moves — a witness whose
      // boxes re-shuffle between same-looking steps must also reset progress.
      `${st.stopIndex}:${st.kind}:${st.missionId}:${st.scu}:${st.actions.map((a) => `${a.legId}.${a.commodity}.${a.scu}`).join('+')}` +
      (st.boxIds ? `:${st.boxIds.join('.')}` : ''),
    )
    .join('|')
  return `${stops}#${steps}`
}
