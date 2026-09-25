/**
 * Tenant-isolation audit of every direct Prisma call in the application source.
 *
 *   npx ts-node scripts/tenant-audit.ts            # report only
 *   npx ts-node scripts/tenant-audit.ts --fix      # mechanically rewrite the safe cases
 *
 * WHY: with row-level security enforced against a non-owner database role, a query on a company-owned
 * table that is not run through the tenant wrappers (tenantQuery / tenantBatch / tenantTransaction,
 * which set `app.tenant_company_id` in the same transaction) returns ZERO rows or is refused — fail-closed
 * by design. So every call on a company-owned model must go through a wrapper. Calls on PLATFORM models
 * (User, Company, HsnCode, StateMaster, PlatformAuditLog) are not company-owned and may stay bare.
 *
 * Classification (from prisma/schema.prisma, so it can never drift): a model is COMPANY-OWNED iff it has a
 * `companyId` column.
 *
 * --fix rewrites `prisma.<scopedModel>.<op>(args)` into
 *     tenantQuery(<companyId expression>, (_tx) => _tx.<scopedModel>.<op>(args))
 * where an enclosing function has a `ctx`, `companyId` or `req` (router) parameter. Anything else — batch
 * `$transaction([...])`, raw SQL, or a call with no company expression in scope — is listed for manual work.
 */
import fs from 'fs';
import path from 'path';
import ts from 'typescript';

const ROOT = path.resolve(__dirname, '../..'); // server/
const SRC = path.join(ROOT, 'src');
const FIX = process.argv.includes('--fix');

function scopedModels(): Set<string> {
  const schema = fs.readFileSync(path.join(ROOT, 'prisma/schema.prisma'), 'utf8');
  const out = new Set<string>();
  for (const m of schema.matchAll(/^model (\w+) \{([\s\S]*?)^\}/gm)) {
    if (/^\s+companyId\s/m.test(m[2])) out.add(m[1][0].toLowerCase() + m[1].slice(1));
  }
  return out;
}
const SCOPED = scopedModels();
const PLATFORM = new Set(['user', 'company', 'hsnCode', 'stateMaster', 'platformAuditLog']);

function files(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) files(p, out);
    else if (p.endsWith('.ts') && !p.endsWith('.test.ts') && !p.includes(`${path.sep}test${path.sep}`)) out.push(p);
  }
  return out;
}

interface Finding {
  file: string; line: number; kind: 'scoped' | 'platform' | 'raw' | 'transaction' | 'other';
  model?: string; op?: string; company?: string; inArrayBatch?: boolean; node: ts.CallExpression; sf: ts.SourceFile;
}

function companyExpression(node: ts.Node): string | undefined {
  for (let n: ts.Node | undefined = node.parent; n; n = n.parent) {
    if (ts.isFunctionLike(n)) {
      const names = (n as ts.FunctionLikeDeclaration).parameters.map((p) => p.name.getText());
      if (names.includes('ctx')) return 'ctx.companyId';
      if (names.includes('companyId')) return 'companyId';
      if (names.includes('req')) return 'req.tenant!.companyId';
    }
  }
  return undefined;
}

