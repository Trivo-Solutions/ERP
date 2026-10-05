// Last 10 digits of a phone number — the same normalisation the estimate hand-off uses to match a customer.
export const last10Digits = (v?: string | null) => (v ?? '').replace(/\D/g, '').slice(-10);

// True when an estimate belongs to a different customer than the one already chosen on the bill.
// Only a comparison of two real phone numbers can say so: no bill customer, no estimate phone, or no phone
// on the bill customer's record means there is nothing to compare, so no warning.
export function isEstimateCustomerMismatch(billClientPhone?: string | null, estimatePhone?: string | null, hasBillClient = true): boolean {
  if (!hasBillClient) return false;
  const est = last10Digits(estimatePhone);
  const bill = last10Digits(billClientPhone);
  if (!est || !bill) return false;
  return est !== bill;
}
