/**
 * WHAT A NEW KANBAN CARD MAY CARRY (2026-11-26, acrobot 63298). `fleet-api.sh kanban-new acrobot "cim"` sent the title as
 * the first argument and "cim" as the STATUS; the table's CHECK refused it, the insert threw, and the route answered a bare
 * HTTP 500 ("Szerver hiba") that named nothing. A wrong field is the caller's error: a 400 that names the field, before
 * anything is written. The allowed values are the table's own CHECKs (`kanban_cards` in db.ts).
 */
export const KANBAN_STATUSES = ['planned', 'in_progress', 'testing', 'waiting', 'done'] as const
export const KANBAN_PRIORITIES = ['low', 'normal', 'high', 'urgent'] as const

const OPTIONAL_TEXT = ['description', 'assignee', 'project', 'parent_id', 'basis'] as const

/** null: the body may be written; otherwise the sentence for the 400, naming the field. */
export function kanbanCreateProblem(data: unknown): string | null {
  if (typeof data !== 'object' || data === null || Array.isArray(data)) return 'A kérés törzse egy JSON objektum legyen.'
  const card = data as Record<string, unknown>
  if (typeof card.title !== 'string' || card.title.trim() === '') return 'A `title` (a kártya címe) kötelező, nem üres szöveg.'
  if (card.status !== undefined && !(KANBAN_STATUSES as readonly unknown[]).includes(card.status))
    return `Ismeretlen \`status\`: ${JSON.stringify(card.status)}. Lehet: ${KANBAN_STATUSES.join(', ')}.`
  if (card.priority !== undefined && !(KANBAN_PRIORITIES as readonly unknown[]).includes(card.priority))
    return `Ismeretlen \`priority\`: ${JSON.stringify(card.priority)}. Lehet: ${KANBAN_PRIORITIES.join(', ')}.`
  for (const field of OPTIONAL_TEXT)
    if (card[field] !== undefined && card[field] !== null && typeof card[field] !== 'string')
      return `A \`${field}\` szöveg legyen (vagy hiányozzon).`
  if (card.due_date !== undefined && card.due_date !== null && (typeof card.due_date !== 'number' || !Number.isFinite(card.due_date)))
    return 'A `due_date` szám legyen (Unix-másodperc), vagy hiányozzon.'
  return null
}
