import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { expectedTables, findMissingTables, behindMessage } from './schemaPreflight';

describe('test-database pre-flight', () => {
  it('maps models to their @@map table, or their own name when unmapped', () => {
    const schema = 'model A {\n  id String @id\n  @@map("a_table")\n}\n\nmodel B {\n  id String @id\n}\n';
    expect(expectedTables(schema)).toEqual(['a_table', 'B']);
  });

  it('reads the real schema, including the saved-layouts table', () => {
    const t = expectedTables(fs.readFileSync(path.resolve(__dirname, '../../prisma/schema.prisma'), 'utf8'));
    expect(t.length).toBeGreaterThan(100);
    expect(t).toContain('user_table_layouts');
  });

  it('reports exactly the tables a database lacks, with an actionable message', () => {
    const missing = findMissingTables(['users', 'user_table_layouts', 'companies'], ['users', 'companies', 'extra']);
    expect(missing).toEqual(['user_table_layouts']);
    expect(behindMessage(missing)).toMatch(/behind this checkout.*user_table_layouts/s);
    expect(behindMessage(missing)).toMatch(/migrate deploy/);
    expect(findMissingTables(['a'], ['a'])).toEqual([]);
  });
});
