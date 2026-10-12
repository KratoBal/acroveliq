// The access matrix (acrovelIQ P0-1, PR 3a): who may call which route.
//
// Derived, not hand-filled route by route: every rule in route-rules.ts gets
// a default from its CLASS, and the plan's groups (exchange/acroveliq-p0-1-
// implementacios-terv-2026-10-12.md, section 3) override it where they say so.
// The readable list is docs/access-matrix.md, generated from this file
// (scripts/access-matrix.ts); a test keeps the two equal.
//
// This module only DECIDES. The setting, the dispatcher check and the owner
// lookups are in access-enforcement.ts (PR 3b).
//
// The callers (columns):
//   S  Balázs's logged-in session
//   A  the main agent's own token (acrobot)
//   G  another agent's own token
//   L  the old shared token ("legacy"), during the transition
//   D  a device key (a phone, the Bridge): a portable secret on a device. It
//      reads everything and makes the usual writes, but no administrative or
//      approving operation (acrobot, 2026-10-12, 28623; Balázs may decide
//      otherwise at deployment)
// Federation callers reach only the two wire endpoints (the auth gate scopes
// them); the decision lets them through exactly there.
//
// A grant is `yes`, `no` or `own`: the caller's own record only. Where the
// owner of a request is (a path parameter, a query parameter, a body field, a
// record looked up by id) is declared per group; access-enforcement.ts
// resolves it.

import { ROUTE_RULES, type RouteClass, type RouteRule } from './route-rules.js'

export type Column = 'S' | 'A' | 'G' | 'L' | 'D'
export type Grant = 'yes' | 'no' | 'own'
export const COLUMNS: readonly Column[] = ['S', 'A', 'G', 'L', 'D']

export type OwnerSource =
  | { from: 'param'; name: string }
  | { from: 'query'; name: string }
  | { from: 'body'; name: string; defaultsToMain?: boolean }
  | { from: 'lookup'; record: LookupRecord; param: string }

/**
 * A record looked up by an id in the path (the named parameter): its owner. A card's assignee, a
 * schedule's agent, a message's recipient, a memory's writer; a message's
 * participants (either may read it).
 */
export type LookupRecord = 'kanban-card' | 'schedule' | 'message-participants' | 'message-recipient' | 'memory'

export interface Access {
  grants: Record<Column, Grant>
  /** Where the owner of a request is, for an `own` grant. */
  owner?: OwnerSource
  /** The group that set this, or the class default. */
  group: string
  why: string
}

const g = (S: Grant, A: Grant, G: Grant, L: Grant, D: Grant): Record<Column, Grant> => ({ S, A, G, L, D })

/** The default of a class, before any group. */
const CLASS_DEFAULT: Record<RouteClass, Omit<Access, 'group'>> = {
  NYILVANOS: { grants: g('yes', 'yes', 'yes', 'yes', 'yes'), why: 'no authentication at all' },
  OLVASO: { grants: g('yes', 'yes', 'yes', 'yes', 'yes'), why: 'reads, no secret' },
  // most writes here are the agents' own telemetry (token use, spans, tool log)
  ERZEKENY: { grants: g('yes', 'yes', 'yes', 'yes', 'yes'), why: 'shared state, no owner' },
  KRITIKUS: { grants: g('yes', 'no', 'no', 'no', 'no'), why: 'critical: only from the session, unless a group opens it' },
}

interface Group extends Omit<Access, 'group'> {
  name: string
  match: (rule: RouteRule) => boolean
}

const is = (method: string, path: string) => (rule: RouteRule) => rule.method === method && rule.path === path
const any = (...tests: Array<(rule: RouteRule) => boolean>) => (rule: RouteRule) => tests.some((t) => t(rule))
const writes = (rule: RouteRule) => rule.method !== 'GET'

