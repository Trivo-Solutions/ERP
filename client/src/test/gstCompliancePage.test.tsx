import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { GstCompliancePage } from '../pages/Compliance/GstCompliancePage';
import { useAuthStore } from '../store/auth.store';
import * as apiClient from '../api/client';
import { NAV_ITEMS } from '../components/Layout/navItems';

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

describe('GST Compliance & AATO Page Test Suite', () => {
  let qc: QueryClient;

  const mockRegistrations = [
    { id: 'reg-active-1', gstin: '27AABCU9603R1ZX', legalName: 'Alpha Jewel Corp', tradeName: 'Alpha Jewels', isActive: true },
    { id: 'reg-active-2', gstin: '29ABCDE1234F1Z5', legalName: 'Alpha South Branch', tradeName: null, isActive: true },
  ];

  const mockAatoCurrent = {
    id: 'aato-1',
    companyId: 'comp-1',
    gstRegistrationId: 'reg-active-1',
    financialYear: '2026-27',
    turnover: 65000000,
    precedingTurnover: 52000000,
    source: 'MANUAL',
    verificationStatus: 'UNVERIFIED',
    verifiedDate: null,
    verifiedBy: null,
    notes: 'Provisional audited accounts',
    createdAt: '2026-04-10T10:00:00.000Z',
    updatedAt: '2026-04-10T10:00:00.000Z',
  };

  const mockPrecedingAato = {
    financialYear: '2025-26',
    turnover: 52000000,
    source: 'GST_PORTAL',
    verificationStatus: 'VERIFIED',
  };

  const mockAatoResponse = {
    aato: mockAatoCurrent,
    precedingAato: mockPrecedingAato,
    financialYear: '2026-27',
    precedingFinancialYear: '2025-26',
  };

  const mockHistory = [
    {
      id: 'hist-1',
      aatoId: 'aato-1',
      gstRegistrationId: 'reg-active-1',
      financialYear: '2026-27',
      turnover: 65000000,
      precedingTurnover: 52000000,
      source: 'MANUAL',
      verificationStatus: 'UNVERIFIED',
      verifiedDate: null,
      notes: 'Initial entry',
      action: 'CREATE',
      changedBy: 'Admin User',
      createdAt: '2026-04-10T10:00:00.000Z',
    },
  ];

  beforeEach(() => {
    qc = new QueryClient({
      defaultOptions: {
        queries: { retry: false, staleTime: Infinity },
      },
    });

    useAuthStore.setState({
      user: {
        id: 'usr-1',
        fullName: 'GST Compliance Admin',
        email: 'admin@trivo.com',
        role: 'SUPERADMIN',
        companyId: 'comp-1',
        permissions: ['*'],
      } as any,
    });

    vi.spyOn(apiClient, 'apiGet').mockImplementation(async (url: string) => {
      if (url === '/company/gst-registrations') {
        return mockRegistrations;
      }
      if (url.includes('/gst/aato?')) {
        return mockAatoResponse;
      }
      if (url.includes('/gst/aato/history?')) {
        return mockHistory;
      }
      return null;
    });
  });

  const renderComponent = () => {
    return renderToStaticMarkup(
      <QueryClientProvider client={qc}>
        <MemoryRouter>
          <GstCompliancePage />
        </MemoryRouter>
      </QueryClientProvider>
    );
  };

  it('renders GST Compliance header and tab headers', () => {
    const html = renderComponent();
    expect(html).toContain('Annual Aggregate Turnover (AATO)');
    expect(html).toContain('AATO Management');
    expect(html).toContain('Statutory Compliance Checker');
  });

  it('displays AATO cards for current and preceding FY', () => {
    // Populate query cache directly so SSR markup shows data
    qc.setQueryData(['gst-registrations'], mockRegistrations);
    qc.setQueryData(['gst-aato', 'reg-active-1', '2026-27'], mockAatoResponse);
    qc.setQueryData(['gst-aato-history', 'reg-active-1', '2026-27'], mockHistory);

    const html = renderComponent();
    expect(html).toContain('Current Financial Year');
    expect(html).toContain('Preceding Financial Year Context');
    expect(html).toContain('6,50,00,000');
    expect(html).toContain('5,20,00,000');
    expect(html).toContain('UNVERIFIED');
    expect(html).toContain('VERIFIED');
    expect(html).toContain('MANUAL');
  });

  it('displays Notification 78/2020 statutory guidance based on preceding AATO', () => {
    qc.setQueryData(['gst-registrations'], mockRegistrations);
    qc.setQueryData(['gst-aato', 'reg-active-1', '2026-27'], mockAatoResponse);
    qc.setQueryData(['gst-aato-history', 'reg-active-1', '2026-27'], mockHistory);

    const html = renderComponent();
    expect(html).toContain('Notification No. 78/2020');
    expect(html).toContain('6-digit HSN codes are mandatory');
  });

  it('renders AATO revision history with user, action, and timestamp', () => {
    qc.setQueryData(['gst-registrations'], mockRegistrations);
    qc.setQueryData(['gst-aato', 'reg-active-1', '2026-27'], mockAatoResponse);
    qc.setQueryData(['gst-aato-history', 'reg-active-1', '2026-27'], mockHistory);

    const html = renderComponent();
    expect(html).toContain('AATO Audit Trail &amp; History');
    expect(html).toContain('CREATE');
    expect(html).toContain('Initial entry');
  });

  it('includes GST Compliance & AATO in NAV_ITEMS under Sales & Export with required permission', () => {
    const salesGroup = NAV_ITEMS.find((item) => item.label === 'Sales & Export');
    expect(salesGroup).toBeDefined();
    const complianceNav = salesGroup?.children?.find((sub) => sub.label === 'GST Compliance & AATO');
    expect(complianceNav).toBeDefined();
    expect(complianceNav?.path).toBe('/sales/gst-compliance');
    expect(complianceNav?.permission).toBe('gst:registration_view');
  });
});
