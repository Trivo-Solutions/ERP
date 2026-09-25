import { Chip, ChipProps } from '@mui/material';

const STATUS_CONFIG: Record<string, { label: string; color: ChipProps['color'] }> = {
  // Orders
  PENDING: { label: 'Pending', color: 'default' },
  CONFIRMED: { label: 'Confirmed', color: 'info' },
  IN_PRODUCTION: { label: 'In Production', color: 'warning' },
  QC_CHECK: { label: 'QC Check', color: 'warning' },
  QC_PENDING: { label: 'QC Pending', color: 'warning' },
  QC_PASSED: { label: 'QC Passed', color: 'success' },
  READY: { label: 'Ready', color: 'success' },
  DELIVERED: { label: 'Delivered', color: 'success' },
  CANCELLED: { label: 'Cancelled', color: 'error' },
  REJECTED: { label: 'Rejected', color: 'error' },

  // Job cards
  CREATED: { label: 'Created', color: 'default' },
  IN_PROGRESS: { label: 'In Progress', color: 'warning' },
  COMPLETED: { label: 'Completed', color: 'success' },

  // GRN / PO
  DRAFT: { label: 'Draft', color: 'default' },
  VERIFIED: { label: 'Verified', color: 'info' },
  APPROVED: { label: 'Approved', color: 'success' },
  DISCREPANCY: { label: 'Discrepancy', color: 'error' },
  PARTIAL: { label: 'Partial', color: 'warning' },

  // Invoice
  ISSUED: { label: 'Issued', color: 'info' },
  PARTIALLY_PAID: { label: 'Partial Paid', color: 'warning' },
  PAID: { label: 'Paid', color: 'success' },

  // Memo
  OUT: { label: 'Out', color: 'warning' },
  RETURNED: { label: 'Returned', color: 'success' },
  CONVERTED: { label: 'Converted', color: 'info' },
  AVAILABLE: { label: 'Available', color: 'success' },
  PARTIALLY_USED: { label: 'Partial', color: 'warning' },
  EXHAUSTED: { label: 'Exhausted', color: 'error' },
  RESERVED: { label: 'Reserved', color: 'info' },

  // QC result
  PASSED: { label: 'Passed', color: 'success' },
  FAILED: { label: 'Failed', color: 'error' },
  CONDITIONAL: { label: 'Conditional', color: 'warning' },

  // Hallmarking
  SENT: { label: 'Sent', color: 'warning' },
  RECEIVED: { label: 'Received', color: 'success' },

  // Default
  ACTIVE: { label: 'Active', color: 'success' },
  INACTIVE: { label: 'Inactive', color: 'default' },
};

interface Props {
  status: string;
  size?: ChipProps['size'];
}

export function StatusChip({ status, size = 'small' }: Props) {
  const config = STATUS_CONFIG[status] ?? { label: status, color: 'default' as const };
  return <Chip label={config.label} color={config.color} size={size} sx={{ fontWeight: 600, fontSize: 11 }} />;
}