/** Modules whose writes are administration: profiles, autonomy, settings, updates, migration, vault, security... */
const ADMIN_MODULES = new Set([
  'settings', 'updates', 'migrate', 'vault-ssh', 'vault-ssh-keys', 'security', 'onboarding', 'autonomy', 'profiles',
  'auth', 'connectors', 'connectors-hu', 'federation', 'fleet', 'skills', 'agents-skills', 'voice', 'bridge-service-ports',
])

/** The plan's groups. The first that matches a rule sets its access. */
const GROUPS: Group[] = [
  {
    name: 'approval-decide',
    match: is('PATCH', '/api/approvals/:id'),
    grants: g('yes', 'no', 'no', 'no', 'no'),
    why: 'a human decides, not a language model: only from the session (plan 2.4); the server-checked Discord code comes in PR 4',
  },
  {
    name: 'approval-request',
    match: is('POST', '/api/approvals'),
    grants: g('yes', 'yes', 'yes', 'yes', 'yes'),
    why: 'anyone may ask; the decision is the gate',
  },
  {
    name: 'federation-wire',
    match: any(is('POST', '/api/federation/inbox'), is('GET', '/api/federation/manifest')),
    grants: g('yes', 'no', 'no', 'no', 'no'),
    why: 'the federation wire endpoints: peers reach them with their own scoped token (handled apart), not fleet tokens',
  },
  {
    name: 'message-send',
    match: is('POST', '/api/messages'),
    grants: g('yes', 'yes', 'yes', 'yes', 'yes'),
    why: 'anyone may send; the stored sender is the token\'s owner, never the body\'s `from` (PR 3b); the shared token sends as `legacy-ismeretlen`, marked unverified',
  },
  {
    name: 'message-state',
    match: is('PUT', '/api/messages/:id'),
    grants: g('yes', 'yes', 'own', 'yes', 'yes'),
    owner: { from: 'lookup', record: 'message-recipient', param: 'id' },
    why: 'closing a message can inject text into a pane: an agent only its own messages (the recipient)',
  },
  {
    name: 'message-read',
    match: any(is('GET', '/api/messages'), is('GET', '/api/messages/backlog'), is('GET', '/api/messages/threads')),
    grants: g('yes', 'yes', 'own', 'yes', 'yes'),
    owner: { from: 'query', name: 'agent' },
    why: 'an agent reads its own messages (plan 3)',
  },
  {
    name: 'message-read-one',
    match: is('GET', '/api/messages/:id'),
    grants: g('yes', 'yes', 'own', 'yes', 'yes'),
    owner: { from: 'lookup', record: 'message-participants', param: 'id' },
    why: 'an agent reads its own messages, sent or received (plan 3)',
  },
  {
    name: 'schedule-create',
    match: is('POST', '/api/schedules'),
    grants: g('yes', 'own', 'own', 'no', 'no'),
    owner: { from: 'body', name: 'agent', defaultsToMain: true },
    why: 'only its own scheduled task; on another agent only from the session (plan 3); an agent-created task runs with a peer frame (PR 3b)',
  },
  {
    name: 'schedule-change',
    match: any(
      is('PUT', '/api/schedules/:name'),
      is('DELETE', '/api/schedules/:name'),
      is('POST', '/api/schedules/:name/toggle'),
      is('POST', '/api/schedules/:name/run'),
    ),
    grants: g('yes', 'own', 'own', 'no', 'no'),
    owner: { from: 'lookup', record: 'schedule', param: 'name' },
    why: 'only its own scheduled task, run-now included (plan 3); an update that would move it to another agent is not its own',
  },
  {
    name: 'agent-lifecycle',
    match: (r) =>
      r.method === 'POST' && (/^\/api\/agents\/:name\/(start|stop|restart)$/.test(r.path) || r.path === '/api/marveen/restart'),
    grants: g('yes', 'yes', 'no', 'no', 'no'),
    why: 'starting, stopping, restarting agents: the session and the main agent (plan 3)',
  },
  {
    name: 'terminal-write',
    match: (r) => r.module === 'agent-terminal' && r.method === 'POST',
    grants: g('yes', 'no', 'no', 'no', 'no'),
    why: 'text into a pane: only the session; the main agent keeps its tmux path, which the OS permissions govern (plan 3)',
  },
  {
    name: 'session-read',
    match: any(is('GET', '/api/agents/:name/pane/stream'), is('GET', '/api/agents/:name/conversation')),
    grants: g('yes', 'yes', 'own', 'no', 'yes'),
    owner: { from: 'param', name: 'name' },
    why: 'another agent\'s whole session: the supervisor and the agent itself; a device reads it (the phone dashboard shows panes; acrobot\'s D list names no read)',
  },
  {
    name: 'agent-taskstate',
    match: (r) => r.module === 'agent-taskstate' && writes(r),
    grants: g('yes', 'own', 'own', 'no', 'no'),
    owner: { from: 'param', name: 'agent' },
    why: 'switches the pane-injection permission of an agent: only its own',
  },
  {
    name: 'agent-self-settings',
    match: (r) => r.class === 'ERZEKENY' && r.path.startsWith('/api/agents/:name/'),
    grants: g('yes', 'yes', 'own', 'yes', 'yes'),
    owner: { from: 'param', name: 'name' },
    why: 'an agent\'s own settings (context guard, auto-restart, avatar, capabilities, its channel tests and invites)',
  },
  {
    name: 'log-prune',
    match: is('POST', '/api/tool-log/prune'),
    grants: g('yes', 'yes', 'no', 'no', 'no'),
    why: 'deletes the shared tool log: the session and the main agent',
  },
  {
    name: 'memory-change',
    match: (r) => r.module === 'memories' && writes(r) && r.path === '/api/memories/:id',
    grants: g('yes', 'yes', 'own', 'yes', 'yes'),
    owner: { from: 'lookup', record: 'memory', param: 'id' },
    why: 'an agent changes or deletes only its own memories; an update that would move one to another writer is not its own',
  },
  {
    name: 'memory-write',
    match: (r) => r.module === 'memories' && writes(r),
    grants: g('yes', 'yes', 'own', 'yes', 'yes'),
    owner: { from: 'body', name: 'agent_id', defaultsToMain: true },
    why: 'an agent writes its own namespace (plan 3). `shared` is a category: the record still names its writer, so that must be the caller. A missing agent_id is the main agent\'s, so it is not "own"',
  },
  {
    name: 'daily-log-write',
    match: is('POST', '/api/daily-log'),
    grants: g('yes', 'yes', 'own', 'yes', 'yes'),
    owner: { from: 'body', name: 'agent_id', defaultsToMain: true },
    why: 'an agent writes its own daily log (plan 3)',
  },
  {
    name: 'kanban-card-change',
    match: (r) => r.module === 'kanban' && /^\/api\/kanban\/:id(\/(move|archive|unarchive|labels|labels\/:labelId|breakdown|breakdown\/accept))?$/.test(r.path) && writes(r),
    grants: g('yes', 'yes', 'own', 'yes', 'yes'),
    owner: { from: 'lookup', record: 'kanban-card', param: 'id' },
    why: 'an agent changes the cards assigned to it (plan 3); it hands one on only to the main agent, the escalation the dispatch asks for (assigning is the main agent\'s job, acrobot 28671); creating a card and commenting stay open',
  },
  {
    name: 'administration',
    // the vault's non-reading routes too (GET /api/vault/scan writes)
    match: (r) => (ADMIN_MODULES.has(r.module) && writes(r)) || (r.path.startsWith('/api/vault') && r.class !== 'OLVASO'),
    grants: g('yes', 'no', 'no', 'no', 'no'),
    why: 'profiles, autonomy, settings, updates, migration, vault, security, connectors, federation: only the session (plan 3)',
  },
  {
    name: 'shared-token-handout',
    match: is('GET', '/api/voice/directive'),
    grants: g('yes', 'no', 'no', 'no', 'no'),
    why: 'it returns the SHARED dashboard token: any other caller would get every door with it (barracuda, #20)',
  },
]

