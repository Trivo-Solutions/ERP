import { describe, it, expect } from 'vitest';
import { redactUrlForLog } from './logRedaction';

describe('redactUrlForLog', () => {
  it('redacts the customer-search query, whatever it holds', () => {
    expect(redactUrlForLog('/api/v1/estimation/customers?q=9876500011')).toBe('/api/v1/estimation/customers?[redacted]');
    expect(redactUrlForLog('/api/v1/estimation/customers?q=Ramesh&x=1')).toBe('/api/v1/estimation/customers?[redacted]');
  });
  it('redacts the variants Express still routes to the same handler', () => {
    expect(redactUrlForLog('/api/v1/estimation/customers/?q=9876500011')).toBe('/api/v1/estimation/customers/?[redacted]');
    expect(redactUrlForLog('/API/V1/Estimation/Customers?q=Ramesh')).toBe('/API/V1/Estimation/Customers?[redacted]');
  });
  it('leaves the bare path and every other route (and its query) unchanged', () => {
    expect(redactUrlForLog('/api/v1/estimation/customers')).toBe('/api/v1/estimation/customers');
    expect(redactUrlForLog('/api/v1/estimation/tags/search?q=ring')).toBe('/api/v1/estimation/tags/search?q=ring');
    expect(redactUrlForLog('/api/v1/sales/invoices?page=2')).toBe('/api/v1/sales/invoices?page=2');
    expect(redactUrlForLog('/api/v1/estimation/customers-export?q=1')).toBe('/api/v1/estimation/customers-export?q=1');
  });
});
