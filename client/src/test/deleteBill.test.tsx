import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { deleteBlockers, DeleteBillBody, BillFacts, MIN_REASON } from '../components/sales/DeleteBillDialog';
import { PermissionGate } from '../components/auth/PermissionGate';
import { useAuthStore } from '../store/auth.store';

// Node SSR has no store subscription: read the current state directly (same shim the other page tests use).
vi.mock('../store/auth.store', async (importOriginal) => {
  const actual: any = await importOriginal();
  const originalStore = actual.useAuthStore;
  const mockedHook: any = (selector: any) => { const s = originalStore.getState(); return selector ? selector(s) : s; };
  Object.assign(mockedHook, originalStore);
  return { ...actual, useAuthStore: mockedHook };
});

const FACTS: BillFacts = { invoiceNumber: 'INV-2026-000001', status: 'PAID', clientName: 'Test Client', totalAmount: 151850, livePayments: 2, livePaid: 151850, returns: 0, creditNotes: 0, irn: null };
const as = (permissions: string[]) => useAuthStore.setState({ user: { id: 'u', email: 'e', name: 'n', role: 'R', permissions } as any, isAuthenticated: true });

describe('delete bill - what blocks it', () => {
  it('an ordinary bill (even a paid one) can be tried', () => {
    expect(deleteBlockers(FACTS)).toEqual([]);
    expect(deleteBlockers({ ...FACTS, livePayments: 0, livePaid: 0, status: 'ISSUED' })).toEqual([]);
  });
  it('already deleted, a return, a credit note and an e-invoice each block it, with a reason the user can read', () => {
    expect(deleteBlockers({ ...FACTS, status: 'VOID' })[0]).toMatch(/already been deleted/);
    expect(deleteBlockers({ ...FACTS, returns: 1 })[0]).toMatch(/return/);
    expect(deleteBlockers({ ...FACTS, creditNotes: 1 })[0]).toMatch(/credit note/);
    expect(deleteBlockers({ ...FACTS, irn: 'abc' })[0]).toMatch(/IRN/);
    expect(deleteBlockers({ ...FACTS, returns: 1, creditNotes: 1 })).toHaveLength(2);
  });
  it('requires a reason of at least the minimum length', () => {
    expect(MIN_REASON).toBeGreaterThanOrEqual(3);
  });
});

describe('delete bill - dialog content', () => {
  const body = (facts: BillFacts, reason = '', error?: string) =>
    renderToStaticMarkup(<DeleteBillBody facts={facts} reason={reason} onReason={() => {}} error={error} />);

  it('explains exactly what will happen, including the receipts that get reversed, and asks for a reason', () => {
    const html = body(FACTS);
    expect(html).toContain('INV-2026-000001');
    expect(html).toContain('Test Client');
    expect(html).toMatch(/2 receipts/);
    expect(html).toContain('back into stock');
    expect(html).toContain('VOID');
    expect(html).toContain('cannot be undone');
    expect(html).toContain('Reason (required)');
  });
  it('an unpaid bill does not mention receipts', () => {
    expect(body({ ...FACTS, livePayments: 0, livePaid: 0 })).not.toMatch(/receipt/);
  });
  it('a blocked bill shows why and offers no reason box', () => {
    const html = body({ ...FACTS, returns: 1 });
    expect(html).toMatch(/return has been recorded/);
    expect(html).not.toContain('Reason (required)');
    expect(html).not.toContain('What happens');
  });
  it('shows the server\'s refusal text', () => {
    expect(body(FACTS, 'typo bill', 'The bill could not be deleted: voiding the bill failed')).toContain('voiding the bill failed');
  });
});

describe('delete bill - who sees the button (the server still re-checks invoice:delete)', () => {
  beforeEach(() => as([]));
  const gate = () => renderToStaticMarkup(<PermissionGate permission="invoice:delete"><button>Delete</button></PermissionGate>);

  it('Super Admin (*) and a user granted invoice:delete see it', () => {
    as(['*']); expect(gate()).toContain('Delete');
    as(['invoice:delete']); expect(gate()).toContain('Delete');
    as(['invoice:*']); expect(gate()).toContain('Delete');
  });
  it('void / reverse / edit alone, or nothing, do not', () => {
    as(['invoice:void', 'payment:reverse', 'invoice:edit', 'invoice:create']); expect(gate()).not.toContain('Delete');
    as([]); expect(gate()).not.toContain('Delete');
  });
});