/** The access of one rule: its group's, or its class default. */
export function accessOf(rule: RouteRule): Access {
  const group = GROUPS.find((candidate) => candidate.match(rule))
  if (group) {
    const { name, match: _match, ...rest } = group
    return { ...rest, group: name }
  }
  return { ...CLASS_DEFAULT[rule.class], group: `class:${rule.class}` }
}

export type Caller =
  | { column: Column; name: string }
  | { column: 'F'; name: string } // a federation peer

export interface Decision {
  allowed: boolean
  reason: string
}

/**
 * The decision for one request. `rule` is the route rule it answers to
 * (route-match.ts), null when none does: then only the session passes
 * (default-deny for every token). `owner` is the request's owner, resolved
 * from the group's OwnerSource (access-enforcement.ts): one name, or the
 * names any of which is the caller's own (a message's two parties).
 */
export function decide(rule: RouteRule | null, caller: Caller, owner?: string | readonly string[] | null): Decision {
  if (caller.column === 'F') {
    const wire = rule !== null && accessOf(rule).group === 'federation-wire'
    return { allowed: wire, reason: wire ? 'federation wire endpoint' : 'a federation peer only reaches the wire endpoints' }
  }
  if (rule === null) {
    return caller.column === 'S'
      ? { allowed: true, reason: 'no rule; the session passes' }
      : { allowed: false, reason: 'no rule for this route: default-deny' }
  }
  const access = accessOf(rule)
  const grant = access.grants[caller.column]
  if (grant === 'yes') return { allowed: true, reason: access.group }
  if (grant === 'no') return { allowed: false, reason: `${access.group}: ${access.why}` }
  const owners = owner == null ? [] : typeof owner === 'string' ? [owner] : owner
  if (owners.includes(caller.name)) return { allowed: true, reason: `${access.group}: own` }
  return { allowed: false, reason: `${access.group}: not its own (owner ${owners.join(', ') || 'unknown'})` }
}

