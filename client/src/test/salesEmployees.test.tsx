import { describe, it, expect } from 'vitest';
import { employeeFormErrors } from '../pages/Settings/SalesEmployeesPage';

const FORM = { name: 'Asha Rao', email: 'asha@example.com', employeeId: '', phone: '', designation: '', roleId: 'r1', allBranches: false, branchIds: ['b1'], isActive: true };

describe('sales employee form rules (mirror of the server)', () => {
  it('a complete form is accepted', () => {
    expect(employeeFormErrors(FORM, true)).toEqual({});
  });
  it('requires a name, a valid email when creating, a role, and branches or All branches', () => {
    expect(Object.keys(employeeFormErrors({ ...FORM, name: ' ', email: 'nope', roleId: '', branchIds: [] }, true)).sort())
      .toEqual(['branchIds', 'email', 'name', 'roleId']);
    expect(employeeFormErrors({ ...FORM, branchIds: [], allBranches: true }, true)).toEqual({});
  });
  it('does not re-validate the email when editing (it is fixed once created)', () => {
    expect(employeeFormErrors({ ...FORM, email: '' }, false)).toEqual({});
  });
});
