import crypto from 'crypto';
import { Router, Request, Response, NextFunction } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { env } from '../../config/env';
import { AppError } from '../../middleware/error';
import { validate } from '../../middleware/validate';
import { runAsPlatform } from '../../shared/tenantContext';
import { provisionCompany } from './provisioning.service';
import { listStarterPackageVersions, getStarterPackage } from './starterPackage';
import { disconnectCompany } from '../../shared/websocket';

// ═══════════════════════════════════════════════════════════════════════════
// TRIVO PLATFORM (operator) API — creating and administering COMPANIES themselves.
//
// This is deliberately NOT part of any company's API: it is not reachable with a company JWT, it
// sees no company business data (only company identity metadata), and it is protected by a
// separate operator secret rather than a tenant login.
//
//   - Disabled entirely (404, as if it did not exist) unless TRIVO_PLATFORM_API_KEY is configured.
//   - The key travels in the `x-trivo-platform-key` header and is compared in constant time.
//   - Every attempt is rate-limited, and a wrong key gets the same generic 401 as a missing one.
//   - Company registration is operator-only for now (no public sign-up); provisionCompany() itself
//     is already safe to expose to self-service later, which would add e-mail verification.
// ═══════════════════════════════════════════════════════════════════════════

export const platformRouter = Router();

const platformLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  skip: () => process.env.NODE_ENV === 'test',
  message: { success: false, error: 'Too many requests' },
}) as any;

function digest(s: string) { return crypto.createHash('sha256').update(s).digest(); }

function requirePlatformKey(req: Request, _res: Response, next: NextFunction) {
  const configured = process.env.TRIVO_PLATFORM_API_KEY ?? env.TRIVO_PLATFORM_API_KEY;
  if (!configured) throw new AppError('Not found', 404); // feature off: indistinguishable from no such route
  const supplied = String(req.header('x-trivo-platform-key') ?? '');
  // Compare fixed-length digests so timing reveals nothing about the key.
  if (!supplied || !crypto.timingSafeEqual(digest(supplied), digest(configured))) {
    throw new AppError('Unauthorized', 401);
  }
  next();
}

platformRouter.use(platformLimiter, requirePlatformKey);

const provisionSchema = z.object({
  code: z.string().min(1).max(40),
  name: z.string().min(1).max(200),
  gstin: z.string().max(20).nullable().optional(),
  stateCode: z.string().max(4).nullable().optional(),
  address: z.string().max(500).nullable().optional(),
  defaultCurrency: z.string().length(3).optional(),
  admin: z.object({
    email: z.string().max(200),
    name: z.string().max(200),
    password: z.string().max(200).optional(),
  }),
  branch: z.object({
    code: z.string().max(20).optional(), name: z.string().max(120).optional(),
    city: z.string().max(80).optional(), state: z.string().max(80).optional(),
    address: z.string().max(300).optional(), phone: z.string().max(30).optional(),
  }).optional(),
  starterPackageVersion: z.number().int().positive().optional(),
}).strict();

platformRouter.post('/companies', validate(provisionSchema), async (req: Request, res: Response) => {
  const result = await provisionCompany({ ...req.body, actor: { label: 'platform-api' } });
  res.status(201).json({ success: true, data: result });
});

// Company identity metadata only — never any business data.
platformRouter.get('/companies', async (_req: Request, res: Response) => {
  const companies = await runAsPlatform((db) => db.company.findMany({
    select: { id: true, code: true, name: true, isActive: true, starterPackageVersion: true, createdAt: true },
    orderBy: { createdAt: 'asc' },
  }));
  res.json({ success: true, data: companies });
});

// Suspend / re-activate a company. A suspended company can neither log in nor use tokens it already holds.
platformRouter.patch('/companies/:id/status', validate(z.object({ isActive: z.boolean() }).strict()), async (req: Request, res: Response) => {
  const { isActive } = req.body as { isActive: boolean };
  const company = await runAsPlatform(async (db) => {
    const updated = await db.company.update({ where: { id: req.params.id }, data: { isActive }, select: { id: true, code: true, isActive: true } });
    await db.platformAuditLog.create({
      data: { action: isActive ? 'COMPANY_ACTIVATED' : 'COMPANY_SUSPENDED', subjectType: 'company', subjectId: updated.id, metadata: { code: updated.code, actorLabel: 'platform-api' } },
    });
    return updated;
  });
  if (!isActive) disconnectCompany(company.id); // cut off its live sockets too, not just new logins
  res.json({ success: true, data: company });
});

platformRouter.get('/starter-packages', (_req: Request, res: Response) => {
  const data = listStarterPackageVersions().map((v) => {
    const p = getStarterPackage(v);
    return { version: p.version, name: p.name, roles: p.roles.length, accounts: p.chartOfAccounts.length, masters: Object.fromEntries(Object.entries(p.masters).map(([k, arr]) => [k, arr.length])), tagTemplates: p.templates.tag.length, estimateTemplates: p.templates.estimate.length, config: p.config.length };
  });
  res.json({ success: true, data });
});
