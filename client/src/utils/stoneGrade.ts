// Short, typeable code for a Stone Grade — e.g. "DIA-RD-VVS2-G" for a Round/VVS2/G diamond, or
// "KUN-COMMERCIAL" for a colour stone graded only by quality. Purely derived (not stored) so it
// never goes stale if a grade's fields are edited later, and it's put first in any dropdown
// label so native-<select> type-ahead can jump straight to it by typing the code.
const SHAPE_ABBREV: Record<string, string> = {
  Round: 'RD', Princess: 'PR', Oval: 'OV', Pear: 'PS', Cushion: 'CU',
  Emerald: 'EM', Radiant: 'RAD', Heart: 'HT', Marquise: 'MQ',
};

type StoneGradeLike = {
  shape?: string | null; color?: string | null; clarity?: string | null; cut?: string | null; quality?: string | null;
  stoneType?: { code?: string | null; name?: string | null } | null;
};

export function stoneGradeCode(grade: StoneGradeLike): string {
  const typeCode = (grade.stoneType?.code || '').toUpperCase();
  const shapeAbbrev = grade.shape ? (SHAPE_ABBREV[grade.shape] ?? grade.shape.slice(0, 2).toUpperCase()) : null;
  const parts = [typeCode, shapeAbbrev, grade.clarity, grade.color, grade.quality]
    .filter(Boolean)
    .map((s) => String(s).toUpperCase());
  return parts.join('-') || typeCode || '—';
}

export function stoneGradeLabel(grade: StoneGradeLike): string {
  const name = grade.stoneType?.name ?? grade.stoneType?.code ?? 'Stone';
  return `${stoneGradeCode(grade)} (${name})`;
}
