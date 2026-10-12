import { describe, it, expect, afterAll } from 'vitest';
import jwt from 'jsonwebtoken';
import { app } from '../app';
import { env } from '../config/env';
import { platformPrisma as prisma } from '../config/database';
import { createTestTenant, cleanupTestTenant, createMember, tokenFor, apiWith, withForcedRls, TestTenant } from './fixtures';

// Saved table layouts over real HTTP: per member, per company, never another user's, never a forged owner.
describe('HTTP: saved table layouts', () => {
  const suffix = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const tenants: TestTenant[] = [];
  const extraUserIds: string[] = [];

  afterAll(async () => {
    for (const t of tenants) await cleanupTestTenant(t);
    await prisma.user.deleteMany({ where: { id: { in: extraUserIds } } });
    for (const t of tenants) await prisma.user.deleteMany({ where: { email: t.user.email } });
    await prisma.$disconnect();
  });

  // No permission is needed - a role with nothing relevant still manages its own layouts.
  async function setup(tag: string) {
    const t = await createTestTenant(`${tag}${suffix}`, ['sales:view']);
    tenants.push(t);
    return { t, api: apiWith(tokenFor(t), app) };
  }
  const tokenOf = (userId: string, email: string, companyId: string, companyUserId: string, t: TestTenant) => jwt.sign({
    userId, email, companyId, companyUserId, roleId: t.role.id, roleName: t.role.name,
    permissions: t.role.permissions, branchAccess: t.ctx.branchAccess,
  }, env.JWT_SECRET, { expiresIn: '1h' });
  // A second member of the SAME company (own login + own membership).
  async function colleague(t: TestTenant, tag: string) {
    const m = await createMember({ companyId: t.company.id, roleId: t.role.id, email: `${tag}-${suffix}@example.com` });
    extraUserIds.push(m.user.id);
    return { m, api: apiWith(tokenOf(m.user.id, m.user.email, t.company.id, m.membership.id, t), app) };
  }
  const layout = (over: object = {}) => ({ layout: { order: ['b', 'a', 'c'], hidden: ['c'], widths: { a: 220.4 }, ...over } });

  it('requires authentication', async () => {
    const anon = apiWith(undefined, app);
    expect((await anon.get('/user-preferences/table-layouts')).status).toBe(401);
    expect((await anon.put('/user-preferences/table-layouts/x', layout())).status).toBe(401);
    expect((await anon.del('/user-preferences/table-layouts/x')).status).toBe(401);
  });

  it('saves, overwrites, lists and resets the callers own layout (any role, no permission needed)', async () => {
    const { api, t } = await setup('S');
    expect((await api.get('/user-preferences/table-layouts')).body.data).toEqual({});

    const put = await api.put('/user-preferences/table-layouts/sales-invoices', layout());
    expect(put.status).toBe(200);
    expect(put.body.data).toEqual({ order: ['b', 'a', 'c'], hidden: ['c'], widths: { a: 220 } }); // width rounded

    await api.put('/user-preferences/table-layouts/sales-invoices', layout({ order: ['a'], hidden: [], widths: {} }));
    await api.put('/user-preferences/table-layouts/tagging-tags', layout());
    const list = (await api.get('/user-preferences/table-layouts')).body.data;
    expect(Object.keys(list).sort()).toEqual(['sales-invoices', 'tagging-tags']);
    expect(list['sales-invoices'].order).toEqual(['a']);
    expect(await prisma.userTableLayout.count({ where: { companyId: t.company.id } })).toBe(2); // overwrite, not duplicate

    expect((await api.del('/user-preferences/table-layouts/sales-invoices')).status).toBe(200);
    expect((await api.del('/user-preferences/table-layouts/sales-invoices')).status).toBe(200); // idempotent
    expect(Object.keys((await api.get('/user-preferences/table-layouts')).body.data)).toEqual(['tagging-tags']);
  });

  it('two users of one company never see or change each others layout', async () => {
    const a = await setup('U');
    const b = await colleague(a.t, 'colleague');
    await a.api.put('/user-preferences/table-layouts/sales-invoices', layout({ order: ['mine'] }));
    expect((await b.api.get('/user-preferences/table-layouts')).body.data).toEqual({});

    await b.api.put('/user-preferences/table-layouts/sales-invoices', layout({ order: ['theirs'] }));
    expect((await a.api.get('/user-preferences/table-layouts')).body.data['sales-invoices'].order).toEqual(['mine']);
    await b.api.del('/user-preferences/table-layouts/sales-invoices');
    expect((await a.api.get('/user-preferences/table-layouts')).body.data['sales-invoices'].order).toEqual(['mine']);
  });

  it('the same login in two companies has two independent layouts', async () => {
    const a = await setup('MA');
    const b = await setup('MB');
    // one global login, a membership in each company
    const inBMember = await createMember({ companyId: b.t.company.id, roleId: b.t.role.id, email: `x-${suffix}@example.com` });
    extraUserIds.push(inBMember.user.id);
    const inAMember = await createMember({ companyId: a.t.company.id, roleId: a.t.role.id, email: '', existingUserId: inBMember.user.id });
    const u = inBMember.user;
    const inA = apiWith(tokenOf(u.id, u.email, a.t.company.id, inAMember.membership.id, a.t), app);
    const inB = apiWith(tokenOf(u.id, u.email, b.t.company.id, inBMember.membership.id, b.t), app);
    await inA.put('/user-preferences/table-layouts/t', layout({ order: ['inA'] }));
    expect((await inB.get('/user-preferences/table-layouts')).body.data).toEqual({});
    await inB.put('/user-preferences/table-layouts/t', layout({ order: ['inB'] }));
    expect((await inA.get('/user-preferences/table-layouts')).body.data.t.order).toEqual(['inA']);
  });

  it('a spoofed owner or company in the request is refused / ignored; nothing lands on another member', async () => {
    const a = await setup('F');
    const b = await setup('G');
    expect((await a.api.put('/user-preferences/table-layouts/t', { ...layout(), companyId: b.t.company.id })).status).toBe(400);
    const spoof = await a.api.put('/user-preferences/table-layouts/t', { layout: layout().layout, companyUserId: b.t.companyUser.id });
    expect(spoof.status).toBe(200);
    expect(await prisma.userTableLayout.count({ where: { companyUserId: b.t.companyUser.id } })).toBe(0);
    expect((await prisma.userTableLayout.findFirstOrThrow({ where: { companyId: a.t.company.id } })).companyUserId).toBe(a.t.companyUser.id);
    expect(Object.keys((await b.api.get('/user-preferences/table-layouts')).body.data)).toEqual([]);
  });

  it('rejects malformed ids and layouts safely and stores only the whitelisted shape', async () => {
    const { api, t } = await setup('V');
    expect((await api.put('/user-preferences/table-layouts/bad id!', layout())).status).toBe(400);
    expect((await api.put('/user-preferences/table-layouts/' + 'x'.repeat(121), layout())).status).toBe(400);
    expect((await api.put('/user-preferences/table-layouts/t', {})).status).toBe(400);
    expect((await api.put('/user-preferences/table-layouts/t', { layout: 'nope' })).status).toBe(400);
    expect((await api.put('/user-preferences/table-layouts/t', layout({ order: 'a' }))).status).toBe(400);
    expect((await api.put('/user-preferences/table-layouts/t', layout({ order: [1] }))).status).toBe(400);
    expect((await api.put('/user-preferences/table-layouts/t', layout({ widths: { a: 'wide' } }))).status).toBe(400);
    expect((await api.put('/user-preferences/table-layouts/t', layout({ widths: { a: null } }))).status).toBe(400);
    expect((await api.put('/user-preferences/table-layouts/t', layout({ order: Array.from({ length: 201 }, (_, i) => `c${i}`) }))).status).toBe(400);
    expect(await prisma.userTableLayout.count({ where: { companyId: t.company.id } })).toBe(0);

    const ok = await api.put('/user-preferences/table-layouts/t', { layout: { order: ['a'], hidden: [], widths: { a: 99999, b: 1 }, evil: '<script>' } });
    expect(ok.body.data).toEqual({ order: ['a'], hidden: [], widths: { a: 4000, b: 20 } }); // clamped, extra key dropped
    const row = await prisma.userTableLayout.findFirstOrThrow({ where: { companyId: t.company.id } });
    expect(row.layout).toEqual({ order: ['a'], hidden: [], widths: { a: 4000, b: 20 } });
  });

  it('the database refuses a layout whose company is not its members company, and RLS hides other companies rows', async () => {
    const a = await setup('R');
    const b = await setup('Q');
    await expect(prisma.userTableLayout.create({
      data: { companyId: b.t.company.id, companyUserId: a.t.companyUser.id, tableId: 't', layout: {} },
    })).rejects.toThrow();
    await a.api.put('/user-preferences/table-layouts/t', layout());
    await withForcedRls(['user_table_layouts'], async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.tenant_company_id', ${b.t.company.id}, true)`;
      expect(await tx.userTableLayout.count()).toBe(0);
      await tx.$executeRaw`SELECT set_config('app.tenant_company_id', ${a.t.company.id}, true)`;
      expect(await tx.userTableLayout.count()).toBe(1);
    });
  });

  // ── Step 2 review: membership validation, edge-case layouts, concurrency ──────────────────────────────────

  it('a deactivated membership, or a token mixing one company with another company membership, gets 401 on every route', async () => {
    const a = await setup('MV');
    const b = await setup('MW');
    await a.api.put('/user-preferences/table-layouts/t', layout());
    // token claims company A but carries company B's membership id (the "switching companies" forgery)
    const forged = apiWith(tokenOf(a.t.user.id, a.t.user.email, a.t.company.id, b.t.companyUser.id, a.t), app);
    expect((await forged.get('/user-preferences/table-layouts')).status).toBe(401);
    expect((await forged.put('/user-preferences/table-layouts/t', layout())).status).toBe(401);
    expect((await forged.del('/user-preferences/table-layouts/t')).status).toBe(401);
    // …and the other direction: company B's id with A's membership
    const forged2 = apiWith(tokenOf(a.t.user.id, a.t.user.email, b.t.company.id, a.t.companyUser.id, a.t), app);
    expect((await forged2.get('/user-preferences/table-layouts')).status).toBe(401);
    expect(await prisma.userTableLayout.count({ where: { companyUserId: b.t.companyUser.id } })).toBe(0);

    // removing the member from the company (deactivation) cuts access at once, with no token refresh
    await prisma.companyUser.update({ where: { id: a.t.companyUser.id }, data: { isActive: false } });
    expect((await a.api.get('/user-preferences/table-layouts')).status).toBe(401);
    expect((await a.api.put('/user-preferences/table-layouts/t', layout())).status).toBe(401);
    expect((await a.api.del('/user-preferences/table-layouts/t')).status).toBe(401);
    expect(await prisma.userTableLayout.count({ where: { companyUserId: a.t.companyUser.id } })).toBe(1); // untouched
  });

  it('empty layouts are legal; unknown column ids are stored as-is (the screen drops them), not rejected', async () => {
    const { api } = await setup('E');
    const empty = await api.put('/user-preferences/table-layouts/t', { layout: {} });
    expect(empty.status).toBe(200);
    expect(empty.body.data).toEqual({ order: [], hidden: [], widths: {} });
    const unknown = await api.put('/user-preferences/table-layouts/t', layout({ order: ['no-such-column', 'a'], hidden: ['ghost'], widths: { ghost: 90 } }));
    expect(unknown.status).toBe(200);
    expect((await api.get('/user-preferences/table-layouts')).body.data.t.order).toEqual(['no-such-column', 'a']);
    // duplicates collapse; zero / negative / non-finite widths are clamped or refused
    expect((await api.put('/user-preferences/table-layouts/t', layout({ order: ['a', 'a', 'b'], widths: { a: 0, b: -50 } }))).body.data)
      .toEqual({ order: ['a', 'b'], hidden: ['c'], widths: { a: 20, b: 20 } });
    expect((await api.put('/user-preferences/table-layouts/t', layout({ widths: { a: 1e999 } }))).status).toBe(400); // JSON Infinity -> null
    expect((await api.put('/user-preferences/table-layouts/t', { layout: [] })).status).toBe(400);
    expect((await api.put('/user-preferences/table-layouts/t', { layout: { widths: [] } })).status).toBe(400);
  });

  it('concurrent saves of one table never 500 or duplicate: exactly one row, holding one of the submitted layouts', async () => {
    const { api, t } = await setup('K');
    const bodies = Array.from({ length: 12 }, (_, i) => layout({ order: [`c${i}`] }));
    const res = await Promise.all(bodies.map((b) => api.put('/user-preferences/table-layouts/race', b)));
    expect(res.map((r) => r.status)).toEqual(Array(12).fill(200));
    const rows = await prisma.userTableLayout.findMany({ where: { companyId: t.company.id, tableId: 'race' } });
    expect(rows).toHaveLength(1);
    expect(bodies.map((b) => b.layout.order[0])).toContain((rows[0].layout as any).order[0]);
    // concurrent save + reset leaves a consistent state (0 or 1 row), never an error
    const mixed = await Promise.all([api.put('/user-preferences/table-layouts/race', layout()), api.del('/user-preferences/table-layouts/race'), api.put('/user-preferences/table-layouts/race', layout()), api.del('/user-preferences/table-layouts/race')]);
    expect(mixed.map((r) => r.status)).toEqual([200, 200, 200, 200]);
    expect(await prisma.userTableLayout.count({ where: { companyId: t.company.id, tableId: 'race' } })).toBeLessThanOrEqual(1);
  });

  it('the per-user cap on saved tables is enforced', async () => {
    const { api, t } = await setup('CAP');
    await prisma.userTableLayout.createMany({
      data: Array.from({ length: 300 }, (_, i) => ({ companyId: t.company.id, companyUserId: t.companyUser.id, tableId: `bulk-${i}`, layout: {} })),
    });
    expect((await api.put('/user-preferences/table-layouts/one-too-many', layout())).status).toBe(400);
    expect((await api.put('/user-preferences/table-layouts/bulk-1', layout())).status).toBe(200); // updating an existing one is fine
  });

  it('layouts are removed with their membership (and only theirs) - no orphan rows, no manual cleanup needed', async () => {
    const a = await setup('CAS');
    const b = await colleague(a.t, 'cascade-mate');
    await a.api.put('/user-preferences/table-layouts/t', layout());
    await b.api.put('/user-preferences/table-layouts/t', layout());
    await prisma.companyUser.delete({ where: { id: b.m.membership.id } });
    expect(await prisma.userTableLayout.count({ where: { companyUserId: b.m.membership.id } })).toBe(0);
    expect(await prisma.userTableLayout.count({ where: { companyUserId: a.t.companyUser.id } })).toBe(1);
  });
});
