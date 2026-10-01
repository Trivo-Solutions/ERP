// Converts a number to words in the Indian numbering system (Crores, Lakhs, Thousands, Hundreds)
const ONES = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten',
  'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen'];
const TENS = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];

function convertChunk(n: number): string {
  if (n === 0) return '';
  if (n < 20) return ONES[n];
  if (n < 100) return `${TENS[Math.floor(n / 10)]}${n % 10 !== 0 ? ' ' + ONES[n % 10] : ''}`;
  return `${ONES[Math.floor(n / 100)]} Hundred${n % 100 !== 0 ? ' and ' + convertChunk(n % 100) : ''}`;
}

export function amountInWordsINR(amount: number): string {
  const num = Math.abs(Number(amount) || 0);
  const rupees = Math.floor(num);
  const paise = Math.round((num - rupees) * 100);

  if (rupees === 0 && paise === 0) return 'Zero Rupees Only';

  let str = '';

  const crore = Math.floor(rupees / 10000000);
  const lakh = Math.floor((rupees % 10000000) / 100000);
  const thousand = Math.floor((rupees % 100000) / 1000);
  const remainder = rupees % 1000;

  if (crore > 0) str += `${convertChunk(crore)} Crore `;
  if (lakh > 0) str += `${convertChunk(lakh)} Lakh `;
  if (thousand > 0) str += `${convertChunk(thousand)} Thousand `;
  if (remainder > 0) str += `${convertChunk(remainder)} `;

  str = str.trim();
  const rupeesStr = str ? `Rupees ${str}` : '';
  const paiseStr = paise > 0 ? `${convertChunk(paise)} Paise` : '';

  if (rupeesStr && paiseStr) {
    return `${rupeesStr} and ${paiseStr} Only`;
  }
  if (rupeesStr) {
    return `${rupeesStr} Only`;
  }
  return `${paiseStr} Only`;
}
