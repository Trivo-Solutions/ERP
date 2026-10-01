import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Gstr1, money, formatQty, formatRate } from '../pages/Reports/Gstr1';
import {
  exportTable4Csv,
  exportTable5Csv,
  exportTable7Csv,
  exportTable9bCsv,
} from '../utils/gstr1Csv';
import * as exportUtils from '../utils/exportToCsv';
import { NAV_ITEMS } from '../components/Layout/navItems';
import { defaultGstFrom, defaultGstTo } from '../utils/date';
import { useAuthStore } from '../store/auth.store';
import type {
  Gstr1OutwardResponse,
  Gstr1CreditNoteResponse,
  Gstr1B2bInvoiceRecord,
  Gstr1B2clInvoiceRecord,
  Gstr1B2csGroup,
  Gstr1CreditNoteReportDocument,
} from '../types/gstr1';

// Mock Zustand auth store for Node SSR test environment
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

describe('GSTR-1 Phase B Frontend Test Suite', () => {
  let qc: QueryClient;

  const mockRegistrations = [
    {
      id: 'reg-alpha-1',
      gstin: '27AABCU9603R1ZX',
      legalName: 'Alpha Jewels Pvt Ltd',
      tradeName: 'Alpha Ornaments',
      isActive: true,
      isPrimary: true,
    },
    {
      id: 'reg-beta-2',
      gstin: '24AABCU9603R1ZY',
      legalName: 'Beta Gems LLP',
      tradeName: null,
      isActive: true,
      isPrimary: false,
    },
    {
      id: 'reg-inactive',
      gstin: '29AABCU9603R1ZZ',
      legalName: 'Old Inactive Reg',
      tradeName: null,
      isActive: false,
      isPrimary: false,
    },
  ];

  const mockBranches = [
    { id: 'branch-1', name: 'Mumbai Showroom', isActive: true },
    { id: 'branch-2', name: 'Surat Workshop', isActive: true },
    { id: 'branch-inactive', name: 'Closed Branch', isActive: false },
  ];

  // Mock Table 4 (B2B)
  const mockB2bInvoice: Gstr1B2bInvoiceRecord = {
    category: 'B2B',
    invoiceId: 'inv-b2b-01',
    invoiceNumber: 'INV-2026-001',
    invoiceDate: '2026-06-15T00:00:00.000Z',
    buyerGstin: '27AABCU9603R1ZX',
    placeOfSupply: '27-Maharashtra',
    isInterState: false,
    reverseCharge: false,
    sellerRegistrationId: 'reg-alpha-1',
    invoiceValue: 118000,
    totals: {
      taxableValue: 100000,
      cgst: 9000,
      sgst: 9000,
      igst: 0,
      cess: 0,
    },
    lines: [
      {
        hsnCode: '7113',
        gstRate: 0.18,
        uqc: 'GMS',
        quantity: 50,
        taxableValue: 100000,
        cgst: 9000,
        sgst: 9000,
        igst: 0,
        cess: 0,
      },
    ],
  };

  // Mock Table 5 (B2CL)
  const mockB2clInvoice: Gstr1B2clInvoiceRecord = {
    category: 'B2CL',
    invoiceId: 'inv-b2cl-01',
    invoiceNumber: 'INV-2026-099',
    invoiceDate: '2026-07-20T00:00:00.000Z',
    placeOfSupply: '24-Gujarat',
    sellerRegistrationId: 'reg-alpha-1',
    invoiceValue: 350000,
    threshold: 250000,
    totals: {
      taxableValue: 300000,
      cgst: 0,
      sgst: 0,
      igst: 50000,
      cess: 0,
    },
    lines: [
      {
        hsnCode: '7113',
        gstRate: 0.18,
        uqc: 'GMS',
        quantity: 120,
        taxableValue: 300000,
        cgst: 0,
        sgst: 0,
        igst: 50000,
        cess: 0,
      },
    ],
  };

  // Mock Table 7 (B2CS) with Gross, CN Reduction, and Net
  const mockB2csGroupEligible: Gstr1B2csGroup = {
    placeOfSupply: '27-Maharashtra',
    isInterState: false,
    gstRate: 0.03,
    hsnCode: '7113',
    uqc: 'GMS',
    recordCount: 8,
    creditNoteRecordCount: 2,
    grossTaxableValue: 1000000,
    creditNoteTaxableReduction: 50000,
    taxableValue: 950000,
    grossCgst: 15000,
    creditNoteCgstReduction: 750,
    cgst: 14250,
    grossSgst: 15000,
    creditNoteSgstReduction: 750,
    sgst: 14250,
    grossIgst: 0,
    creditNoteIgstReduction: 0,
    igst: 0,
    grossCess: 0,
    creditNoteCessReduction: 0,
    cess: 0,
    grossQuantity: 200,
    creditNoteQuantityReduction: 10,
    quantity: 190,
    filingEligible: true,
  };

  // Mock Table 7 negative net bucket (must remain visible and flagged)
  const mockB2csGroupNegative: Gstr1B2csGroup = {
    placeOfSupply: '29-Karnataka',
    isInterState: true,
    gstRate: 0.18,
    hsnCode: '7118',
    uqc: 'PCS',
    recordCount: 1,
    creditNoteRecordCount: 3,
    grossTaxableValue: 20000,
    creditNoteTaxableReduction: 25000,
    taxableValue: -5000,
    grossIgst: 3600,
    creditNoteIgstReduction: 4500,
    igst: -900,
    grossCgst: 0,
    creditNoteCgstReduction: 0,
    cgst: 0,
    grossSgst: 0,
    creditNoteSgstReduction: 0,
    sgst: 0,
    grossCess: 0,
    creditNoteCessReduction: 0,
    cess: 0,
    grossQuantity: 2,
    creditNoteQuantityReduction: 3,
    quantity: -1,
    filingEligible: false,
  };

  const mockOutwardResponse: Gstr1OutwardResponse = {
    b2b: [mockB2bInvoice],
    b2cl: [mockB2clInvoice],
    b2cs: [mockB2csGroupEligible, mockB2csGroupNegative],
    diagnostics: [],
    b2csCreditNoteDiagnostics: [
      {
        reason: 'NEGATIVE_NET_B2CS_BUCKET',
        detail: 'B2CS bucket (place of supply 29-Karnataka, rate 0.18) went negative after netting eligible Credit Notes',
        placeOfSupply: '29-Karnataka',
        gstRate: 0.18,
      },
      {
        reason: 'CREDIT_NOTE_EXCLUDED',
        detail: 'Credit note CN-009 excluded from Table 7 net-off (CANCELLED)',
        creditNoteNumber: 'CN-009',
      },
      {
        reason: 'DUPLICATE_CREDIT_NOTE_ID',
        detail: 'Credit note cn-dup-1 was supplied more than once',
        creditNoteNumber: 'CN-DUP-1',
      },
    ],
    totals: {
      b2b: {
        invoiceCount: 1,
        invoiceValue: 118000,
        taxableValue: 100000,
        cgst: 9000,
        sgst: 9000,
        igst: 0,
        cess: 0,
      },
      b2cl: {
        invoiceCount: 1,
        invoiceValue: 350000,
        taxableValue: 300000,
        cgst: 0,
        sgst: 0,
        igst: 50000,
        cess: 0,
      },
      b2cs: {
        recordCount: 9,
        invoiceValue: 1000000,
        taxableValue: 945000,
        cgst: 14250,
        sgst: 14250,
        igst: -900,
        cess: 0,
      },
      grandTotal: {
        invoiceValue: 1468000,
        taxableValue: 1345000,
        cgst: 23250,
        sgst: 23250,
        igst: 49100,
        cess: 0,
      },
    },
    meta: {
      gstRegistrationId: 'reg-alpha-1',
      period: { from: '2026-04-01', to: '2027-03-31' },
      invoicesConsidered: 10,
      invoicesExcludedByScope: 0,
      creditNotesConsideredForNetOff: 5,
      creditNotesExcludedByScope: 0,
    },
  };

  // Mock Table 9B Credit Notes
  const mockCdnrDoc: Gstr1CreditNoteReportDocument = {
    documentType: 'CREDIT_NOTE',
    sign: -1,
    creditNoteId: 'cn-cdnr-01',
    creditNoteNumber: 'CRN-2026-001',
    creditNoteDate: '2026-08-10T00:00:00.000Z',
    originalInvoiceId: 'inv-b2b-01',
    originalInvoiceNumber: 'INV-2026-001',
    originalInvoiceDate: '2026-06-15T00:00:00.000Z',
    buyerGstin: '27AABCU9603R1ZX',
    sellerRegistrationId: 'reg-alpha-1',
    placeOfSupply: '27-Maharashtra',
    originalSupplyCategory: 'B2B',
    sourcePath: 'PATH_A',
    reasonCode: '01',
    reasonNotes: 'Sales Return',
    noteValue: 11800,
    taxableValue: 10000,
    igst: 0,
    cgst: 900,
    sgst: 900,
    cess: 0,
    rateBreakdown: [
      {
        rate: 0.18,
        hsnCode: '7113',
        uqc: 'GMS',
        quantity: 5,
        taxableValue: 10000,
        igst: 0,
        cgst: 900,
        sgst: 900,
        cess: 0,
      },
    ],
    diagnostics: [],
  };

  const mockCdnurB2clDoc: Gstr1CreditNoteReportDocument = {
    documentType: 'CREDIT_NOTE',
    sign: -1,
    creditNoteId: 'cn-cdnur-b2cl-01',
    creditNoteNumber: 'CRN-B2CL-001',
    creditNoteDate: '2026-08-15T00:00:00.000Z',
    originalInvoiceId: 'inv-b2cl-01',
    originalInvoiceNumber: 'INV-2026-099',
    originalInvoiceDate: '2026-07-20T00:00:00.000Z',
    buyerGstin: null,
    sellerRegistrationId: 'reg-alpha-1',
    placeOfSupply: '24-Gujarat',
    originalSupplyCategory: 'B2CL',
    sourcePath: 'PATH_A',
    reasonCode: '02',
    reasonNotes: 'Post Sale Discount',
    noteValue: 23600,
    taxableValue: 20000,
    igst: 3600,
    cgst: 0,
    sgst: 0,
    cess: 0,
    rateBreakdown: [
      {
        rate: 0.18,
        hsnCode: '7113',
        uqc: 'GMS',
        quantity: 10,
        taxableValue: 20000,
        igst: 3600,
        cgst: 0,
        sgst: 0,
        cess: 0,
      },
    ],
    diagnostics: [],
  };

  const mockCreditNoteResponse: Gstr1CreditNoteResponse = {
    cdnr: {
      documents: [mockCdnrDoc],
      summary: {
        documentCount: 1,
        taxableValue: 10000,
        cgst: 900,
        sgst: 900,
        igst: 0,
        cess: 0,
        noteValue: 11800,
      },
    },
    cdnur: {
      b2cl: {
        documents: [mockCdnurB2clDoc],
        summary: {
          documentCount: 1,
          taxableValue: 20000,
          cgst: 0,
          sgst: 0,
          igst: 3600,
          cess: 0,
          noteValue: 23600,
        },
      },
      export: {
        documents: [],
        summary: {
          documentCount: 0,
          taxableValue: 0,
          cgst: 0,
          sgst: 0,
          igst: 0,
          cess: 0,
          noteValue: 0,
        },
      },
    },
    diagnostics: [],
    excluded: [],
    meta: {
      gstRegistrationId: 'reg-alpha-1',
      period: { from: '2026-04-01', to: '2027-03-31' },
      notesConsidered: 2,
      notesExcludedByScope: 0,
    },
  };

  beforeEach(() => {
    qc = new QueryClient({
      defaultOptions: {
        queries: { retry: false, gcTime: 0 },
      },
    });

    qc.setQueryData(['gst-registrations'], { data: mockRegistrations });
    qc.setQueryData(['branches'], { data: mockBranches });
    qc.setQueryData(
      ['gstr1-outward', 'reg-alpha-1', defaultGstFrom(), defaultGstTo(), ''],
      mockOutwardResponse
    );
    qc.setQueryData(
      ['gstr1-credit-notes', 'reg-alpha-1', defaultGstFrom(), defaultGstTo(), ''],
      mockCreditNoteResponse
    );
    qc.setQueryData(
      ['gstr1-outward', '', defaultGstFrom(), defaultGstTo(), ''],
      mockOutwardResponse
    );
    qc.setQueryData(
      ['gstr1-credit-notes', '', defaultGstFrom(), defaultGstTo(), ''],
      mockCreditNoteResponse
    );

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

  // ─────────────────────────────────────────────────────────────────────────
  // Formatters unit tests
  // ─────────────────────────────────────────────────────────────────────────
  it('1. formatters format money, rates, quantities and negative values properly', () => {
    expect(money(1000)).toContain('1,000.00');
    expect(money(-5000)).toContain('-₹5,000.00');
    expect(money(0)).toContain('₹0.00');
    expect(formatQty(15.5)).toBe('15.5');
    expect(formatQty(-2)).toBe('-2');
    expect(formatRate(0.18)).toBe('18%');
    expect(formatRate(0.03)).toBe('3%');
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Filter Rendering
  // ─────────────────────────────────────────────────────────────────────────
  it('2. Filter controls render: GST Registration, Financial Year, From, To, Branch', () => {
    const html = renderWithProviders(<Gstr1 initialGstRegistrationId="reg-alpha-1" />);
    expect(html).toContain('GST Registration');
    expect(html).toContain('Financial Year');
    expect(html).toContain('From Date');
    expect(html).toContain('To Date');
    expect(html).toContain('Branch');
    expect(html).toContain('Alpha Jewels Pvt Ltd');
    expect(html).toContain('Mumbai Showroom');
  });

  it('3. Shows warning message when no GST Registration is selected', () => {
    const emptyClient = new QueryClient();
    emptyClient.setQueryData(['gst-registrations'], { data: [] });
    emptyClient.setQueryData(['branches'], { data: [] });
    const html = renderWithProviders(<Gstr1 initialGstRegistrationId="" />, emptyClient);
    expect(html).toContain('Please select a GST Registration');
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Table 4 — B2B
  // ─────────────────────────────────────────────────────────────────────────
  it('4. Table 4 B2B: data renders, line items render, totals render', () => {
    const html = renderWithProviders(<Gstr1 initialTab={0} initialGstRegistrationId="reg-alpha-1" />);
    expect(html).toContain('Table 4 — B2B');
    expect(html).toContain('Table 4 B2B Summary');
    expect(html).toContain('27AABCU9603R1ZX');
    expect(html).toContain('INV-2026-001');
    expect(html).toContain('27-Maharashtra');
    // Totals
    expect(html).toContain(money(100000));
    expect(html).toContain(money(118000));
    expect(html).toContain(money(9000));
  });

  it('5. Table 4 B2B: empty state renders when no records found', () => {
    const emptyClient = new QueryClient();
    emptyClient.setQueryData(['gst-registrations'], { data: mockRegistrations });
    emptyClient.setQueryData(['branches'], { data: mockBranches });
    emptyClient.setQueryData(
      ['gstr1-outward', 'reg-alpha-1', defaultGstFrom(), defaultGstTo(), ''],
      { b2b: [], b2cl: [], b2cs: [], totals: { b2b: { invoiceCount: 0 } } }
    );
    const html = renderWithProviders(<Gstr1 initialTab={0} initialGstRegistrationId="reg-alpha-1" />, emptyClient);
    expect(html).toContain('No records found for the selected period.');
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Table 5 — B2CL
  // ─────────────────────────────────────────────────────────────────────────
  it('6. Table 5 B2CL: data renders, thresholds render, totals render', () => {
    const html = renderWithProviders(<Gstr1 initialTab={1} initialGstRegistrationId="reg-alpha-1" />);
    expect(html).toContain('Table 5 — B2CL');
    expect(html).toContain('Table 5 B2CL Summary');
    expect(html).toContain('INV-2026-099');
    expect(html).toContain('24-Gujarat');
    expect(html).toContain(money(250000)); // threshold
    expect(html).toContain(money(300000)); // taxable
    expect(html).toContain(money(50000));  // IGST
    expect(html).toContain(money(350000)); // total invoice value
  });

  it('7. Table 5 B2CL: empty state renders when no records found', () => {
    const emptyClient = new QueryClient();
    emptyClient.setQueryData(['gst-registrations'], { data: mockRegistrations });
    emptyClient.setQueryData(['branches'], { data: mockBranches });
    emptyClient.setQueryData(
      ['gstr1-outward', 'reg-alpha-1', defaultGstFrom(), defaultGstTo(), ''],
      { b2b: [], b2cl: [], b2cs: [], totals: { b2cl: { invoiceCount: 0 } } }
    );
    const html = renderWithProviders(<Gstr1 initialTab={1} initialGstRegistrationId="reg-alpha-1" />, emptyClient);
    expect(html).toContain('No records found for the selected period.');
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Table 7 — B2CS (CRITICAL)
  // ─────────────────────────────────────────────────────────────────────────
  it('8. Table 7 B2CS: gross value, credit note reduction, and net value render visibly', () => {
    const html = renderWithProviders(<Gstr1 initialTab={2} initialGstRegistrationId="reg-alpha-1" />);
    expect(html).toContain('Table 7 — B2CS');
    expect(html).toContain('Table 7 B2CS Summary');
    expect(html).toContain('GROSS TAXABLE VALUE');
    expect(html).toContain('LESS: CREDIT NOTE REDUCTION');
    expect(html).toContain('EQUALS: NET TAXABLE VALUE');

    // Values from mockB2csGroupEligible
    expect(html).toContain(money(1000000)); // gross
    expect(html).toContain(money(50000));   // reduction
    expect(html).toContain(money(950000));  // net
    expect(html).toContain('Gross Outward Supplies — Credit Note Reduction = Net Statutory B2CS');
  });

  it('9. Table 7 B2CS: negative net bucket remains visible, not clamped, and shows ineligible warning', () => {
    const html = renderWithProviders(<Gstr1 initialTab={2} initialGstRegistrationId="reg-alpha-1" />);
    // Negative value must be visible
    expect(html).toContain('-₹5,000.00');
    expect(html).toContain('-₹900.00');
    expect(html).toContain('Filing not eligible');
    expect(html).toContain('Negative net B2CS bucket detected');
    expect(html).toContain('Ineligible');
  });

  it('10. Table 7 B2CS: all three diagnostics render (NEGATIVE_NET, CREDIT_NOTE_EXCLUDED, DUPLICATE_CN)', () => {
    const html = renderWithProviders(<Gstr1 initialTab={2} initialGstRegistrationId="reg-alpha-1" />);
    expect(html).toContain('B2CS Net-off Diagnostics');
    expect(html).toContain('NEGATIVE_NET_B2CS_BUCKET');
    expect(html).toContain('CREDIT_NOTE_EXCLUDED');
    expect(html).toContain('DUPLICATE_CREDIT_NOTE_ID');
    expect(html).toContain('CN-009');
    expect(html).toContain('CN-DUP-1');
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Table 9B — CDNR / CDNUR
  // ─────────────────────────────────────────────────────────────────────────
  it('11. Table 9B: CDNR renders registered notes and summaries', () => {
    const html = renderWithProviders(<Gstr1 initialTab={3} initialGstRegistrationId="reg-alpha-1" />);
    expect(html).toContain('Table 9B — Credit / Debit Notes');
    expect(html).toContain('CDNR — Registered Recipients');
    expect(html).toContain('CRN-2026-001');
    expect(html).toContain('INV-2026-001');
    expect(html).toContain('10,000.00'); // taxable
    expect(html).toContain('11,800.00'); // note value
  });

  it('12. Table 9B: CDNUR B2CL and CDNUR Export sub-tabs exist and NO CDNUR B2CS exists', () => {
    const html = renderWithProviders(<Gstr1 initialTab={3} initialGstRegistrationId="reg-alpha-1" />);
    expect(html).toContain('CDNUR — B2CL');
    expect(html).toContain('CDNUR — Export');

    // CRITICAL REQUIREMENT: CDNUR B2CS MUST NOT EXIST
    expect(html).not.toContain('CDNUR B2CS');
    expect(html).not.toContain('CDNUR — B2CS');
    expect(html).not.toContain('CDNUR/B2CS');
  });

  // ─────────────────────────────────────────────────────────────────────────
  // CSV Export Tests
  // ─────────────────────────────────────────────────────────────────────────
  it('13. Table 4 CSV export includes required columns', () => {
    const spy = vi.spyOn(exportUtils, 'exportToCsv').mockImplementation(() => {});
    exportTable4Csv([mockB2bInvoice]);
    expect(spy).toHaveBeenCalledTimes(1);

    const [filename, columns, rows] = spy.mock.calls[0] as [string, any[], any[]];
    expect(filename).toContain('table4-b2b');

    const headers = columns.map((c: any) => c.header);
    expect(headers).toContain('Recipient GSTIN');
    expect(headers).toContain('Invoice Number');
    expect(headers).toContain('Invoice Date');
    expect(headers).toContain('Invoice Value');
    expect(headers).toContain('Place of Supply');
    expect(headers).toContain('Reverse Charge');
    expect(headers).toContain('Rate');
    expect(headers).toContain('Taxable Value');
    expect(headers).toContain('CGST');
    expect(headers).toContain('SGST');
    expect(headers).toContain('IGST');
    expect(headers).toContain('Cess');
    expect(headers).toContain('HSN');
    expect(headers).toContain('UQC');
    expect(headers).toContain('Quantity');

    expect(rows.length).toBe(1);
    expect(rows[0].buyerGstin).toBe('27AABCU9603R1ZX');
    expect(rows[0].invoiceNumber).toBe('INV-2026-001');
  });

  it('14. Table 5 CSV export includes required columns', () => {
    const spy = vi.spyOn(exportUtils, 'exportToCsv').mockImplementation(() => {});
    exportTable5Csv([mockB2clInvoice]);
    expect(spy).toHaveBeenCalledTimes(1);

    const [filename, columns, rows] = spy.mock.calls[0] as [string, any[], any[]];
    expect(filename).toContain('table5-b2cl');

    const headers = columns.map((c: any) => c.header);
    expect(headers).toContain('Invoice Number');
    expect(headers).toContain('Invoice Date');
    expect(headers).toContain('Invoice Value');
    expect(headers).toContain('Place of Supply');
    expect(headers).toContain('Applicable Threshold');
    expect(headers).toContain('Rate');
    expect(headers).toContain('Taxable Value');
    expect(headers).toContain('IGST');
    expect(headers).toContain('Cess');
    expect(headers).toContain('HSN');
    expect(headers).toContain('UQC');
    expect(headers).toContain('Quantity');

    expect(rows.length).toBe(1);
    expect(rows[0].invoiceNumber).toBe('INV-2026-099');
  });

  it('15. Table 7 CSV export preserves ALL Phase A columns (Gross, Reduction, Net) and does not collapse them', () => {
    const spy = vi.spyOn(exportUtils, 'exportToCsv').mockImplementation(() => {});
    exportTable7Csv([mockB2csGroupEligible, mockB2csGroupNegative]);
    expect(spy).toHaveBeenCalledTimes(1);

    const [filename, columns, rows] = spy.mock.calls[0] as [string, any[], any[]];
    expect(filename).toContain('table7-b2cs');

    const headers = columns.map((c: any) => c.header);
    // Explicit Phase A columns
    expect(headers).toContain('Supply Type');
    expect(headers).toContain('Place of Supply');
    expect(headers).toContain('Rate');
    expect(headers).toContain('HSN');
    expect(headers).toContain('UQC');

    expect(headers).toContain('Gross Taxable Value');
    expect(headers).toContain('Credit Note Reduction');
    expect(headers).toContain('Net Taxable Value');

    expect(headers).toContain('Gross IGST');
    expect(headers).toContain('Credit Note IGST Reduction');
    expect(headers).toContain('Net IGST');

    expect(headers).toContain('Gross CGST');
    expect(headers).toContain('Credit Note CGST Reduction');
    expect(headers).toContain('Net CGST');

    expect(headers).toContain('Gross SGST');
    expect(headers).toContain('Credit Note SGST Reduction');
    expect(headers).toContain('Net SGST');

    expect(headers).toContain('Cess');
    expect(headers).toContain('Filing Eligible');
    expect(headers).toContain('Diagnostic');

    // Values of first row
    const first = rows[0];
    const grossVal = columns.find((c: any) => c.header === 'Gross Taxable Value')!.value(first);
    const redVal = columns.find((c: any) => c.header === 'Credit Note Reduction')!.value(first);
    const netVal = columns.find((c: any) => c.header === 'Net Taxable Value')!.value(first);

    expect(grossVal).toBe(1000000);
    expect(redVal).toBe(50000);
    expect(netVal).toBe(950000);

    // Negative row preserved in CSV
    const second = rows[1];
    const negNetVal = columns.find((c: any) => c.header === 'Net Taxable Value')!.value(second);
    const filingEligible = columns.find((c: any) => c.header === 'Filing Eligible')!.value(second);
    expect(negNetVal).toBe(-5000);
    expect(filingEligible).toBe('No');
  });

  it('16. Table 9B CSV export exports CDNR and CDNUR without any CDNUR B2CS', () => {
    const spy = vi.spyOn(exportUtils, 'exportToCsv').mockImplementation(() => {});

    // CDNR
    exportTable9bCsv([mockCdnrDoc], 'CDNR');
    expect(spy).toHaveBeenCalledTimes(1);
    let [filename, columns, rows] = spy.mock.calls[0] as [string, any[], any[]];
    expect(filename).toContain('table9b-cdnr');
    let headers = columns.map((c: any) => c.header);
    expect(headers).toContain('Recipient GSTIN');
    expect(headers).toContain('Note Number');
    expect(headers).toContain('Original Invoice Number');
    expect(rows.length).toBe(1);

    // CDNUR B2CL
    spy.mockClear();
    exportTable9bCsv([mockCdnurB2clDoc], 'CDNUR_B2CL');
    expect(spy).toHaveBeenCalledTimes(1);
    [filename, columns, rows] = spy.mock.calls[0] as [string, any[], any[]];
    expect(filename).toContain('cdnur-b2cl');
    headers = columns.map((c: any) => c.header);
    expect(headers).toContain('Note Number');
    expect(headers).not.toContain('CDNUR B2CS');

    // CDNUR Export
    spy.mockClear();
    exportTable9bCsv([], 'CDNUR_EXPORT');
    expect(spy).toHaveBeenCalledTimes(1);
    [filename, columns, rows] = spy.mock.calls[0] as [string, any[], any[]];
    expect(filename).toContain('cdnur-export');
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Navigation & Route Verification
  // ─────────────────────────────────────────────────────────────────────────
  it('17. GSTR-1 Reports nav item exists in NAV_ITEMS with report:financial_view permission', () => {
    const reportsNav = NAV_ITEMS.find((n) => n.label === 'Reports');
    expect(reportsNav).toBeDefined();
    const gstr1Item = reportsNav?.children?.find((c) => c.path === '/reports/gstr1');
    expect(gstr1Item).toBeDefined();
    expect(gstr1Item?.label).toBe('GSTR-1 Reports');
    expect(gstr1Item?.permission).toBe('report:financial_view');
  });
});
