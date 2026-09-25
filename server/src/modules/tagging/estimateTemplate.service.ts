import { Prisma } from '@prisma/client';
import { prisma } from '../../config/database';
import { AppError } from '../../middleware/error';
import {tenantTransaction, tenantQuery } from '../../shared/tenantContext';

// CRUD for the Estimation module's print template — structural mirror of tagging.service.ts's
// TagTemplate CRUD (listTagTemplates/getTagTemplateById/createTagTemplate/updateTagTemplate),
// same "clear other isDefault rows in a transaction" invariant, kept as its own file/model since
// EstimateTemplate belongs to Estimation, not Tagging (see estimation.router.ts).
// companyId direct — Phase 3, same treatment as TagTemplate.

export async function listEstimateTemplates(companyId: string) {
  return tenantQuery(companyId, (_tx) => _tx.estimateTemplate.findMany({
    where: { companyId },
    orderBy: [{ isDefault: 'desc' }, { name: 'asc' }],
  }));
}

export async function getEstimateTemplateById(companyId: string, id: string) {
  const template = await tenantQuery(companyId, (_tx) => _tx.estimateTemplate.findUnique({ where: { id } }));
  if (!template || template.companyId !== companyId) throw new AppError('Estimate template not found', 404);
  return template;
}

function validateLayout(layout: unknown): { elements: unknown[] } {
  if (!layout || typeof layout !== 'object' || !Array.isArray((layout as any).elements)) {
    throw new AppError('Template layout must be an object with an "elements" array', 400);
  }
  return layout as { elements: unknown[] };
}

export async function createEstimateTemplate(companyId: string, data: {
  name: string; isDefault?: boolean; widthMm: number; heightMm: number; layout: unknown;
}, userId: string) {
  if (!data.name?.trim()) throw new AppError('Template name is required', 400);
  if (!data.widthMm || !data.heightMm) throw new AppError('Paper width and height are required', 400);
  const layout = validateLayout(data.layout);

  return tenantTransaction(companyId, async (tx) => {
    // Only one default PER COMPANY at a time — the Estimation page's print picker falls back to
    // whichever row has isDefault:true WITHIN this company.
    if (data.isDefault) {
      await tx.estimateTemplate.updateMany({ where: { companyId, isDefault: true }, data: { isDefault: false } });
    }
    return tx.estimateTemplate.create({
      data: {
        companyId,
        name: data.name,
        isDefault: data.isDefault ?? false,
        widthMm: data.widthMm,
        heightMm: data.heightMm,
        layout: layout as unknown as Prisma.InputJsonValue,
        createdById: userId,
      },
    });
  });
}

export async function updateEstimateTemplate(companyId: string, id: string, data: {
  name?: string; isDefault?: boolean; widthMm?: number; heightMm?: number; layout?: unknown;
}) {
  await getEstimateTemplateById(companyId, id); // 404s cleanly if missing/wrong-company, before touching anything
  const layout = data.layout !== undefined ? validateLayout(data.layout) : undefined;

  return tenantTransaction(companyId, async (tx) => {
    if (data.isDefault) {
      await tx.estimateTemplate.updateMany({ where: { companyId, isDefault: true, NOT: { id } }, data: { isDefault: false } });
    }
    return tx.estimateTemplate.update({
      where: { id },
      data: {
        ...(data.name !== undefined && { name: data.name }),
        ...(data.isDefault !== undefined && { isDefault: data.isDefault }),
        ...(data.widthMm !== undefined && { widthMm: data.widthMm }),
        ...(data.heightMm !== undefined && { heightMm: data.heightMm }),
        ...(layout !== undefined && { layout: layout as unknown as Prisma.InputJsonValue }),
      },
    });
  });
}
