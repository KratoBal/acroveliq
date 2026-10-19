// The two small types the relay's files share, in a file of their own so that relay.ts and modify.ts can
// each import them without importing each other.

/** A refusal the caller is told about: an HTTP status and a fixed reason. */
export class Refusal extends Error {
  constructor(
    readonly status: number,
    readonly reason: string,
  ) {
    super(reason)
  }
}

export type LogFields = Record<string, string | number | boolean>
