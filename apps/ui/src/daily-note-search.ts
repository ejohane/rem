const MONTH_TO_NUMBER: Record<string, number> = {
  jan: 1,
  feb: 2,
  mar: 3,
  apr: 4,
  may: 5,
  jun: 6,
  jul: 7,
  aug: 8,
  sep: 9,
  oct: 10,
  nov: 11,
  dec: 12,
};

const DAILY_TITLE_PATTERN =
  /^(Sunday|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday)\s([A-Za-z]{3})\s(\d{1,2})(?:st|nd|rd|th)\s(\d{4})$/;

export function buildDailyTitleDateAliases(title: string): string[] {
  const normalizedTitle = title.trim();
  const match = DAILY_TITLE_PATTERN.exec(normalizedTitle);
  if (!match) {
    return [];
  }

  const monthToken = (match[2] ?? "").toLowerCase();
  const month = MONTH_TO_NUMBER[monthToken];
  const day = Number.parseInt(match[3] ?? "", 10);
  const year = Number.parseInt(match[4] ?? "", 10);
  if (!month || !Number.isInteger(day) || !Number.isInteger(year)) {
    return [];
  }

  const monthPadded = month.toString().padStart(2, "0");
  const dayPadded = day.toString().padStart(2, "0");
  return [
    `${month}-${day}-${year}`,
    `${monthPadded}-${dayPadded}-${year}`,
    `${month}/${day}/${year}`,
    `${monthPadded}/${dayPadded}/${year}`,
    `${year}-${monthPadded}-${dayPadded}`,
  ];
}