/**
 * What must be settled before the setting leaves `naplo` (barracuda, #22
 * review). At the top of the list, not among its 300 rows.
 */
const BEFORE_ENFORCING = [
  '## Döntendő a bekapcsolás előtt',
  '',
  'A beállítás (`ACCESS_MODE`) alapból `naplo`: semmit nem tilt, csak naplózza, mit tiltana. A `kikenyszerit`',
  'vagy a `legacy-szukitett` állás előtt ezeket kell eldönteni vagy lemérni:',
  '',
  '1. **A telefon hangja (D).** A voice modul minden írása adminisztráció, tehát a `POST /api/voice/stt`, a',
  '   `/api/voice/tts` és a `/api/voice/modality/set` csak S. Ha a telefonos felület ezeket hívja, a hangja a',
  '   kikényszerítéskor elnémul. Mérés: a `request_actors` naplóban `device:` szereplő a voice sorokon.',
  '2. **A jóváhagyás (A).** A `PATCH /api/approvals/:id` csak S. Ma az Acrobot zárja le a jóváhagyásokat Balázs',
  '   szöveges válasza után. A kikényszerítés ezért a szerver által ellenőrzött Discord-kód (PR 4) előtt nem',
  '   kapcsolhat be, különben a jóváhagyási lánc megáll.',
  '3. **A régi token (L) kritikus útjai.** Amit ma a közös token kritikus úton hív, az a kikényszerítéskor',
  '   eltörik (például a `POST /api/schedules`). A kapcsoló csak akkor fordul, ha az',
  '   `npx tsx scripts/access-preflight.ts` listája üres (kilépési kód 0): ez a naplóból sorolja fel, mit',
  '   tiltott volna. Ez eljárás, nem zár: a beállítást a kód nem tagadja meg.',
  '4. **Az önbevallott szereplők.** Az üzenet feladóját, a jóváhagyás kérőjét és eldöntőjét, az átadó rekord',
  '   `agent` mezőjét, a tokenmérési esemény `actor` mezőjét és az ütemezett feladat szerzőjét a szerver a',
  '   tokenből tölti ki (`src/web/actor-claims.ts`). A régi közös token senkit nem nevez meg: `naplo` állásban',
  '   az ő mezője önbevallott marad, a másik két állásban `legacy-ismeretlen`, nem ellenőrzött jelöléssel. Egy',
  '   eszköz `kikenyszerit` állásban `device:<név>` néven ír, nem bármelyik ágens nevében. A bekapcsolás előtt',
  '   tehát minden ágensnek saját tokennel kell hívnia, különben a feladója ismeretlen lesz.',
  '5. **Az ütemezett feladatok.** A `command`, `preCheck` és `targetSession` mezőt (és a `command` típust) API-n',
  '   csak a munkamenet írhatja, MINDEN állásban, `naplo`-ban is (403): ez parancsfuttatási út, nem',
  '   hozzáférési szűrő, és Balázs a beállítástól függetlenül zárta (2026-10-12 11:18:50 UTC). Az ágens vagy a',
  '   közös token által írt feladat a kikényszerítő állásban társ-kerettel fut, nem operátor-kerettel; `naplo`',
  '   állásban marad az operátor-keret, és a futtató naplózza, mi lenne. A váltás után tehát az Acrobot API-n',
  '   létrehozott feladatai is kérésként érkeznek.',
]

