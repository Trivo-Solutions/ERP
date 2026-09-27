import { Request, Response, NextFunction } from 'express';
import { AppError } from './error';

export function requirePermission(...permissions: string[]) {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (!req.user) throw new AppError('Authentication required', 401);

    const userPerms = new Set(req.user.permissions);
    const hasAll = permissions.every(
      (p) => userPerms.has(p) || userPerms.has('*') || userPerms.has(`${p.split(':')[0]}:*`)
    );

    if (!hasAll) {
      throw new AppError(
        `Access denied. Required: ${permissions.join(', ')}`,
        403
      );
    }
    next();
  };
}

export function requireRole(...roles: string[]) {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (!req.user) throw new AppError('Authentication required', 401);
    if (!roles.includes(req.user.roleName)) {
      throw new AppError(`Access denied. Role required: ${roles.join(' or ')}`, 403);
    }
    next();
  };
}

// Predefined permission sets per module
export const PERMISSIONS = {
  // Product Design
  DESIGN_VIEW: 'design:view',
  DESIGN_CREATE: 'design:create',
  DESIGN_EDIT: 'design:edit',
  DESIGN_DELETE: 'design:delete',
  BOM_MANAGE: 'bom:manage',
  COST_ESTIMATE: 'cost:estimate',

  // Procurement
  PO_VIEW: 'po:view',
  PO_CREATE: 'po:create',
  PO_APPROVE: 'po:approve',
  GRN_CREATE: 'grn:create',
  GRN_VERIFY: 'grn:verify',

  // Inventory
  STOCK_VIEW: 'stock:view',
  STOCK_ADJUST: 'stock:adjust',
  STONE_MANAGE: 'stone:manage',
  STONE_SPLIT: 'stone:split',
  CONSUMABLE_MANAGE: 'consumable:manage',

  // Orders
  ORDER_VIEW: 'order:view',
  ORDER_CREATE: 'order:create',
  ORDER_APPROVE: 'order:approve',
  RESERVATION_MANAGE: 'reservation:manage',

  // Manufacturing
  JOB_VIEW: 'job:view',
  JOB_CREATE: 'job:create',
  JOB_UPDATE: 'job:update',
  WIP_UPDATE: 'wip:update',
  QC_INSPECT: 'qc:inspect',
  QC_APPROVE: 'qc:approve',

  // Outsourcing
  KARIGAR_VIEW: 'karigar:view',
  KARIGAR_ISSUE: 'karigar:issue',
  KARIGAR_RETURN: 'karigar:return',
  SUBCON_INVOICE: 'subcon:invoice',

  // Quality
  HALLMARK_MANAGE: 'hallmark:manage',
  REPAIR_MANAGE: 'repair:manage',

  // Masters
  MASTERS_VIEW:   'masters:view',
  MASTERS_MANAGE: 'masters:manage',

  // Jewelry Tagging & Branches
  TAG_VIEW:        'tag:view',
  TAG_CREATE:      'tag:create',
  TAG_TEMPLATE_MANAGE: 'tagTemplate:manage',
  BRANCH_MANAGE:   'branch:manage',
  BRANCH_TRANSFER: 'branch:transfer',
  BRANCH_APPROVE:  'branch:approve',

  // Sales
  SALES_VIEW: 'sales:view',
  SALES_CREATE: 'sales:create',
  MEMO_MANAGE: 'memo:manage',
  INVOICE_CREATE: 'invoice:create',
  INVOICE_EDIT: 'invoice:edit', // amend an issued invoice (lines, prices, GST, customer) — SUPER_ADMIN via '*', or granted to a role
  EXPORT_DOC: 'export:doc',

  // Finance
  FINANCE_VIEW: 'finance:view',
  JOURNAL_CREATE: 'journal:create',
  JOURNAL_POST: 'journal:post',
  REPORT_VIEW: 'report:view',
  TAX_MANAGE: 'tax:manage',

  // Admin
  USER_MANAGE: 'user:manage',
  ROLE_MANAGE: 'role:manage',
  SYSTEM_CONFIG: 'system:config',
  AUDIT_VIEW: 'audit:view',
  HARDWARE_MANAGE: 'hardware:manage',
} as const;

export type Permission = (typeof PERMISSIONS)[keyof typeof PERMISSIONS];
