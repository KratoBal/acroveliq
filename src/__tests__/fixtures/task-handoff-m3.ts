// A handoff record of a real closed task, shared by the handoff tests.

/** A real closed task: the Monday list's M3 (acropora-os #1660). */
export const M3_HANDOFF = {
  task: {
    id: 'hetfoi-lista-M3',
    goal: 'POS pultos felület: Kézi tétel gomb (megnevezés, darabszám, bruttó ár, készletlevonás nélkül, a végösszegben és a számlán).',
    brief: 'exchange/hetfoi-lista-2026-10-12.md',
  },
  status: 'done',
  decisions: [
    { what: 'A Monday list runs today, M1-M4 in order, one PR each', who: 'Balázs', where: 'Discord fő csatorna, message_id 1559098703275499611' },
    { what: 'The manual line gets a VAT select: 27% (default), 18%, 5%', who: 'murena', where: 'acropora-os PR #1660 leírása' },
  ],
  prohibitions: [
    { what: 'Nothing that touches commerce, UNAS or their front and back ends', source: 'Balázs, 2026-09-22 07:51:37 UTC, message_id 1551863527889838091' },
    { what: 'No production deploy; production goes on Balázs\'s word', source: 'acrobot 28502, exchange/hetfoi-lista-2026-10-12.md' },
  ],
  code: { repo: 'KratoBal/acropora-os', branch: 'feat/pos-manual-line', head: '5bd5231a', pr: 1660, merged: true },
  files: [
    'apps/api/src/pos/pos-sale.service.ts',
    'apps/api/src/pos/pos-sale.repository.ts',
    'apps/web/src/components/pos/pilot/pilot-pos-terminal-page.tsx',
    'packages/types/src/pos.ts',
  ],
  next_step: 'M4: szerződés típus (Beszerzés / Karbantartás, javítás), a lista utolsó tétele.',
  open_questions: [],
}