function analyse(file: string): Finding[] {
  const text = fs.readFileSync(file, 'utf8');
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const out: Finding[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const callee = node.expression;
      // prisma.<model>.<op>(...)
      if (ts.isPropertyAccessExpression(callee.expression) && ts.isIdentifier(callee.expression.expression) && callee.expression.expression.text === 'prisma') {
        const model = callee.expression.name.text; const op = callee.name.text;
        const scoped = SCOPED.has(model);
        // inside an array literal that is the argument of prisma.$transaction([...])
        let inBatch = false;
        for (let p: ts.Node | undefined = node.parent; p; p = p.parent) {
          if (ts.isArrayLiteralExpression(p) && ts.isCallExpression(p.parent) && p.parent.expression.getText().endsWith('$transaction')) { inBatch = true; break; }
          if (ts.isFunctionLike(p)) break;
        }
        out.push({
          file, line: sf.getLineAndCharacterOfPosition(node.getStart()).line + 1, kind: scoped ? 'scoped' : PLATFORM.has(model) ? 'platform' : 'other',
          model, op, company: companyExpression(node), inArrayBatch: inBatch, node, sf,
        });
      } else if (ts.isIdentifier(callee.expression) && callee.expression.text === 'prisma') {
        const op = callee.name.text;
        out.push({
          file, line: sf.getLineAndCharacterOfPosition(node.getStart()).line + 1,
          kind: op.startsWith('$query') || op.startsWith('$execute') ? 'raw' : op === '$transaction' ? 'transaction' : 'other',
          op, company: companyExpression(node), node, sf,
        });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

function otherPrismaReferences(file: string): Array<{ file: string; line: number; text: string }> {
  const text = fs.readFileSync(file, 'utf8');
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const out: Array<{ file: string; line: number; text: string }> = [];
  const visit = (node: ts.Node) => {
    if (ts.isIdentifier(node) && node.text === 'prisma') {
      const p = node.parent;
      const isImport = ts.isImportSpecifier(p) || ts.isImportClause(p) || ts.isImportDeclaration(p);
      const isPropName = ts.isPropertyAccessExpression(p) && p.name === node;
      const isObjectOfAccess = ts.isPropertyAccessExpression(p) && p.expression === node;
      const isDeclName = (ts.isVariableDeclaration(p) || ts.isParameter(p) || ts.isBindingElement(p)) && (p as any).name === node;
      const isTypeRef = ts.isTypeQueryNode(p); // `typeof prisma` in a type position is not a use of the client
      const isExportName = ts.isExportSpecifier(p) || (ts.isVariableDeclaration(p) && (p as any).name === node);
      if (!isImport && !isPropName && !isDeclName && !isExportName && !isTypeRef) {
        // prisma.<platformModel>.<op> and prisma.$connect/$disconnect/$on are fine; everything else is an alias / pass-through
        if (isObjectOfAccess) {
          const member = (p as ts.PropertyAccessExpression).name.text;
          if (PLATFORM.has(member) || ['$connect', '$disconnect', '$on', '$transaction', '$queryRaw', '$executeRaw'].includes(member) || SCOPED.has(member)) { ts.forEachChild(node, visit); return; }
        }
        out.push({ file, line: sf.getLineAndCharacterOfPosition(node.getStart()).line + 1, text: p.getText().slice(0, 80) });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

function hasNestedScoped(f: Finding, all: Finding[]): boolean {
  return all.some((g) => g !== f && g.file === f.file && g.kind === 'scoped' && g.node.getStart() > f.node.getStart() && g.node.getEnd() <= f.node.getEnd());
}

function rewriteFile(file: string): number {
  let count = 0;
  for (let pass = 0; pass < 12; pass++) {
    const all = analyse(file);
    const fixable = all.filter((f) => f.kind === 'scoped' && f.company && !f.inArrayBatch && !hasNestedScoped(f, all));
    if (fixable.length === 0) break;
    let text = fs.readFileSync(file, 'utf8');
    // apply from the end so earlier offsets stay valid
    for (const f of fixable.sort((a, b) => b.node.getStart() - a.node.getStart())) {
      const argsText = f.node.arguments.length ? text.slice(f.node.arguments[0].getStart(f.sf), f.node.arguments[f.node.arguments.length - 1].getEnd()) : '';
      const replacement = `tenantQuery(${f.company}, (_tx) => _tx.${f.model}.${f.op}(${argsText}))`;
      text = text.slice(0, f.node.getStart(f.sf)) + replacement + text.slice(f.node.getEnd());
      count++;
    }
    fs.writeFileSync(file, text);
  }
  if (count > 0) ensureImport(file);
  return count;
}

function ensureImport(file: string) {
  let text = fs.readFileSync(file, 'utf8');
  if (/\btenantQuery\b[^;]*from\s+['"][^'"]*tenantContext['"]/.test(text) || /import\s*\{[^}]*\btenantQuery\b[^}]*\}\s*from\s*['"][^'"]*tenantContext['"]/.test(text)) return;
  const rel = path.relative(path.dirname(file), path.join(SRC, 'shared/tenantContext')).replace(/\\/g, '/');
  const spec = rel.startsWith('.') ? rel : `./${rel}`;
  const m = text.match(/import\s*\{([^}]*)\}\s*from\s*['"][^'"]*tenantContext['"];?/);
  if (m) {
    text = text.replace(m[0], m[0].replace(m[1], `${m[1].trim().replace(/,$/, '')}, tenantQuery `));
  } else {
    const imports = [...text.matchAll(/^import .*;$/gm)];
    const last = imports[imports.length - 1];
    const line = `import { tenantQuery } from '${spec}';`;
    text = last ? text.slice(0, last.index! + last[0].length) + '\n' + line + text.slice(last.index! + last[0].length) : line + '\n' + text;
  }
  fs.writeFileSync(file, text);
}

export interface AuditResult {
  scoped: Array<{ file: string; line: number; text: string }>;
  aliases: Array<{ file: string; line: number; text: string }>;
  raw: number; transactions: number; platform: number;
}

/** Programmatic entry point (used by the build-failing guard test): no output, no rewriting. */
export function runAudit(): AuditResult {
  const rel = (fl: string) => path.relative(ROOT, fl).replace(/\\/g, '/');
  const findings = files(SRC).flatMap(analyse);
  const kind = (k: Finding['kind']) => findings.filter((x) => x.kind === k);
  const aliases = files(SRC).flatMap(otherPrismaReferences).filter((r) => !/(config[\\/]database|shared[\\/]tenantContext)\.ts$/.test(r.file)); // the client's own definition and the wrappers themselves
  return {
    scoped: kind('scoped').map((x) => ({ file: rel(x.file), line: x.line, text: `${x.model}.${x.op}` })),
    aliases: aliases.map((x) => ({ file: rel(x.file), line: x.line, text: x.text })),
    raw: kind('raw').length, transactions: kind('transaction').length, platform: kind('platform').length,
  };
}

export function cli() {
  let rewritten = 0;
  if (FIX) for (const fl of files(SRC)) rewritten += rewriteFile(fl);

  const findings = files(SRC).flatMap(analyse);
  const rel = (fl: string) => path.relative(ROOT, fl).replace(/\\/g, '/');
  const byKind = (k: Finding['kind']) => findings.filter((x) => x.kind === k);
  const { aliases } = runAudit();

  console.log(`${FIX ? `Rewrote ${rewritten} call(s).\n` : ''}Direct Prisma calls remaining in src/ (non-test):`);
  console.log(`  company-owned model, NOT through a tenant wrapper : ${byKind('scoped').length}   <- must be 0`);
  console.log(`  platform model (User, Company, HsnCode, StateMaster, PlatformAuditLog): ${byKind('platform').length}   (allowed)`);
  console.log(`  raw SQL ($queryRaw/$executeRaw)                    : ${byKind('raw').length}   (review each)`);
  console.log(`  prisma.$transaction                                : ${byKind('transaction').length}   (review each)`);
  console.log(`  other                                              : ${byKind('other').length}`);
  console.log(`  aliasing / passing the bare client around          : ${aliases.length}   <- must be 0 (e.g. "tx ?? prisma", "= prisma" defaults)`);
  for (const x of aliases) console.log(`    ${x.file}:${x.line}  ${x.text}`);

  for (const k of ['scoped', 'raw', 'transaction', 'other'] as const) {
    const list = byKind(k);
    if (!list.length) continue;
    console.log(`\n── ${k.toUpperCase()} (${list.length}) ──`);
    for (const x of list) console.log(`  ${rel(x.file)}:${x.line}  ${x.model ? `${x.model}.` : ''}${x.op}  company=${x.company ?? 'NONE-IN-SCOPE'}${x.inArrayBatch ? '  [in $transaction([...])]' : ''}`);
  }
  process.exit(byKind('scoped').length === 0 && aliases.length === 0 ? 0 : (process.argv.includes('--strict') ? 1 : 0));
}

