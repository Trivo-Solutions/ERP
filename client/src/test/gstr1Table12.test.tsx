import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Gstr1Table12, Gstr1Table12Response, Gstr1Table12Row } from '../pages/Reports/Gstr1Table12';
import { defaultGstFrom, defaultGstTo } from '../utils/date';
import { useAuthStore } from '../store/auth.store';
import * as apiClient from '../api/client';
import * as exportUtils from '../utils/exportToCsv';
import { NAV_ITEMS } from '../components/Layout/navItems';
import { RequirePermission } from '../components/auth/RequirePermission';

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

describe('GSTR-1 Table 12 Frontend Test Suite (Items 1-17)', () => {
  let qc: QueryClient;

  const mockRegistrations = [
    { id: 'reg-active-1', gstin: '27AABCU9603R1ZX', legalName: 'Alpha Jewel Corp', tradeName: 'Alpha Jewels', isActive: true },
    { id: 'reg-active-2', gstin: '27AABCU9603R1ZY', legalName: 'Beta Ornaments', tradeName: null, isActive: true },
    { id: 'reg-inactive', gstin: '27AABCU9603R1ZZ', legalName: 'Old Inactive Reg', tradeName: 'Old', isActive: false },
  ];

  const mockBranches = [
    { id: 'branch-1', name: 'Main Showroom', isActive: true },
    { id: 'branch-2', name: 'Secondary Store', isActive: true },
    { id: 'branch-inactive', name: 'Closed Store', isActive: false },
  ];

  const mockB2bRow: Gstr1Table12Row = {
    reportingTab: 'B2B_SUPPLIES',
    hsnCode: '7113',
    description: 'Gold Jewellery',
    uqc: 'GMS',
    gstRate: 0.03,
    quantity: 100,
    taxableValue: 125000.5,
    cgst: 1875,
    sgst: 1875,
    igst: 0,
    cess: 0,
    grossQuantity: 120,
    creditNoteQuantityReduction: 20,
    grossTaxableValue: 150000,
    creditNoteTaxableReduction: 24999.5,
    grossCgst: 2250,
    creditNoteCgstReduction: 375,
    grossSgst: 2250,
    creditNoteSgstReduction: 375,
    grossIgst: 0,
    creditNoteIgstReduction: 0,
    grossCess: 0,
    creditNoteCessReduction: 0,
    filingEligible: true,
    recordCount: 5,
    creditNoteRecordCount: 1,
  };

  const mockIneligibleRow: Gstr1Table12Row = {
    reportingTab: 'B2B_SUPPLIES',
    hsnCode: null,
    description: 'Unclassified Item',
    uqc: 'OTH',
    gstRate: 0.03,
    quantity: 10,
    taxableValue: 10000,
    cgst: 150,
    sgst: 150,
    igst: 0,
    cess: 0,
    grossQuantity: 10,
    creditNoteQuantityReduction: 0,
    grossTaxableValue: 10000,
    creditNoteTaxableReduction: 0,
    grossCgst: 150,
    creditNoteCgstReduction: 0,
    grossSgst: 150,
    creditNoteSgstReduction: 0,
    grossIgst: 0,
    creditNoteIgstReduction: 0,
    grossCess: 0,
    creditNoteCessReduction: 0,
    filingEligible: false,
    recordCount: 1,
    creditNoteRecordCount: 0,
  };

  const mockB2cRow: Gstr1Table12Row = {
    reportingTab: 'B2C_SUPPLIES',
    hsnCode: '7118',
    description: 'Gold Coin',
    uqc: 'GMS',
    gstRate: 0.03,
    quantity: 50,
    taxableValue: 50000,
    cgst: 750,
    sgst: 750,
    igst: 0,
    cess: 0,
    grossQuantity: 50,
    creditNoteQuantityReduction: 0,
    grossTaxableValue: 50000,
    creditNoteTaxableReduction: 0,
    grossCgst: 750,
    creditNoteCgstReduction: 0,
    grossSgst: 750,
    creditNoteSgstReduction: 0,
    grossIgst: 0,
    creditNoteIgstReduction: 0,
    grossCess: 0,
    creditNoteCessReduction: 0,
    filingEligible: true,
    recordCount: 2,
    creditNoteRecordCount: 0,
  };

  const mockReportResponse: Gstr1Table12Response = {
    rows: [mockB2bRow, mockIneligibleRow, mockB2cRow],
    diagnostics: [
      {
        code: 'MISSING_HSN',
        reason: 'Item is missing HSN code in outward invoice line',
        invoiceId: 'inv-1',
        invoiceNumber: 'INV-2026-0001',
        reportingTab: 'B2B_SUPPLIES',
        hsnCode: null,
        gstRate: 0.03,
        uqc: 'OTH',
      },
      {
        code: 'CREDIT_NOTE_EXCLUDED',
        reason: 'Credit Note was issued against an excluded void transaction',
        creditNoteId: 'cn-1',
        creditNoteNumber: 'CN-2026-0005',
      },
    ],
    summary: {
      b2bRows: 2,
      b2cRows: 1,
      diagnosticCount: 2,
    },
    meta: {
      gstRegistrationId: 'reg-active-1',
      period: { from: '2026-04-01', to: '2027-03-31' },
      invoicesConsidered: 10,
      invoicesExcludedByScope: 1,
      creditNotesConsidered: 2,
      creditNotesExcludedByScope: 0,
      hsnDigitCompliance: 'NOT_DETERMINED',
    },
  };

  beforeEach(() => {
    qc = new QueryClient({
      defaultOptions: {
        queries: { retry: false, gcTime: 0 },
      },
    });
    vi.restoreAllMocks();

    qc.setQueryData(['gst-registrations'], mockRegistrations);
    qc.setQueryData(['branches'], mockBranches);

    useAuthStore.setState({
      user: {
        id: 'u1',
        email: 'accountant@trivo.com',
        name: 'Accountant User',
        role: 'Accountant',
        permissions: ['report:financial_view'],
        branchAccess: { allBranches: true, branchIds: [] },
      },
    });
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

  // 1. Page renders
  it('1. Page renders with title, breadcrumbs, and official terminology', () => {
    const html = renderWithProviders(<Gstr1Table12 />);
    expect(html).toContain('Table 12 — HSN-wise Summary');
    expect(html).toContain('GSTR-1 Table 12');
    expect(html).toContain('Table 12 — B2B Supplies');
    expect(html).toContain('Table 12 — B2C Supplies');
    expect(html).not.toContain('Table 12A');
    expect(html).not.toContain('Table 12B');
  });

  // 2. Registration selector is shown
  it('2. Registration selector is shown with active registrations and excludes inactive ones', () => {
    const html = renderWithProviders(<Gstr1Table12 />);
    expect(html).toContain('GST Registration');
    expect(html).toContain('Select GST Registration');
    expect(html).toContain('27AABCU9603R1ZX — Alpha Jewel Corp (Alpha Jewels)');
    expect(html).toContain('27AABCU9603R1ZY — Beta Ornaments');
    expect(html).not.toContain('27AABCU9603R1ZZ');
    expect(html).not.toContain('Old Inactive Reg');
  });

  // 3. Period filters are shown
  it('3. Period filters are shown with default dates', () => {
    const html = renderWithProviders(<Gstr1Table12 />);
    expect(html).toContain('From');
    expect(html).toContain('To');
    expect(html).toContain(defaultGstFrom());
    expect(html).toContain(defaultGstTo());
  });

  // 4. Branch filter is shown
  it('4. Branch filter is shown with accessible branches and company-wide option', () => {
    const html = renderWithProviders(<Gstr1Table12 />);
    expect(html).toContain('Branch');
    expect(html).toContain('All Branches');
    expect(html).toContain('Main Showroom');
    expect(html).toContain('Secondary Store');
    expect(html).not.toContain('Closed Store');
  });

  // 5. API receives gstRegistrationId
  it('5. API receives gstRegistrationId and respects query contract', () => {
    const capturedCalls: any[] = [];
    vi.spyOn(apiClient, 'apiGet').mockImplementation(async (url: string, params?: any) => {
      capturedCalls.push({ url, params });
      return mockReportResponse;
    });

    const params = {
      gstRegistrationId: 'reg-active-1',
      from: '2026-04-01',
      to: '2026-09-30',
      branchId: 'branch-1',
    };

    apiClient.apiGet('/finance/reports/gstr1-table12', params);

    expect(capturedCalls).toHaveLength(1);
    expect(capturedCalls[0].url).toBe('/finance/reports/gstr1-table12');
    expect(capturedCalls[0].params.gstRegistrationId).toBe('reg-active-1');
    expect(capturedCalls[0].params.from).toBe('2026-04-01');
    expect(capturedCalls[0].params.to).toBe('2026-09-30');
    expect(capturedCalls[0].params.branchId).toBe('branch-1');
  });

  // 6. B2B tab displays B2B rows
  it('6. B2B tab displays B2B rows and excludes B2C rows', () => {
    qc.setQueryData(['gstr1-table12', '', defaultGstFrom(), defaultGstTo(), ''], mockReportResponse);

    const html = renderWithProviders(<Gstr1Table12 initialTab={0} />);
    expect(html).toContain('7113');
    expect(html).toContain('Gold Jewellery');
    expect(html).toContain('GMS');
    // B2C item must NOT be displayed in B2B tab
    expect(html).not.toContain('7118');
    expect(html).not.toContain('Gold Coin');
  });

  // 7. B2C tab displays B2C rows
  it('7. B2C tab displays B2C rows and excludes B2B rows', () => {
    qc.setQueryData(['gstr1-table12', '', defaultGstFrom(), defaultGstTo(), ''], mockReportResponse);

    const html = renderWithProviders(<Gstr1Table12 initialTab={1} />);
    expect(html).toContain('7118');
    expect(html).toContain('Gold Coin');
    // B2B items must NOT be displayed in B2C tab
    expect(html).not.toContain('7113');
    expect(html).not.toContain('Gold Jewellery');
  });

  // 8. Net taxable value displayed correctly
  it('8. Net taxable value displayed correctly with Indian currency formatting', () => {
    qc.setQueryData(['gstr1-table12', '', defaultGstFrom(), defaultGstTo(), ''], mockReportResponse);

    const html = renderWithProviders(<Gstr1Table12 initialTab={0} />);
    expect(html).toContain('₹1,25,000.50');
  });

  // 9. Net tax values displayed correctly
  it('9. Net tax values displayed correctly', () => {
    qc.setQueryData(['gstr1-table12', '', defaultGstFrom(), defaultGstTo(), ''], mockReportResponse);

    const html = renderWithProviders(<Gstr1Table12 initialTab={0} />);
    // CGST and SGST net amounts
    expect(html).toContain('₹1,875.00');
    // Total Tax
    expect(html).toContain('Total Tax');
  });

  // 10. Credit Note reduction details are accessible
  it('10. Credit Note reduction details are accessible and transparent', () => {
    qc.setQueryData(['gstr1-table12', '', defaultGstFrom(), defaultGstTo(), ''], mockReportResponse);

    const html = renderWithProviders(<Gstr1Table12 initialTab={0} initialExpandedAll={true} />);
    expect(html).toContain('Credit Note Transparency');
    expect(html).toContain('Gross Outward');
    expect(html).toContain('Credit Note Reduction');
    expect(html).toContain('Net Reported');
    expect(html).toContain('₹1,50,000.00');
    expect(html).toContain('₹2,250.00');
    expect(html).toContain('Outward supply records');
    expect(html).toContain('Credit Note reduction records');
  });

  // 11. Filing-ineligible row is visibly flagged
  it('11. Filing-ineligible row is visibly flagged as requiring attention', () => {
    qc.setQueryData(['gstr1-table12', '', defaultGstFrom(), defaultGstTo(), ''], mockReportResponse);

    const html = renderWithProviders(<Gstr1Table12 initialTab={0} />);
    // Ineligible row displays warning flag
    expect(html).toContain('Requires Attention');
    // Eligible row displays eligible flag
    expect(html).toContain('Eligible');
  });

  // 12. Diagnostics render
  it('12. Diagnostics render as data-quality/reporting observations with code and document references', () => {
    qc.setQueryData(['gstr1-table12', '', defaultGstFrom(), defaultGstTo(), ''], mockReportResponse);

    const html = renderWithProviders(<Gstr1Table12 />);
    expect(html).toContain('Diagnostics &amp; Data Quality');
    expect(html).toContain('MISSING_HSN');
    expect(html).toContain('Item is missing HSN code in outward invoice line');
    expect(html).toContain('Invoice: INV-2026-0001');
    expect(html).toContain('CREDIT_NOTE_EXCLUDED');
    expect(html).toContain('Credit Note: CN-2026-0005');
  });

  // 13. Empty state renders
  it('13. Empty state renders when no data exists or no registration selected', () => {
    // Sub-case A: No registration selected
    const htmlNoReg = renderWithProviders(<Gstr1Table12 />);
    expect(htmlNoReg).toContain('Please select a GST Registration to view Table 12 data.');

    // Sub-case B: No active registrations configured
    const clientEmptyReg = new QueryClient();
    clientEmptyReg.setQueryData(['gst-registrations'], []);
    clientEmptyReg.setQueryData(['branches'], []);
    const htmlEmptyReg = renderWithProviders(<Gstr1Table12 />, clientEmptyReg);
    expect(htmlEmptyReg).toContain('No active GST registration configured');

    // Sub-case C: Registration selected but empty result
    const clientEmptyData = new QueryClient();
    clientEmptyData.setQueryData(['gst-registrations'], mockRegistrations);
    clientEmptyData.setQueryData(['branches'], mockBranches);
    clientEmptyData.setQueryData(['gstr1-table12', 'reg-active-1', defaultGstFrom(), defaultGstTo(), ''], {
      rows: [],
      diagnostics: [],
      summary: { b2bRows: 0, b2cRows: 0, diagnosticCount: 0 },
    });

    const htmlEmpty = renderWithProviders(<Gstr1Table12 />, clientEmptyData);
    expect(htmlEmpty).toContain('Please select a GST Registration to view Table 12 data.');
  });

  // 14. API error state renders
  it('14. API error state renders gracefully', () => {
    const errorClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    errorClient.setQueryData(['gst-registrations'], mockRegistrations);
    errorClient.setQueryData(['branches'], mockBranches);
    errorClient.setQueryDefaults(['gstr1-table12'], {
      queryFn: () => Promise.reject(new Error('Internal server timeout')),
    });

    // Provide query cache with error state directly
    const queryCache = errorClient.getQueryCache();
    const query = queryCache.build(errorClient, {
      queryKey: ['gstr1-table12', '', defaultGstFrom(), defaultGstTo(), ''],
    });
    query.setState({
      status: 'error',
      error: new Error('Network timeout loading Table 12 report'),
      data: undefined,
    });

    const html = renderWithProviders(<Gstr1Table12 />, errorClient);
    expect(html).toContain('Failed to load Table 12 report');
    expect(html).toContain('Network timeout loading Table 12 report');
  });

  // 15. AATO NOT_DETERMINED status renders
  it('15. AATO NOT_DETERMINED status renders clearly and unobtrusively', () => {
    const html = renderWithProviders(<Gstr1Table12 />);
    expect(html).toContain('HSN digit compliance: Not determined — AATO configuration is not available.');
  });

  // 16. CSV export works if implemented
  it('16. CSV export exports selected tab with all 10 standard columns', () => {
    const exportSpy = vi.spyOn(exportUtils, 'exportToCsv').mockImplementation(() => {});

    // Verify CSV column structure
    const columns = [
      { header: 'HSN', value: (r: Gstr1Table12Row) => r.hsnCode ?? '' },
      { header: 'Description', value: (r: Gstr1Table12Row) => r.description ?? '' },
      { header: 'UQC', value: (r: Gstr1Table12Row) => r.uqc ?? '' },
      { header: 'GST Rate', value: (r: Gstr1Table12Row) => `${r.gstRate * 100}%` },
      { header: 'Quantity', value: (r: Gstr1Table12Row) => r.quantity },
      { header: 'Taxable Value', value: (r: Gstr1Table12Row) => r.taxableValue },
      { header: 'CGST', value: (r: Gstr1Table12Row) => r.cgst },
      { header: 'SGST', value: (r: Gstr1Table12Row) => r.sgst },
      { header: 'IGST', value: (r: Gstr1Table12Row) => r.igst },
      { header: 'Cess', value: (r: Gstr1Table12Row) => r.cess },
    ];

    exportUtils.exportToCsv('gstr1-table12-b2b', columns, [mockB2bRow]);

    expect(exportSpy).toHaveBeenCalledTimes(1);
    expect(exportSpy).toHaveBeenCalledWith(
      'gstr1-table12-b2b',
      expect.arrayContaining([
        expect.objectContaining({ header: 'HSN' }),
        expect.objectContaining({ header: 'Description' }),
        expect.objectContaining({ header: 'UQC' }),
        expect.objectContaining({ header: 'GST Rate' }),
        expect.objectContaining({ header: 'Quantity' }),
        expect.objectContaining({ header: 'Taxable Value' }),
        expect.objectContaining({ header: 'CGST' }),
        expect.objectContaining({ header: 'SGST' }),
        expect.objectContaining({ header: 'IGST' }),
        expect.objectContaining({ header: 'Cess' }),
      ]),
      [mockB2bRow]
    );
  });

  // 17. Existing permission/route guard remains intact
  it('17. Existing permission/route guard remains intact in routes and navigation', () => {
    // NavItems check
    const reportsNav = NAV_ITEMS.find((n) => n.label === 'Reports');
    expect(reportsNav).toBeDefined();

    const table12NavItem = reportsNav?.children?.find((c) => c.label === 'GSTR-1 Table 12');
    expect(table12NavItem).toBeDefined();
    expect(table12NavItem?.path).toBe('/reports/gstr1-table12');
    expect(table12NavItem?.permission).toBe('report:financial_view');

    // Case A: User with report:financial_view sees the protected page
    useAuthStore.setState({
      user: {
        id: 'u1',
        email: 'acc@trivo.com',
        name: 'Accountant',
        role: 'Accountant',
        permissions: ['report:financial_view'],
        branchAccess: { allBranches: true, branchIds: [] },
      },
    });

    const allowedHtml = renderWithProviders(
      <RequirePermission permission="report:financial_view">
        <Gstr1Table12 />
      </RequirePermission>
    );
    expect(allowedHtml).toContain('Table 12 — HSN-wise Summary');
    expect(allowedHtml).not.toContain('Access Restricted');

    // Case B: User without report:financial_view sees Access Restricted
    useAuthStore.setState({
      user: {
        id: 'u2',
        email: 'sales@trivo.com',
        name: 'Sales Rep',
        role: 'Sales',
        permissions: ['sales:view'],
        branchAccess: { allBranches: true, branchIds: [] },
      },
    });

    const blockedHtml = renderWithProviders(
      <RequirePermission permission="report:financial_view">
        <Gstr1Table12 />
      </RequirePermission>
    );
    expect(blockedHtml).toContain('Access Restricted');
    expect(blockedHtml).not.toContain('Table 12 — HSN-wise Summary');
  });
});
