import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import { Prisma } from '@prisma/client';
import { AppError } from '../../middleware/error';
import { runAsPlatform } from '../../shared/tenantContext';
import { LEDGER_ACCOUNT } from '../../shared/ledgerAccounts';
import { newInvitationToken } from '../auth/invitationToken';
import { applyStarterPackage, getStarterPackage, type StarterApplyCounts } from './starterPackage';
import { collidesWithExisting, validateCompanyCodeFormat } from './companyCode';

// ═══════════════════════════════════════════════════════════════════════════
// provisionCompany() — the ONE authoritative workflow that creates a TRIVO company.
//
//   Create company identity
//     -> roles, head-office branch, chart of accounts, company-owned masters, templates,
//        default configuration   (all COPIED from the versioned Starter Package)
//     -> company administrator (a membership, or a pending invitation — see below)
//     -> verify the company is complete
//     -> record a platform audit event
//
// It is ONE database transaction: if any step fails, everything rolls back — there is never a
// half-created company. It is written to be safe for a future self-service signup (all input is
// validated; nothing here trusts the caller), but is currently reached only through operator-
// controlled entry points (POST /platform/companies, the provision-company script).
//
// The administrator: if the admin e-mail has NO login yet, one is created and made SUPER_ADMIN. If it
// ALREADY has a login (it may belong to another company), that login is NOT attached — a pending
// SUPER_ADMIN invitation is created instead, which the person must accept. Provisioning therefore
// never silently gives a company access to an existing login.
// ═══════════════════════════════════════════════════════════════════════════

export type ProvisionStep = 'company' | 'roles' | 'branch' | 'accounts' | 'starterPackage' | 'admin' | 'verify' | 'audit';

export interface ProvisionCompanyInput {
  code: string;
  name: string;
  gstin?: string | null;
  stateCode?: string | null;
  address?: string | null;
  defaultCurrency?: string;
  admin: { email: string; name: string; password?: string };
  branch?: { code?: string; name?: string; city?: string; state?: string; address?: string; phone?: string };
  /** Defaults to the latest released package. */
  starterPackageVersion?: number;
  /** The platform operator performing the action (recorded in the platform audit log). */
  actor?: { userId?: string; label?: string };
}

export interface ProvisionCompanyResult {
  company: { id: string; code: string; name: string };
  starterPackage: { version: number; name: string; counts: StarterApplyCounts };
  branch: { id: string; code: string; name: string };
  admin:
    | { mode: 'MEMBER'; userId: string; companyUserId: string; email: string; initialPassword?: string }
    | { mode: 'INVITATION'; invitationId: string; email: string; token: string; expiresAt: Date };
}

export interface ProvisionOptions {
  /** Test seam: called after each step inside the transaction; throwing aborts and rolls everything back. */
  hooks?: { afterStep?: (step: ProvisionStep) => void | Promise<void> };
}

const INVITATION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function fail(message: string, status = 400): never {
  throw new AppError(message, status);
}

function validateInput(input: ProvisionCompanyInput) {
  const codeCheck = validateCompanyCodeFormat(input.code);
  if (!codeCheck.ok) {
    fail(codeCheck.reason === 'RESERVED'
      ? 'That company code is reserved'
      : 'Company code must be 3-12 letters/digits, starting with a letter');
  }
  const name = (input.name ?? '').trim();
  if (name.length < 2 || name.length > 120) fail('Company name must be 2-120 characters');
  const email = (input.admin?.email ?? '').trim().toLowerCase();
  if (!EMAIL.test(email)) fail('A valid administrator email is required');
  const adminName = (input.admin?.name ?? '').trim();
  if (adminName.length < 2) fail('Administrator name is required');
  if (input.admin.password !== undefined && input.admin.password.length < 12) {
    fail('Administrator password must be at least 12 characters');
  }
  const currency = (input.defaultCurrency ?? 'INR').toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) fail('defaultCurrency must be a 3-letter currency code');
  return { code: codeCheck.code, name, email, adminName, currency };
}

