import React from 'react';
import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { SalesReport } from '../pages/Reports/SalesReport';

// Static render of the Summary view over seeded server data: a bill shared by two employees is ONE row listing both.
describe('SalesReport (summary view)', () => {
  const row = (id: string, n: string, employees: string[], total: number) => ({
    id, invoiceNumber: n, invoiceDate: '2026-03-10T00:00:00.000Z', createdAt: '2026-03-10T10:30:00.000Z',
    customer: 'C1 — Client One', branch: 'Main', salesEmployees: employees,
    taxableAmount: total, cgst: 0, sgst: 0, igst: 0, gstTotal: 0, invoiceTotal: total, paymentStatus: 'UNPAID', invoiceStatus: 'ISSUED',
  });

  it('renders one row per invoice with every employee on it, and a footer total over unique invoices', () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
    qc.setQueryData(['sales-report', 'summary', {}], {
      rows: [row('1', 'INV-1001', ['Ravi', 'Suresh'], 525000), row('2', 'INV-1002', ['Ravi'], 1000)],
      branches: [], employeeOptions: [], truncated: false, limit: 5000,
      totals: { invoiceCount: 2, taxableAmount: 526000, cgst: 0, sgst: 0, igst: 0, gstTotal: 0, invoiceTotal: 526000 },
    });
    const html = renderToStaticMarkup(
      <QueryClientProvider client={qc}><MemoryRouter><SalesReport /></MemoryRouter></QueryClientProvider>,
    );
    expect(html.match(/INV-1001/g)).toHaveLength(1);
    expect(html).toContain('Ravi, Suresh');
    expect(html).toContain('Total · 2 invoices');
    expect(html).toContain('5,26,000.00');
    expect(html).toContain('Detailed');
  });
});
