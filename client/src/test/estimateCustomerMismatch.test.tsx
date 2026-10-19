import { describe, it, expect } from 'vitest';
import { isEstimateCustomerMismatch } from '../utils/estimateCustomer';
import { CustomerMismatchDialog } from '../pages/Sales/CustomerMismatchDialog';

describe('estimate → bill customer mismatch', () => {
  it('same normalized phone (formatting / country code ignored) → no warning', () => {
    expect(isEstimateCustomerMismatch('98765 43210', '+91 9876543210')).toBe(false);
  });
  it('different phone → warning', () => {
    expect(isEstimateCustomerMismatch('9876543210', '9123456789')).toBe(true);
  });
  it('manually selected bill customer + different estimate customer → warning', () => {
    expect(isEstimateCustomerMismatch('9000000001', '9000000002', true)).toBe(true);
  });
  it('bill has no customer → proceeds', () => {
    expect(isEstimateCustomerMismatch(undefined, '9123456789', false)).toBe(false);
  });
  it('estimate has no phone → no false warning', () => {
    expect(isEstimateCustomerMismatch('9876543210', '')).toBe(false);
    expect(isEstimateCustomerMismatch('9876543210', null)).toBe(false);
  });
  it('bill customer has no phone on file → nothing to compare, no warning', () => {
    expect(isEstimateCustomerMismatch('', '9123456789')).toBe(false);
  });
});

// MUI dialogs portal out of SSR markup, so walk the returned element tree and press the buttons directly.
function findButtons(node: any, out: any[] = []): any[] {
  if (!node || typeof node !== 'object') return out;
  if (Array.isArray(node)) { node.forEach((n) => findButtons(n, out)); return out; }
  if (node.props?.onClick) out.push(node);
  findButtons(node.props?.children, out);
  return out;
}
const label = (b: any) => String(b.props.children);

describe('CustomerMismatchDialog', () => {
  it('Cancel fires only onCancel; Add Anyway fires only onConfirm', () => {
    const calls: string[] = [];
    const tree: any = CustomerMismatchDialog({ open: true, onCancel: () => calls.push('cancel'), onConfirm: () => calls.push('confirm') });
    expect(tree.props.open).toBe(true);
    const buttons = findButtons(tree);
    expect(buttons.map(label)).toEqual(['Cancel', 'Add Anyway']);
    buttons.find((b) => label(b) === 'Cancel').props.onClick();
    expect(calls).toEqual(['cancel']);
    buttons.find((b) => label(b) === 'Add Anyway').props.onClick();
    expect(calls).toEqual(['cancel', 'confirm']);
  });
  it('carries the Customer Mismatch title and message', () => {
    const json = JSON.stringify(CustomerMismatchDialog({ open: true, onCancel: () => {}, onConfirm: () => {} }));
    expect(json).toContain('Customer Mismatch');
    expect(json).toContain('different customer than the customer currently selected');
  });
});

import { customerToEstimateFields } from '../utils/estimateCustomer';

describe('customerToEstimateFields (existing-customer picker)', () => {
  it('fills name, mobile, DOB (date part only) and address; never PAN', () => {
    const f = customerToEstimateFields({ name: 'Ramesh', phone: '9876500011', dateOfBirth: '1990-04-05T00:00:00.000Z', address: '1 MG Road', ...({ panNumber: 'ABCDE1234F' } as object) });
    expect(f).toEqual({ name: 'Ramesh', phone: '9876500011', dob: '1990-04-05', address: '1 MG Road', pan: '' });
  });
  it('a name-only result (server withheld personal fields) leaves the rest blank rather than undefined', () => {
    expect(customerToEstimateFields({ name: 'Ramesh' })).toEqual({ name: 'Ramesh', phone: '', dob: '', address: '', pan: '' });
  });
  it('does not carry a sales employee - that is chosen separately', () => {
    expect(Object.keys(customerToEstimateFields({ name: 'x' })).sort()).toEqual(['address', 'dob', 'name', 'pan', 'phone']);
  });
});