export async function provisionCompany(
  input: ProvisionCompanyInput,
  options: ProvisionOptions = {},
): Promise<ProvisionCompanyResult> {
  const v = validateInput(input);
  const pkg = (() => {
    try { return getStarterPackage(input.starterPackageVersion); } catch { return fail('Unknown Starter Package version'); }
  })();

  // bcrypt is slow (~250ms) — done before opening the transaction so it isn't held open meanwhile.
  const suppliedPassword = input.admin.password;
  const initialPassword = suppliedPassword ?? crypto.randomBytes(15).toString('base64url');
  const passwordHash = await bcrypt.hash(initialPassword, 12);

  const step = async (name: ProvisionStep) => { await options.hooks?.afterStep?.(name); };

  try {
    return await runAsPlatform((db) => db.$transaction(async (tx) => {
      // ── Company identity ────────────────────────────────────────────────────
      const existingCodes = (await tx.company.findMany({ select: { code: true } })).map((c) => c.code);
      if (collidesWithExisting(v.code, existingCodes)) fail('That company code is not available', 409);

      const company = await tx.company.create({
        data: {
          code: v.code, name: v.name, gstin: input.gstin ?? null, stateCode: input.stateCode ?? null,
          address: input.address ?? null, defaultCurrency: v.currency,
          starterPackageVersion: pkg.version, starterPackageAppliedAt: new Date(),
        },
      });
      // Everything below is company-owned: bind the session to the new company (row-level security).
      await tx.$executeRaw`SELECT set_config('app.tenant_company_id', ${company.id}, true)`;
      await step('company');

      // ── Roles, chart of accounts, masters, templates, config — COPIED from the package ──
      const { roles, counts } = await applyStarterPackage(tx, company.id, pkg);
      await step('roles');

      // ── Head-office branch (from this company's own input — never copied from another company) ──
      const branch = await tx.branch.create({
        data: {
          companyId: company.id, branchCode: input.branch?.code?.trim().toUpperCase() || 'HO',
          name: input.branch?.name?.trim() || 'Head Office', isHeadOffice: true,
          city: input.branch?.city, state: input.branch?.state, address: input.branch?.address, phone: input.branch?.phone,
        },
      });
      await step('branch');
      await step('accounts'); // (applied with the package above; kept as a distinct, observable step)
      await step('starterPackage');

      // ── Company administrator ───────────────────────────────────────────────
      const superAdmin = roles.find((r) => r.name === 'SUPER_ADMIN');
      if (!superAdmin) throw new Error('Starter Package has no SUPER_ADMIN role');

      let admin: ProvisionCompanyResult['admin'];
      const existingUser = await tx.user.findUnique({ where: { email: v.email } });
      if (!existingUser) {
        const user = await tx.user.create({ data: { email: v.email, name: v.adminName, password: passwordHash } });
        const membership = await tx.companyUser.create({
          data: { companyId: company.id, userId: user.id, roleId: superAdmin.id, allBranches: true, isDefault: true },
        });
        admin = {
          mode: 'MEMBER', userId: user.id, companyUserId: membership.id, email: v.email,
          // only revealed when WE generated it (an operator-supplied password is already known to them)
          ...(suppliedPassword ? {} : { initialPassword }),
        };
      } else {
        // The e-mail already has a login somewhere: never attach it silently. Explicit invitation.
        const { token, tokenHash } = newInvitationToken(company.id);
        const expiresAt = new Date(Date.now() + INVITATION_TTL_MS);
        const inv = await tx.companyInvitation.create({
          data: {
            companyId: company.id, email: v.email, roleId: superAdmin.id, allBranches: true, branchIds: [],
            tokenHash, expiresAt, invitedById: input.actor?.userId ?? null,
          },
        });
        admin = { mode: 'INVITATION', invitationId: inv.id, email: v.email, token, expiresAt };
      }
      await step('admin');

      // ── The company must be complete, or the whole transaction is rolled back ──────
      await verifyProvisioned(tx, company.id, pkg.masters.karats.length, counts, admin.mode);
      await step('verify');

      await tx.platformAuditLog.create({
        data: {
          actorUserId: input.actor?.userId ?? null,
          action: 'COMPANY_PROVISIONED', subjectType: 'company', subjectId: company.id,
          metadata: {
            code: company.code, starterPackageVersion: pkg.version, adminMode: admin.mode,
            actorLabel: input.actor?.label ?? null, counts: counts as unknown as Prisma.InputJsonValue,
          },
        },
      });
      await step('audit');

      return {
        company: { id: company.id, code: company.code, name: company.name },
        starterPackage: { version: pkg.version, name: pkg.name, counts },
        branch: { id: branch.id, code: branch.branchCode, name: branch.name },
        admin,
      };
    }, { maxWait: 10_000, timeout: 60_000 }));
  } catch (err) {
    // Two operators racing on the same code: the unique constraint is the arbiter.
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      throw new AppError('That company code is not available', 409);
    }
    throw err;
  }
}

async function verifyProvisioned(
  tx: Prisma.TransactionClient,
  companyId: string,
  karatCount: number,
  counts: StarterApplyCounts,
  adminMode: 'MEMBER' | 'INVITATION',
) {
  const problems: string[] = [];
  const expect = (label: string, actual: number, want: number) => { if (actual !== want) problems.push(`${label}: expected ${want}, found ${actual}`); };

  expect('roles', await tx.role.count({ where: { companyId } }), counts.roles);
  expect('branches', await tx.branch.count({ where: { companyId } }), 1);
  expect('accounts', await tx.account.count({ where: { companyId } }), counts.accounts);
  expect('karats', await tx.karatMaster.count({ where: { companyId } }), karatCount);
  expect('product categories', await tx.productCategory.count({ where: { companyId } }), counts.productCategories);
  expect('tag templates', await tx.tagTemplate.count({ where: { companyId } }), counts.tagTemplates);
  expect('estimate templates', await tx.estimateTemplate.count({ where: { companyId } }), counts.estimateTemplates);
  expect('config', await tx.systemConfig.count({ where: { companyId } }), counts.config);
  if (adminMode === 'MEMBER') expect('admin memberships', await tx.companyUser.count({ where: { companyId } }), 1);
  else expect('admin invitations', await tx.companyInvitation.count({ where: { companyId } }), 1);

  // The automatic journal postings (sales, purchases, returns, payments) depend on these exact accounts.
  const needed = Object.values(LEDGER_ACCOUNT);
  const have = new Set((await tx.account.findMany({ where: { companyId, code: { in: needed } }, select: { code: true } })).map((a) => a.code));
  for (const code of needed) if (!have.has(code)) problems.push(`missing ledger account ${code}`);

  if (problems.length > 0) throw new Error(`Company provisioning verification failed: ${problems.join('; ')}`);
}
