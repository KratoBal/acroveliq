import type { KanbanCard } from './db.js'

/**
 * HOW FRESH A CARD'S MEASUREMENT IS (T6.5, card b3d8174e). A card is written on the day of a finding, its title states
 * a fact in the present tense, and it does not age: the fact can be fixed on main while the card still says it is open.
 * The measurement stamp (`basis`, `measured_at`, `measure_result`) is what lets the board say so, and this pure function
 * is the ONE place that turns the stamp and the clock into a state, so the list, the dashboard and the issuing check read
 * the same answer.
 *
 *   none        nothing to say: no basis and never measured, or the card is done (a closed card's claim is moot)
 *   unmeasured  there is a basis but it was never measured
 *   diverged    the last measurement found the basis no longer true; shown whatever the age, a measurement that found
 *               a difference does not expire into "stale"
 *   stale       the last measurement is older than the threshold, whatever its result
 *   unknown     the last measurement could not look (UNKNOWN), and it is still fresh
 *   fresh       measured within the threshold and the basis was true
 *
 * `measured_at`, not `updated_at`: `updated_at` moves on every write (a comment, a drag), so it never says whether the
 * claim is still true.
 */
export type KanbanMeasureState =
  | 'none'
  | 'unmeasured'
  | 'diverged'
  | 'stale'
  | 'unknown'
  | 'fresh'

export function kanbanMeasureState(
  card: Pick<KanbanCard, 'status' | 'basis' | 'measured_at' | 'measure_result'>,
  nowSec: number,
  staleHours: number,
): KanbanMeasureState {
  if (card.status === 'done') return 'none'
  if (card.measured_at == null) return card.basis?.trim() ? 'unmeasured' : 'none'
  if (card.measure_result === 'DIVERGED') return 'diverged'
  if ((nowSec - card.measured_at) / 3600 >= staleHours) return 'stale'
  return card.measure_result === 'UNKNOWN' ? 'unknown' : 'fresh'
}
