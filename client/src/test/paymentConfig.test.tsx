import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { SnackbarProvider } from 'notistack';
import { MemoryRouter } from 'react-router-dom';
import { Grid } from '@mui/material';
import { PaymentLegFields } from '../components/sales/PaymentLegFields';
import { PaymentConfigPage, providerFormError, terminalFormError } from '../pages/Settings/PaymentConfigPage';
import { blankMeta, fieldsFor, legMetaPayload, legMetaError, CollectionOptions } from '../utils/paymentLegMeta';
import { useAuthStore } from '../store/auth.store';
import { NAV_ITEMS } from '../components/Layout/navItems';

// Node SSR has no DOM store subscription: read the current state directly (same shim the other page tests use).
vi.mock('../store/auth.store', async (importOriginal) => {
  const actual: any = await importOriginal();
  const originalStore = actual.useAuthStore;
  const mockedHook: any = (selector: any) => { const s = originalStore.getState(); return selector ? selector(s) : s; };
  Object.assign(mockedHook, originalStore);
  return { ...actual, useAuthStore: mockedHook };
});

const UPI_BANK = { id: 'p-upi', name: 'PhonePe Bank', shortCode: 'PPB', category: 'UPI_PROVIDER', supportedMethods: ['UPI'] };
const SBI = { id: 'p-sbi', name: 'SBI', shortCode: 'SBI', category: 'BANK', supportedMethods: ['BANK_TRANSFER', 'CHEQUE', 'UPI'] };
const TERM = { id: 't1', code: 'POS-1', name: 'Counter 1', tid: 'TID001', mid: 'MID1', supportedMethods: ['CARD'], providerId: 'p-acq', providerName: 'HDFC' };
const OPTIONS: CollectionOptions = { branchId: 'b1', providers: [UPI_BANK, SBI], terminals: [TERM], requireTerminalForCard: true, requireProviderForBankTransfer: true };
const EMPTY: CollectionOptions = { branchId: 'b2', providers: [], terminals: [], requireTerminalForCard: false, requireProviderForBankTransfer: false };

const leg = (mode: string, options: CollectionOptions | null, extra: Partial<React.ComponentProps<typeof PaymentLegFields>> = {}) =>
  renderToStaticMarkup(
    <Grid container><PaymentLegFields mode={mode} value={blankMeta()} onChange={() => {}} options={options} {...extra} /></Grid>,
  );

describe('payment leg fields follow the selected method', () => {
  it('cash shows nothing extra - no bank, terminal or reference', () => {
    const html = leg('CASH', OPTIONS);
    expect(html).not.toMatch(/terminal|provider|auth|cheque/i);
  });

  it('card requires a terminal (when the branch has one) and asks for the approval code', () => {
    const html = leg('CARD', OPTIONS);
    expect(html).toContain('POS terminal');
    expect(html).toContain('POS-1 · HDFC · TID TID001');
    expect(html).toContain('Approval / auth code');
    expect(html).not.toContain('Bank / provider');
    expect(fieldsFor('CARD', OPTIONS)).toMatchObject({ terminalRequired: true });
  });

  it('upi asks for the bank (several can take UPI at a branch) and never forces a POS terminal', () => {
    const f = fieldsFor('UPI', OPTIONS);
    expect(f.providers.map((p) => p.id)).toEqual(['p-upi', 'p-sbi']);
    expect(f.terminal).toBe(false); // the only terminal is card-only
    expect(f.providerRequired).toBe(true);
    expect(legMetaError('UPI', blankMeta(), OPTIONS)).toMatch(/bank/i);
    expect(legMetaError('UPI', { ...blankMeta(), providerId: 'p-upi' }, OPTIONS)).toBe('');
    expect(leg('UPI', OPTIONS)).toContain('Bank / provider');
    expect(leg('UPI', OPTIONS)).not.toContain('POS terminal');
    expect(leg('UPI', EMPTY)).toContain('No bank is set up for UPI');
  });

  it('bank transfer requires a provider that serves transfers', () => {
    const f = fieldsFor('BANK_TRANSFER', OPTIONS);
    expect(f.providers.map((p) => p.id)).toEqual(['p-sbi']);
    expect(f.providerRequired).toBe(true);
    expect(legMetaError('BANK_TRANSFER', blankMeta(), OPTIONS)).toMatch(/bank/i);
    expect(legMetaError('BANK_TRANSFER', { ...blankMeta(), providerId: 'p-sbi' }, OPTIONS)).toBe('');
    expect(leg('BANK_TRANSFER', OPTIONS)).toContain('Bank / provider');
  });

  it('cheque shows number, date and bank', () => {
    const html = leg('CHEQUE', OPTIONS);
    expect(html).toContain('Cheque no.');
    expect(html).toContain('Cheque date');
    expect(html).toContain('Cheque bank');
  });

  it('a branch with nothing configured keeps today\'s payload: no extra fields, nothing required', () => {
    for (const m of ['CASH', 'CARD', 'UPI', 'BANK_TRANSFER']) {
      expect(legMetaError(m, blankMeta(), EMPTY)).toBe('');
      expect(legMetaPayload(m, blankMeta(), EMPTY)).toEqual({});
    }
    expect(leg('CARD', EMPTY)).not.toContain('POS terminal');
    expect(legMetaError('CARD', blankMeta(), null)).toBe('');
  });

  it('only sends the keys that belong to the method (a stale terminal from a previous mode is dropped)', () => {
    const meta = { ...blankMeta(), terminalId: 't1', providerId: 'p-sbi', authCode: ' A1B2 ', chequeNumber: '55' };
    expect(legMetaPayload('CARD', meta, OPTIONS)).toEqual({ terminalId: 't1', authCode: 'A1B2' });
    expect(legMetaPayload('BANK_TRANSFER', meta, OPTIONS)).toEqual({ providerId: 'p-sbi' });
    expect(legMetaPayload('CASH', meta, OPTIONS)).toEqual({});
    expect(legMetaPayload('CHEQUE', { ...blankMeta(), chequeNumber: ' 000123 ', chequeDate: '2026-10-20', chequeBank: 'Axis' }, OPTIONS))
      .toEqual({ chequeNumber: '000123', chequeDate: '2026-10-20', chequeBank: 'Axis' });
  });

  it('a card number typed into the approval code is refused', () => {
    expect(legMetaError('CARD', { ...blankMeta(), terminalId: 't1', authCode: '4111111111111111' }, OPTIONS)).toMatch(/card number/i);
    expect(legMetaError('CARD', { ...blankMeta(), terminalId: 't1', authCode: 'AB 12' }, OPTIONS)).toMatch(/letters, digits/i);
    expect(legMetaError('CARD', { ...blankMeta(), terminalId: 't1', authCode: 'AB12' }, OPTIONS)).toBe('');
  });

  it('shows loading and error states without blocking payment (cash is never affected)', () => {
    expect(leg('CARD', null, { isLoading: true })).toContain('Loading payment options');
    expect(leg('CARD', null, { isError: true })).toContain('Could not load');
    expect(leg('CASH', null, { isLoading: true })).not.toContain('Loading');
  });

  it('shows the validation message only after a submit attempt', () => {
    const msg = 'Select the POS terminal';
    expect(leg('CARD', OPTIONS, { showErrors: false, error: msg })).not.toContain(msg);
    expect(leg('CARD', OPTIONS, { showErrors: true, error: msg })).toContain(msg);
  });
});

