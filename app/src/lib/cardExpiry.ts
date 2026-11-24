/**
 * The month and year a person typed for a card's expiry, however they wrote it: 12/27, 12/2027,
 * 1227, 12-27, 12.27, 12 27, 2027-12. Null when it is not a month and a year. The year comes back
 * with four digits.
 */
export function parseExpiry(text: string): { month: number; year: number } | null {
  const trimmed = text.trim();
  if (!/^[\d\s/.\-\\]+$/.test(trimmed)) return null;
  const parts = trimmed.split(/[\s/.\-\\]+/).filter(Boolean);
  let month: string;
  let year: string;
  if (parts.length === 2) {
    // A year first (2027-12) has four digits; otherwise the month comes first.
    [month, year] = parts[0]!.length === 4 ? [parts[1]!, parts[0]!] : [parts[0]!, parts[1]!];
  } else if (parts.length === 1) {
    // Run together: 127 and 1227 are month and two-digit year, 122027 is month and four-digit year.
    const run = parts[0]!;
    if (run.length === 3 || run.length === 4) [month, year] = [run.slice(0, -2), run.slice(-2)];
    else if (run.length === 6) [month, year] = [run.slice(0, 2), run.slice(2)];
    else return null;
  } else {
    return null;
  }
  if (month.length > 2 || (year.length !== 2 && year.length !== 4)) return null;
  const m = Number(month);
  const y = year.length === 2 ? 2000 + Number(year) : Number(year);
  if (m < 1 || m > 12 || y < 2000 || y > 2100) return null;
  return { month: m, year: y };
}
