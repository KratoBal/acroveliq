// Prints the readable access matrix (docs/access-matrix.md) from the code:
//   npx tsx scripts/access-matrix.ts > docs/access-matrix.md
// src/__tests__/route-access.test.ts keeps the two equal.
import { renderAccessMatrix } from '../src/web/route-access.js'

process.stdout.write(renderAccessMatrix())