/** The readable list (docs/access-matrix.md), from the rules and their access. */
export function renderAccessMatrix(rules: readonly RouteRule[] = ROUTE_RULES): string {
  const mark = (grant: Grant) => (grant === 'yes' ? '✓' : grant === 'no' ? '✗' : 'saját')
  const owner = (source?: OwnerSource) =>
    !source ? '' : source.from === 'lookup' ? `rekord: ${source.record} (:${source.param})` : `${source.from}: ${source.name}`
  const lines = [
    '# Jogosultsági mátrix (acrovelIQ P0-1)',
    '',
    'Generálva: `npx tsx scripts/access-matrix.ts > docs/access-matrix.md`, a `src/web/route-access.ts` és a',
    '`src/web/route-rules.ts` alapján. Kézzel ne szerkeszd: egy teszt ellenőrzi, hogy egyezik a kóddal.',
    '',
    'Oszlopok: **S** Balázs munkamenete, **A** az Acrobot tokenje, **G** egy másik ágens tokenje,',
    '**L** a régi közös token, **D** egy eszköz-kulcs (telefon, Bridge). „saját”: csak a hívó saját rekordja.',
    '',
    '**A D oszlop külön döntés** (acrobot, 2026-10-12, 28623): a D mindent olvas és a szokásos írásokat',
    'megkapja, de adminisztratív és jóváhagyó műveletet nem. Balázs a telepítéskor dönthet másképp.',
    '',
    ...BEFORE_ENFORCING,
    '',
    '| Metódus | Útvonal | Osztály | S | A | G | L | D | Csoport | Tulajdonos |',
    '|---|---|---|---|---|---|---|---|---|---|',
  ]
  for (const rule of rules) {
    const access = accessOf(rule)
    const cells = COLUMNS.map((column) => mark(access.grants[column]))
    lines.push(`| ${rule.method} | \`${rule.path.replace(/\|/g, '\\|')}\` | ${rule.class} | ${cells.join(' | ')} | ${access.group} | ${owner(access.owner)} |`)
  }
  lines.push('', '## A csoportok indoka', '')
  for (const group of GROUPS) lines.push(`- **${group.name}**: ${group.why}`)
  for (const [cls, def] of Object.entries(CLASS_DEFAULT)) lines.push(`- **class:${cls}** (ha egy csoport sem illik): ${def.why}`)
  return lines.join('\n') + '\n'
}
