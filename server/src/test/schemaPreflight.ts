// A test database that is behind the checkout (a migration not applied yet) must stop the run BEFORE any fixture exists.
// Found the hard way: tests created thousands of rows, a cleanup then hit a table that wasn't there, and every fixture the
// run had made stayed in the shared RLS database. Pure functions so the behaviour is unit-tested (schemaPreflight.test.ts).

/** The table every Prisma model maps to (its @@map, else the model name), from the schema text. */
export function expectedTables(schemaText: string): string[] {
  const out: string[] = [];
  for (const m of schemaText.matchAll(/^model\s+(\w+)\s*\{([\s\S]*?)^\}/gm)) out.push(m[2].match(/@@map\("([^"]+)"\)/)?.[1] ?? m[1]);
  return out;
}

export const findMissingTables = (expected: string[], present: Iterable<string>): string[] => {
  const have = new Set(present);
  return expected.filter((t) => !have.has(t));
};

export const behindMessage = (missing: string[]): string =>
  `The test database is behind this checkout - missing table(s): ${missing.join(', ')}.\n` +
  'Apply the migrations first (everyday DB: npm run db:test:migrate; RLS DB: prisma migrate deploy, then db-secure.sql, as the owner role), then re-run.';
