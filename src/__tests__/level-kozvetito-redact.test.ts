// The mail relay's two layers against credential material (plan v2, point C): who is excluded, and what is
// taken out of the rest. WHAT TURNS THIS RED: an excluded sender passing (by address, by domain, by subdomain,
// or hidden in a display name); a reset link or a one-time code reaching the text; an invoice number, a date or
// an amount with a separator being damaged in the narrow mode; the narrow mode letting a code through.
import { describe, expect, it } from 'vitest'

import { excludedSender, redactBody, senderAddresses, senderDomain } from '../level-kozvetito/redact.js'

const EXCLUDED = { domains: ['accounts.google.com', 'bank.example'], addresses: ['biztonsag@szolgaltato.example'] }

describe('excluded senders', () => {
  it('reads every address of the From header, the display name included', () => {
    expect(senderAddresses('"Accounts@Google.com" <Someone@Elsewhere.EXAMPLE>')).toEqual(['accounts@google.com', 'someone@elsewhere.example'])
  })

  it('an address, a domain and a subdomain are excluded; another sender is not', () => {
    expect([
      excludedSender('Google <no-reply@accounts.google.com>', EXCLUDED),
      excludedSender('Bank <ertesito@mail.bank.example>', EXCLUDED),
      excludedSender('Szolgáltató <biztonsag@szolgaltato.example>', EXCLUDED),
      excludedSender('Beszállító <info@beszallito.example>', EXCLUDED),
      // a domain that only ends in the same letters is not a subdomain
      excludedSender('x <a@notbank.example>', EXCLUDED),
    ]).toEqual(['accounts.google.com', 'bank.example', 'biztonsag@szolgaltato.example', null, null])
  })

  it('an excluded address hidden in the display name excludes the mail (the safe reading)', () => {
    expect(excludedSender('"biztonsag@szolgaltato.example" <attacker@evil.example>', EXCLUDED)).toBe('biztonsag@szolgaltato.example')
  })

  it('names the domain an excluded mail came from, and a placeholder when there is no address', () => {
    expect([senderDomain('Bank <ertesito@mail.bank.example>'), senderDomain('nincs cim')]).toEqual(['mail.bank.example', 'ismeretlen'])
  })
})

describe('redaction, the default mode (every standalone 4-8 digit number)', () => {
  const all = (s: string) => redactBody(s, 'all-short-numbers')

  it('takes a one-time code out', () => {
    expect(all('Az Ön belépési kódja: 482913. Ne add ki senkinek.')).toBe('Az Ön belépési kódja: [KOD]. Ne add ki senkinek.')
  })

  it('takes a reset link out, with the host kept; a plain link stays', () => {
    expect(all('Állítsd vissza itt: https://account.example.com/reset?token=abcd1234&u=7')).toBe('Állítsd vissza itt: [LINK account.example.com]')
    expect(all('Egy hosszú útvonal: https://example.com/a/b1c2d3e4f5g6h7i8j9k0l1m2n3')).toBe('Egy hosszú útvonal: [LINK example.com]')
    expect(all('Lásd: https://example.com/kapcsolat')).toBe('Lásd: https://example.com/kapcsolat')
    expect(all('Itt: https://example.com/belep#session')).toBe('Itt: [LINK example.com]')
  })

  it('leaves a date, a number/year, a longer number and a number with a separator alone', () => {
    expect(all('2026-10-19 7841/26 12,700 Ft 1234567890 3.141592 tel +36301234567')).toBe(
      '2026-10-19 7841/26 12,700 Ft 1234567890 3.141592 tel +36301234567',
    )
  })

  it('also takes a short invoice or order number out: the measured price of the safe default (plan, barracuda point 3)', () => {
    expect(all('Számla: 083906, rendelés 261582.')).toBe('Számla: [KOD], rendelés [KOD].')
  })

  it('takes out a long unbroken mix of letters and digits (a key, a session id), not a long word', () => {
    expect(all('kulcs: a1b2c3d4e5f6g7h8i9j0k1l2m3 vége')).toBe('kulcs: [AZON] vége')
    expect(all('alkotmánybíróságiszervezetekközöttiegyeztetés')).toBe('alkotmánybíróságiszervezetekközöttiegyeztetés')
  })
})

describe('redaction, the narrow mode (only near a code word)', () => {
  const near = (s: string) => redactBody(s, 'near-code-word')

  it('keeps an invoice and an order number, takes a code that a code word stands next to', () => {
    expect(near('Számla: 083906, rendelés 261582.')).toBe('Számla: 083906, rendelés 261582.')
    expect(near('Ellenőrző kód: 482913')).toBe('Ellenőrző kód: [KOD]')
    expect(near('Your verification code is 482913')).toBe('Your verification code is [KOD]')
    expect(near('Belépés: 482913 (PIN)')).toBe('Belépés: [KOD] (PIN)')
  })

  it('still takes the links and the long tokens out', () => {
    expect(near('https://account.example.com/reset?token=abcd')).toBe('[LINK account.example.com]')
  })
})