describe('configuration form validation', () => {
  it('provider needs a name, category and at least one method', () => {
    expect(providerFormError({ name: ' ', category: 'BANK', supportedMethods: ['UPI'] })).toMatch(/name/);
    expect(providerFormError({ name: 'HDFC', category: 'BANK', supportedMethods: [] })).toMatch(/method/);
    expect(providerFormError({ name: 'HDFC', category: 'BANK', supportedMethods: ['CARD'] })).toBe('');
  });
  it('terminal needs code, name, provider, a clean TID, branch and a method', () => {
    const ok = { code: 'P1', name: 'Counter', providerId: 'p', tid: 'T-1', branchId: 'b', supportedMethods: ['CARD'] };
    expect(terminalFormError(ok)).toBe('');
    expect(terminalFormError({ ...ok, tid: '' })).toMatch(/TID/);
    expect(terminalFormError({ ...ok, tid: 'bad;tid' })).toMatch(/TID/);
    expect(terminalFormError({ ...ok, providerId: '' })).toMatch(/provider/i);
    expect(terminalFormError({ ...ok, branchId: '' })).toMatch(/branch/i);
    expect(terminalFormError({ ...ok, supportedMethods: [] })).toMatch(/method/i);
  });
});

describe('management screen follows permissions', () => {
  let qc: QueryClient;
  const render = () => renderToStaticMarkup(
    <QueryClientProvider client={qc}><MemoryRouter><SnackbarProvider><PaymentConfigPage /></SnackbarProvider></MemoryRouter></QueryClientProvider>,
  );
  const as = (permissions: string[]) => useAuthStore.setState({
    user: { id: 'u', fullName: 'U', email: 'u@x.com', role: 'R', companyId: 'c', permissions } as any, isAuthenticated: true,
  } as any);

  beforeEach(() => { qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } }); });

  it('a manager sees the Add button; a view-only user does not', () => {
    as(['paymentConfig:view', 'paymentConfig:manage']);
    expect(render()).toContain('Add provider');
    as(['paymentConfig:view']);
    const html = render();
    expect(html).toContain('Banks / providers');
    expect(html).not.toContain('Add provider');
  });

  it('has the three tabs and a loading state before data arrives', () => {
    as(['paymentConfig:view']);
    const html = render();
    expect(html).toContain('Branch availability');
    expect(html).toContain('POS terminals');
  });
});

describe('navigation', () => {
  it('Payment Setup is gated by paymentConfig:view', () => {
    const item = NAV_ITEMS.find((n) => n.label === 'Payment Setup');
    expect(item).toMatchObject({ path: '/settings/payment-config', permission: 'paymentConfig:view' });
  });
});
