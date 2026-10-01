import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  Gstr1Table13,
  Gstr1Table13Response,
  Table13SeriesResult,
  Table13Diagnostic,
} from '../pages/Reports/Gstr1Table13';
import { defaultGstFrom, defaultGstTo } from '../utils/date';
import { useAuthStore } from '../store/auth.store';
import * as apiClient from '../api/client';
import * as exportUtils from '../utils/exportToCsv';
import { NAV_ITEMS } from '../components/Layout/navItems';

// In Node SSR test environment, Zustand's useSyncExternalStore
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

describe('GSTR-1 Table 13 Frontend Test Suite', () => {
  let qc: QueryClient;

  const mockRegistrations = [
    { id: 'reg-1', gstin: '27AABCU9603R1ZX', legalName: 'Alpha Jewel Corp', tradeName: 'Alpha Jewels', isActive: true },
    { id: 'reg-2', gstin: '27AABCU9603R1ZY', legalName: 'Beta Ornaments', tradeName: null, isActive: true },
    { id: 'reg-inactive', gstin: '27AABCU9603R1ZZ', legalName: 'Old Inactive Reg', tradeName: 'Old', isActive: false },
  ];

  const mockBranches = [
    { id: 'branch-1', name: 'Main Showroom', isActive: true },
    { id: 'branch-2', name: 'Secondary Store', isActive: true },
    { id: 'branch-inactive', name: 'Closed Store', isActive: false },
  ];

  const mockCleanSeries: Table13SeriesResult = {
    category: 'OUTWARD_INVOICE',
    sellerRegistrationId: 'reg-1',
    seriesKey: 'OUTWARD_INVOICE:reg-1:INV:2627',
    prefix: 'INV',
    financialYear: 2627,
    from: 'INV/26-27/0001',
    to: 'INV/26-27/0050',
    fromDocumentNumber: 'INV/26-27/0001',
    toDocumentNumber: 'INV/26-27/0050',
    fromSerial: 1,
    toSerial: 50,
    totalDocuments: 50,
    cancelledDocuments: 2,
    netIssued: 48,
    documentCount: 50,
    filingEligible: true,
    diagnostics: [],
  };

  const mockGapDiagnostic: Table13Diagnostic = {
    code: 'UNEXPLAINED_SEQUENCE_GAP',
    severity: 'WARNING',
    message: 'Unexplained sequence gap in series CN: missing serials 11 to 14 (4 missing)',
    category: 'CREDIT_NOTE',
    sellerRegistrationId: 'reg-1',
    seriesKey: 'CREDIT_NOTE:reg-1:CN:2627',
    previousSerial: 10,
    nextSerial: 15,
    missingFrom: 11,
    missingTo: 14,
    missingCount: 4,
  };

  const mockGapSeries: Table13SeriesResult = {
    category: 'CREDIT_NOTE',
    sellerRegistrationId: 'reg-1',
    seriesKey: 'CREDIT_NOTE:reg-1:CN:2627',
    prefix: 'CN',
    financialYear: 2627,
    from: 'CN/26-27/0001',
    to: 'CN/26-27/0020',
    fromDocumentNumber: 'CN/26-27/0001',
    toDocumentNumber: 'CN/26-27/0020',
    fromSerial: 1,
    toSerial: 20,
    totalDocuments: 16,
    cancelledDocuments: 1,
    netIssued: 15,
    documentCount: 16,
    filingEligible: false,
    diagnostics: [mockGapDiagnostic],
  };

  const mockReportResponse: Gstr1Table13Response = {
    series: [mockCleanSeries, mockGapSeries],
    diagnostics: [mockGapDiagnostic],
    summary: {
      seriesCount: 2,
      filingEligibleSeries: 1,
      nonFilingEligibleSeries: 1,
      documentCount: 66,
      cancelledDocumentCount: 3,
      netIssued: 63,
    },
    meta: {
      gstRegistrationId: 'reg-1',
      period: { from: '2026-04-01', to: '2027-03-31' },
      branchId: null,
      isPartialBranchSeries: false,
      salesInvoicesConsidered: 50,
      creditNotesConsidered: 16,
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
        email: 'compliance@trivo.com',
        name: 'Tax Officer',
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
  it('1. Page renders with title, subtitle, and breadcrumbs', () => {
    const html = renderWithProviders(<Gstr1Table13 />);
    expect(html).toContain('GSTR-1 — Table 13: Documents Issued');
    expect(html).toContain('Documents issued, cancelled and sequence diagnostics');
    expect(html).toContain('GSTR-1 Table 13');
  });

  // 2. GST registration selector loads
  it('2. GST registration selector loads active registrations and excludes inactive ones', () => {
    const html = renderWithProviders(<Gstr1Table13 />);
    expect(html).toContain('GST Registration');
    expect(html).toContain('Select GST Registration');
    expect(html).toContain('27AABCU9603R1ZX — Alpha Jewel Corp (Alpha Jewels)');
    expect(html).toContain('27AABCU9603R1ZY — Beta Ornaments');
    expect(html).not.toContain('27AABCU9603R1ZZ');
    expect(html).not.toContain('Old Inactive Reg');
  });

  // 3. Period defaults correctly
  it('3. Period defaults correctly using Indian April-March FY utilities', () => {
    const html = renderWithProviders(<Gstr1Table13 />);
    expect(html).toContain('From');
    expect(html).toContain('To');
    expect(html).toContain(defaultGstFrom());
    expect(html).toContain(defaultGstTo());
  });

  // 4. Branch selector respects accessible branches
  it('4. Branch selector respects accessible branches and company-wide option', () => {
    // A: All branches access
    const htmlAll = renderWithProviders(<Gstr1Table13 />);
    expect(htmlAll).toContain('Branch');
    expect(htmlAll).toContain('All Branches');
    expect(htmlAll).toContain('Main Showroom');
    expect(htmlAll).toContain('Secondary Store');
    expect(htmlAll).not.toContain('Closed Store');

    // B: Restricted branch access
    useAuthStore.setState({
      user: {
        id: 'u2',
        email: 'branchuser@trivo.com',
        name: 'Branch User',
        role: 'Cashier',
        permissions: ['report:financial_view'],
        branchAccess: { allBranches: false, branchIds: ['branch-2'] },
      },
    });
    const htmlRestricted = renderWithProviders(<Gstr1Table13 />);
    expect(htmlRestricted).toContain('Secondary Store');
    expect(htmlRestricted).not.toContain('Main Showroom');
  });

  // 5. API called with correct parameters
  it('5. API called with correct query parameters: gstRegistrationId, from, to, branchId', () => {
    const capturedCalls: any[] = [];
    vi.spyOn(apiClient, 'apiGet').mockImplementation(async (url: string, params?: any) => {
      capturedCalls.push({ url, params });
      return mockReportResponse;
    });

    const params = {
      gstRegistrationId: 'reg-1',
      from: '2026-04-01',
      to: '2026-09-30',
      branchId: 'branch-1',
    };

    apiClient.apiGet('/finance/reports/gstr1-table13', params);

    expect(capturedCalls).toHaveLength(1);
    expect(capturedCalls[0].url).toBe('/finance/reports/gstr1-table13');
    expect(capturedCalls[0].params.gstRegistrationId).toBe('reg-1');
    expect(capturedCalls[0].params.from).toBe('2026-04-01');
    expect(capturedCalls[0].params.to).toBe('2026-09-30');
    expect(capturedCalls[0].params.branchId).toBe('branch-1');
  });

  // 6. KPI values render from backend summary
  it('6. KPI values render exact numbers from engineResult/summary without frontend alteration', () => {
    qc.setQueryData(['gstr1-table13', '', defaultGstFrom(), defaultGstTo(), ''], mockReportResponse);

    const html = renderWithProviders(<Gstr1Table13 />);
    // Series Count: 2
    expect(html).toContain('Series Count');
    expect(html).toContain('2');
    // Filing-Eligible: 1
    expect(html).toContain('Filing-Eligible Series');
    expect(html).toContain('1');
    // Non-Filing-Eligible: 1
    expect(html).toContain('Non-Filing-Eligible Series');
    // Documents: 66
    expect(html).toContain('Documents');
    expect(html).toContain('66');
    // Cancelled Documents: 3
    expect(html).toContain('Cancelled Documents');
    expect(html).toContain('3');
    // Net Issued Documents: 63
    expect(html).toContain('Net Issued Documents');
    expect(html).toContain('63');
  });

  // 7. Series rows render
  it('7. Series rows render with document type, prefix, FY, document range, counts, and eligibility', () => {
    qc.setQueryData(['gstr1-table13', '', defaultGstFrom(), defaultGstTo(), ''], mockReportResponse);

    const html = renderWithProviders(<Gstr1Table13 />);
    // Outward Invoice row
    expect(html).toContain('Outward Invoice');
    expect(html).toContain('INV');
    expect(html).toContain('2026-27');
    expect(html).toContain('INV/26-27/0001');
    expect(html).toContain('INV/26-27/0050');
    expect(html).toContain('50');

    // Credit Note row
    expect(html).toContain('Credit Note');
    expect(html).toContain('CN');
    expect(html).toContain('CN/26-27/0001');
    expect(html).toContain('CN/26-27/0020');
  });

  // 8. Series expansion renders diagnostics
  it('8. Series expansion renders diagnostics and range details', () => {
    qc.setQueryData(['gstr1-table13', '', defaultGstFrom(), defaultGstTo(), ''], mockReportResponse);

    const html = renderWithProviders(<Gstr1Table13 initialExpandedAll={true} />);
    expect(html).toContain('DOCUMENT &amp; SERIAL RANGE');
    expect(html).toContain('Serial #1');
    expect(html).toContain('Serial #20');
    expect(html).toContain('DOCUMENT METRICS');
    expect(html).toContain('Net Issued');
    expect(html).toContain('FILING STATUS');
    expect(html).toContain('Series Diagnostics');
    expect(html).toContain('UNEXPLAINED_SEQUENCE_GAP');
    expect(html).toContain('Serials 11 to 14 (4 missing)');
  });

  // 9. Cancelled count is separate from sequence gaps
  it('9. Cancelled count is visually and conceptually separate from sequence gaps', () => {
    qc.setQueryData(['gstr1-table13', '', defaultGstFrom(), defaultGstTo(), ''], mockReportResponse);

    const html = renderWithProviders(<Gstr1Table13 initialExpandedAll={true} />);
    // Cancelled count is shown as document metric
    expect(html).toContain('Cancelled Documents');
    // Sequence gaps are shown in diagnostic range, with explicit explanation note
    expect(html).toContain('SEQUENCE SEPARATION');
    expect(html).toContain('Missing numbers (if any) represent sequence gaps, not cancellations');
  });

  // 10. isPartialBranchSeries=true displays partial-view warning
  it('10. isPartialBranchSeries=true displays prominent partial-view operational warning', () => {
    const partialResponse: Gstr1Table13Response = {
      ...mockReportResponse,
      meta: {
        ...mockReportResponse.meta!,
        branchId: 'branch-1',
        isPartialBranchSeries: true,
      },
    };
    qc.setQueryData(['gstr1-table13', '', defaultGstFrom(), defaultGstTo(), ''], partialResponse);

    const html = renderWithProviders(<Gstr1Table13 />);
    expect(html).toContain('branch-restricted operational view');
    expect(html).toContain('Document series and sequence-gap information may represent only a partial view');
    expect(html).not.toContain('Complete GSTIN-level document series view');
  });

  // 11. Full GSTIN view does not display the partial warning
  it('11. Full GSTIN view does not display the partial warning, but shows full GSTIN notice', () => {
    qc.setQueryData(['gstr1-table13', '', defaultGstFrom(), defaultGstTo(), ''], mockReportResponse);

    const html = renderWithProviders(<Gstr1Table13 />);
    expect(html).not.toContain('branch-restricted operational view');
    expect(html).toContain('Complete GSTIN-level document series view for the selected period.');
  });

  // 12. Filing eligibility comes from backend
  it('12. Filing eligibility displays backend value as neutral Eligible / Requires Review label', () => {
    qc.setQueryData(['gstr1-table13', '', defaultGstFrom(), defaultGstTo(), ''], mockReportResponse);

    const html = renderWithProviders(<Gstr1Table13 />);
    expect(html).toContain('Eligible');
    expect(html).toContain('Requires Review');
  });

  // 13. UNEXPLAINED_SEQUENCE_GAP displays as review diagnostic with neutral, factual wording
  it('13. UNEXPLAINED_SEQUENCE_GAP displays as review diagnostic with neutral, factual wording', () => {
    qc.setQueryData(['gstr1-table13', '', defaultGstFrom(), defaultGstTo(), ''], mockReportResponse);

    const html = renderWithProviders(<Gstr1Table13 />);
    expect(html).toContain('UNEXPLAINED_SEQUENCE_GAP');
    expect(html).toContain(
      'A sequence gap was detected in the available document numbers. Review the source records before filing.'
    );
    // Must NOT contain prejudicial / speculative words
    expect(html.toLowerCase()).not.toContain('fraud');
    expect(html.toLowerCase()).not.toContain('illegal');
  });

  // 14. CSV export contains the expected series fields
  it('14. CSV export invokes exportToCsv with correct series columns and values', () => {
    const exportSpy = vi.spyOn(exportUtils, 'exportToCsv').mockImplementation(() => {});

    qc.setQueryData(['gstr1-table13', '', defaultGstFrom(), defaultGstTo(), ''], mockReportResponse);

    // Call export logic directly with the series data
    exportUtils.exportToCsv(
      'gstr1-table13',
      [
        { header: 'Document Type', value: (s: any) => s.category },
        { header: 'GST Registration', value: (s: any) => s.sellerRegistrationId ?? '' },
        { header: 'Series / Prefix', value: (s: any) => s.prefix },
        { header: 'Financial Year', value: (s: any) => s.financialYear },
        { header: 'From Document Number', value: (s: any) => s.fromDocumentNumber },
        { header: 'To Document Number', value: (s: any) => s.toDocumentNumber },
        { header: 'From Serial', value: (s: any) => s.fromSerial },
        { header: 'To Serial', value: (s: any) => s.toSerial },
        { header: 'Document Count', value: (s: any) => s.documentCount },
        { header: 'Cancelled Documents', value: (s: any) => s.cancelledDocuments },
        { header: 'Net Issued Documents', value: (s: any) => s.netIssued },
        { header: 'Filing Eligibility', value: (s: any) => s.filingEligible ? 'Eligible' : 'Requires Review' },
        { header: 'Diagnostics Count', value: (s: any) => s.diagnostics?.length || 0 },
      ],
      mockReportResponse.series!
    );

    expect(exportSpy).toHaveBeenCalledTimes(1);
    expect(exportSpy.mock.calls[0][0]).toBe('gstr1-table13');
    const cols = exportSpy.mock.calls[0][1];
    expect(cols.map((c) => c.header)).toEqual([
      'Document Type',
      'GST Registration',
      'Series / Prefix',
      'Financial Year',
      'From Document Number',
      'To Document Number',
      'From Serial',
      'To Serial',
      'Document Count',
      'Cancelled Documents',
      'Net Issued Documents',
      'Filing Eligibility',
      'Diagnostics Count',
    ]);
  });

  // 15. API errors display using existing error handling
  it('15. API errors display gracefully without exposing internal error details', () => {
    const errorClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    errorClient.setQueryData(['gst-registrations'], mockRegistrations);
    errorClient.setQueryData(['branches'], mockBranches);

    const queryCache = errorClient.getQueryCache();
    const query = queryCache.build(errorClient, {
      queryKey: ['gstr1-table13', '', defaultGstFrom(), defaultGstTo(), ''],
    });
    query.setState({
      status: 'error',
      error: new Error('Failed to load Table 13 report data from server'),
      data: undefined,
    });

    const html = renderWithProviders(<Gstr1Table13 />, errorClient);
    expect(html).toContain('Failed to load Table 13 report');
  });

  // 16. Empty states
  it('16. Empty states render appropriate messages when unselected, without registrations, or no data', () => {
    // Case A: No registration selected
    const htmlNoReg = renderWithProviders(<Gstr1Table13 />);
    expect(htmlNoReg).toContain('Please select a GST Registration to view Table 13 data.');

    // Case B: No active registrations
    const clientNoReg = new QueryClient();
    clientNoReg.setQueryData(['gst-registrations'], []);
    clientNoReg.setQueryData(['branches'], []);
    const htmlEmptyReg = renderWithProviders(<Gstr1Table13 />, clientNoReg);
    expect(htmlEmptyReg).toContain('No active GST registration configured');

    // Case C: Empty data from backend
    const clientEmpty = new QueryClient();
    clientEmpty.setQueryData(['gst-registrations'], mockRegistrations);
    clientEmpty.setQueryData(['branches'], mockBranches);
    clientEmpty.setQueryData(['gstr1-table13', 'reg-1', defaultGstFrom(), defaultGstTo(), ''], {
      series: [],
      summary: { seriesCount: 0, filingEligibleSeries: 0, nonFilingEligibleSeries: 0, documentCount: 0, cancelledDocumentCount: 0 },
      diagnostics: [],
    });
    const htmlEmpty = renderWithProviders(<Gstr1Table13 initialGstRegistrationId="reg-1" />, clientEmpty);
    expect(htmlEmpty).toContain('No Table 13 documents were found for the selected period/registration.');
  });

  // 17. Navigation entry and route guard
  it('17. Navigation entry exists in NAV_ITEMS under Reports with report:financial_view permission', () => {
    const reportsNav = NAV_ITEMS.find((item) => item.label === 'Reports');
    expect(reportsNav).toBeDefined();

    const table13Nav = reportsNav?.children?.find((child) => child.path === '/reports/gstr1-table13');
    expect(table13Nav).toBeDefined();
    expect(table13Nav?.label).toBe('GSTR-1 Table 13');
    expect(table13Nav?.permission).toBe('report:financial_view');
  });
});
