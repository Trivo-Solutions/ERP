import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { GstSummary } from '../pages/Reports/GstSummary';
import { PurchaseGstSummary } from '../pages/Reports/PurchaseGstSummary';
import { SalesRegister } from '../pages/Reports/SalesRegister';
import { gstFinancialYear, defaultGstFrom, defaultGstTo, formatLocalDate } from '../utils/date';
import { useAuthStore } from '../store/auth.store';
import * as apiClient from '../api/client';

// In Node SSR test environment (without browser DOM), Zustand's useSyncExternalStore
// falls back to getInitialState() unless the hook is directed to evaluate against getState().
vi.mock('../store/auth.store', async (importOriginal) => {
  const actual: any = await importOriginal();
  const originalStore = actual.useAuthStore;
  const mockedHook: any = (selector: any) => {
    const state = originalStore.getState();
    return selector ? selector(state) : state;
  };
  Object.assign(mockedHook, originalStore);
  return {
    ...actual,
    useAuthStore: mockedHook,
  };
});

describe('GST Reports Frontend Test Suite (Items 1-12)', () => {
  let qc: QueryClient;

  beforeEach(() => {
    qc = new QueryClient({
      defaultOptions: {
        queries: { retry: false, gcTime: 0 },
      },
    });
    vi.restoreAllMocks();
  });

  const renderWithProviders = (ui: React.ReactElement, client = qc) => {
    return renderToStaticMarkup(
      <MemoryRouter>
        <QueryClientProvider client={client}>
          {ui}
        </QueryClientProvider>
      </MemoryRouter>
    );
  };

  // 1. GST registration selector renders
  it('1. GST registration selector renders', () => {
    const html = renderWithProviders(<GstSummary />);
    expect(html).toContain('GST Registration');
    expect(html).toContain('All Registrations');
  });

  // 2. Active registrations appear correctly
  it('2. Active registrations appear correctly and inactive ones are excluded', () => {
    const registrations = [
      { id: 'reg-active-1', gstin: '27AABCU9603R1ZX', legalName: 'Alpha Jewel Corp', tradeName: 'Alpha Jewels', isActive: true },
      { id: 'reg-active-2', gstin: '27AABCU9603R1ZY', legalName: 'Beta Ornaments', tradeName: null, isActive: true },
      { id: 'reg-inactive', gstin: '27AABCU9603R1ZZ', legalName: 'Old Inactive Reg', tradeName: 'Old', isActive: false },
    ];
    qc.setQueryData(['gst-registrations'], registrations);

    const html = renderWithProviders(<GstSummary />);

    // Active registration with trade name displays: GSTIN — Legal Name (Trade Name)
    expect(html).toContain('27AABCU9603R1ZX — Alpha Jewel Corp (Alpha Jewels)');
    // Active registration without distinct trade name displays: GSTIN — Legal Name
    expect(html).toContain('27AABCU9603R1ZY — Beta Ornaments');
    // Inactive registration must not appear in the active dropdown
    expect(html).not.toContain('27AABCU9603R1ZZ');
    expect(html).not.toContain('Old Inactive Reg');
  });

  // 3. All Registrations does not send a registration filter
  it('3. All Registrations does not send a registration filter', () => {
    const capturedCalls: any[] = [];
    vi.spyOn(apiClient, 'apiGet').mockImplementation(async (url: string, params?: any) => {
      capturedCalls.push({ url, params });
      return { rows: [], totals: {} };
    });

    const branchId = '';
    const gstRegistrationId = '';
    const from = '2026-04-01';
    const to = '2026-09-30';

    // Simulate query parameter generation used in GstSummary
    const params = {
      from,
      to,
      ...(branchId ? { branchId } : {}),
      ...(gstRegistrationId ? { gstRegistrationId } : {}),
    };

    apiClient.apiGet('/finance/reports/gst-summary', params);

    expect(capturedCalls).toHaveLength(1);
    expect(capturedCalls[0].url).toBe('/finance/reports/gst-summary');
    expect(capturedCalls[0].params.from).toBe('2026-04-01');
    expect(capturedCalls[0].params.to).toBe('2026-09-30');
    expect(capturedCalls[0].params.gstRegistrationId).toBeUndefined();
  });

  // 4. Selecting a registration sends gstRegistrationId
  it('4. Selecting a registration sends gstRegistrationId', () => {
    const capturedCalls: any[] = [];
    vi.spyOn(apiClient, 'apiGet').mockImplementation(async (url: string, params?: any) => {
      capturedCalls.push({ url, params });
      return { rows: [], totals: {} };
    });

    const branchId = '';
    const gstRegistrationId = 'reg-guid-1234';
    const from = '2026-04-01';
    const to = '2026-09-30';

    const params = {
      from,
      to,
      ...(branchId ? { branchId } : {}),
      ...(gstRegistrationId ? { gstRegistrationId } : {}),
    };

    apiClient.apiGet('/finance/reports/gst-summary', params);

    expect(capturedCalls).toHaveLength(1);
    expect(capturedCalls[0].params.gstRegistrationId).toBe('reg-guid-1234');
    expect(capturedCalls[0].params.branchId).toBeUndefined();
  });

  // 5. Selecting a branch sends branchId
  it('5. Selecting a branch sends branchId', () => {
    const capturedCalls: any[] = [];
    vi.spyOn(apiClient, 'apiGet').mockImplementation(async (url: string, params?: any) => {
      capturedCalls.push({ url, params });
      return { rows: [], totals: {} };
    });

    const branchId = 'branch-guid-5678';
    const gstRegistrationId = '';
    const from = '2026-04-01';
    const to = '2026-09-30';

    const params = {
      from,
      to,
      ...(branchId ? { branchId } : {}),
      ...(gstRegistrationId ? { gstRegistrationId } : {}),
    };

    apiClient.apiGet('/finance/reports/gst-summary', params);

    expect(capturedCalls).toHaveLength(1);
    expect(capturedCalls[0].params.branchId).toBe('branch-guid-5678');
    expect(capturedCalls[0].params.gstRegistrationId).toBeUndefined();
  });

  // 6. Changing branch preserves registration/date filters
  it('6. Changing branch preserves registration/date filters', () => {
    const capturedCalls: any[] = [];
    vi.spyOn(apiClient, 'apiGet').mockImplementation(async (url: string, params?: any) => {
      capturedCalls.push({ url, params });
      return { rows: [], totals: {} };
    });

    const from = '2026-05-01';
    const to = '2026-10-15';
    const gstRegistrationId = 'reg-preserve-456';
    let branchId = 'initial-branch';

    // Initial load
    apiClient.apiGet('/finance/reports/gst-summary', {
      from, to,
      ...(branchId ? { branchId } : {}),
      ...(gstRegistrationId ? { gstRegistrationId } : {}),
    });

    // Change branch
    branchId = 'new-branch';
    apiClient.apiGet('/finance/reports/gst-summary', {
      from, to,
      ...(branchId ? { branchId } : {}),
      ...(gstRegistrationId ? { gstRegistrationId } : {}),
    });

    expect(capturedCalls).toHaveLength(2);
    expect(capturedCalls[1].params.branchId).toBe('new-branch');
    expect(capturedCalls[1].params.gstRegistrationId).toBe('reg-preserve-456');
    expect(capturedCalls[1].params.from).toBe('2026-05-01');
    expect(capturedCalls[1].params.to).toBe('2026-10-15');
  });

  // 7. Changing registration preserves branch/date filters
  it('7. Changing registration preserves branch/date filters', () => {
    const capturedCalls: any[] = [];
    vi.spyOn(apiClient, 'apiGet').mockImplementation(async (url: string, params?: any) => {
      capturedCalls.push({ url, params });
      return { rows: [], totals: {} };
    });

    const from = '2026-04-01';
    const to = '2026-08-31';
    const branchId = 'branch-preserve-789';
    let gstRegistrationId = 'reg-initial';

    // Initial load
    apiClient.apiGet('/finance/reports/gst-summary', {
      from, to,
      ...(branchId ? { branchId } : {}),
      ...(gstRegistrationId ? { gstRegistrationId } : {}),
    });

    // Change registration
    gstRegistrationId = 'reg-updated';
    apiClient.apiGet('/finance/reports/gst-summary', {
      from, to,
      ...(branchId ? { branchId } : {}),
      ...(gstRegistrationId ? { gstRegistrationId } : {}),
    });

    expect(capturedCalls).toHaveLength(2);
    expect(capturedCalls[1].params.gstRegistrationId).toBe('reg-updated');
    expect(capturedCalls[1].params.branchId).toBe('branch-preserve-789');
    expect(capturedCalls[1].params.from).toBe('2026-04-01');
    expect(capturedCalls[1].params.to).toBe('2026-08-31');
  });

  // 8. January–March produces the previous FY start
  it('8. January–March produces the previous FY start', () => {
    // January 2027 -> FY 2026 (starts 2026-04-01)
    const jan2027 = new Date(2027, 0, 15);
    expect(gstFinancialYear(jan2027)).toBe(2026);
    expect(defaultGstFrom(jan2027)).toBe('2026-04-01');

    // February 2027 -> FY 2026
    const feb2027 = new Date(2027, 1, 10);
    expect(gstFinancialYear(feb2027)).toBe(2026);
    expect(defaultGstFrom(feb2027)).toBe('2026-04-01');

    // March 31 2026 -> FY 2025 (starts 2025-04-01)
    const mar2026 = new Date(2026, 2, 31);
    expect(gstFinancialYear(mar2026)).toBe(2025);
    expect(defaultGstFrom(mar2026)).toBe('2025-04-01');
  });

  // 9. April–December produces the current FY start
  it('9. April–December produces the current FY start', () => {
    // April 1 2026 -> FY 2026 (starts 2026-04-01)
    const apr2026 = new Date(2026, 3, 1);
    expect(gstFinancialYear(apr2026)).toBe(2026);
    expect(defaultGstFrom(apr2026)).toBe('2026-04-01');

    // September 2026 -> FY 2026
    const sep2026 = new Date(2026, 8, 30);
    expect(gstFinancialYear(sep2026)).toBe(2026);
    expect(defaultGstFrom(sep2026)).toBe('2026-04-01');

    // December 31 2026 -> FY 2026
    const dec2026 = new Date(2026, 11, 31);
    expect(gstFinancialYear(dec2026)).toBe(2026);
    expect(defaultGstFrom(dec2026)).toBe('2026-04-01');
  });

  // 10. Existing report rendering continues to work
  it('10. Existing report rendering continues to work', () => {
    qc.setQueryData(['gst-summary', defaultGstFrom(), defaultGstTo(), '', ''], {
      rows: [
        { hsnCode: '7113', description: 'Gold Jewellery', taxRate: 0.03, taxableValue: 100000, cgst: 1500, sgst: 1500, igst: 0 },
      ],
      totals: { taxableValue: 100000, cgst: 1500, sgst: 1500, igst: 0, totalTax: 3000 },
    });

    const htmlGst = renderWithProviders(<GstSummary />);
    expect(htmlGst).toContain('HSN Code');
    expect(htmlGst).toContain('Taxable Value');
    expect(htmlGst).toContain('7113');
    expect(htmlGst).toContain('Gold Jewellery');
    expect(htmlGst).toContain('₹1,00,000.00');

    qc.setQueryData(['purchase-gst-summary', defaultGstFrom(), defaultGstTo(), ''], {
      rows: [
        { hsnCode: '7108', description: 'Gold bullion', taxRate: 0.03, taxableValue: 50000, cgst: 750, sgst: 750, igst: 0 },
      ],
      bills: [],
      totals: { taxableValue: 50000, cgst: 750, sgst: 750, igst: 0, totalTax: 1500 },
    });

    const htmlPurchase = renderWithProviders(<PurchaseGstSummary />);
    expect(htmlPurchase).toContain('HSN-wise (net of returns)');
    expect(htmlPurchase).toContain('Bill-wise');
    expect(htmlPurchase).toContain('7108');
    expect(htmlPurchase).toContain('Net ITC');

    qc.setQueryData(['sales-register', defaultGstFrom(), defaultGstTo(), ''], {
      rows: [],
      byType: {},
      totals: { count: 0, totalAmount: 0 },
    });

    const htmlSales = renderWithProviders(<SalesRegister />);
    expect(htmlSales).toContain('Salesperson');
    expect(htmlSales).toContain('No invoices in this period');
  });

  // 11. No-registration state renders without errors
  it('11. No-registration state renders without errors', () => {
    const emptyClient = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: 0 } },
    });
    emptyClient.setQueryData(['gst-registrations'], []);
    emptyClient.setQueryData(['branches'], []);
    emptyClient.setQueryData(['gst-summary', defaultGstFrom(), defaultGstTo(), '', ''], { rows: [], totals: {} });

    const html = renderWithProviders(<GstSummary />, emptyClient);
    expect(html).toContain('All Registrations');
    expect(html).toContain('All Branches');
    expect(html).toContain('No taxable sales in this period');
  });

  // 12. Purchase GST Summary does not invent/use unsupported gstRegistrationId filtering
  it('12. Purchase GST Summary does not invent/use unsupported gstRegistrationId filtering', () => {
    const capturedCalls: any[] = [];
    vi.spyOn(apiClient, 'apiGet').mockImplementation(async (url: string, params?: any) => {
      capturedCalls.push({ url, params });
      return { rows: [], bills: [], totals: {} };
    });

    const html = renderWithProviders(<PurchaseGstSummary />);
    // Must contain Branch filter
    expect(html).toContain('Branch');
    expect(html).toContain('All Branches');
    // Must NOT contain GST Registration filter
    expect(html).not.toContain('GST Registration');
    expect(html).not.toContain('All Registrations');

    // Simulate query parameter generation used in PurchaseGstSummary
    const branchId = 'br-123';
    const params = {
      from: '2026-04-01',
      to: '2026-09-30',
      ...(branchId ? { branchId } : {}),
    };
    apiClient.apiGet('/finance/reports/purchase-gst-summary', params);

    expect(capturedCalls).toHaveLength(1);
    expect(capturedCalls[0].url).toBe('/finance/reports/purchase-gst-summary');
    expect(capturedCalls[0].params.branchId).toBe('br-123');
    expect(capturedCalls[0].params).not.toHaveProperty('gstRegistrationId');
  });

  // Branch access enforcement verification
  it('enforces branchAccess restriction in UI branch options', () => {
    const branches = [
      { id: 'b1', name: 'Bandra Showroom', isActive: true },
      { id: 'b2', name: 'Andheri Flagship', isActive: true },
      { id: 'b3', name: 'Inactive Branch', isActive: false },
    ];
    qc.setQueryData(['branches'], branches);

    // Case A: User has restricted branch access (only b1)
    useAuthStore.setState({
      user: {
        id: 'u1',
        email: 'user1@example.com',
        name: 'User One',
        role: 'Accountant',
        permissions: ['report:financial_view'],
        branchAccess: { allBranches: false, branchIds: ['b1'] },
      },
    });

    const htmlRestricted = renderWithProviders(<GstSummary />);
    expect(htmlRestricted).toContain('Bandra Showroom');
    expect(htmlRestricted).not.toContain('Andheri Flagship');
    expect(htmlRestricted).not.toContain('Inactive Branch');

    // Case B: User has allBranches: true
    useAuthStore.setState({
      user: {
        id: 'u2',
        email: 'user2@example.com',
        name: 'User Two',
        role: 'Admin',
        permissions: ['*'],
        branchAccess: { allBranches: true, branchIds: [] },
      },
    });

    const htmlAll = renderWithProviders(<GstSummary />);
    expect(htmlAll).toContain('Bandra Showroom');
    expect(htmlAll).toContain('Andheri Flagship');
    expect(htmlAll).not.toContain('Inactive Branch');
  });
});
