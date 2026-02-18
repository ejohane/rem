export const DAILY_NOTES_NAMESPACE = "daily-notes";
export const DAILY_NOTES_DEFAULT_TAG = "daily";
export const DAILY_NOTES_NOTE_ID_PREFIX = "daily-";

export interface ParsedDailyDateInput {
  year: number;
  month: number;
  day: number;
}

export interface DailyNoteIdentity {
  noteId: string;
  dateKey: string;
  shortDate: string;
  displayTitle: string;
  timezone: string;
}

function ordinalSuffix(day: number): string {
  const mod100 = day % 100;
  if (mod100 >= 11 && mod100 <= 13) {
    return "th";
  }

  const mod10 = day % 10;
  if (mod10 === 1) {
    return "st";
  }
  if (mod10 === 2) {
    return "nd";
  }
  if (mod10 === 3) {
    return "rd";
  }

  return "th";
}

function isValidDateParts(input: ParsedDailyDateInput): boolean {
  if (
    !Number.isInteger(input.year) ||
    !Number.isInteger(input.month) ||
    !Number.isInteger(input.day)
  ) {
    return false;
  }

  if (input.month < 1 || input.month > 12 || input.day < 1 || input.day > 31) {
    return false;
  }

  const probe = new Date(Date.UTC(input.year, input.month - 1, input.day));
  return (
    probe.getUTCFullYear() === input.year &&
    probe.getUTCMonth() + 1 === input.month &&
    probe.getUTCDate() === input.day
  );
}

export function resolveDailyTimeZone(input?: string): string {
  const candidate = input?.trim();
  if (candidate && candidate.length > 0) {
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: candidate }).format(new Date());
      return candidate;
    } catch {
      throw new Error(`Invalid timezone: ${candidate}`);
    }
  }

  const local = Intl.DateTimeFormat().resolvedOptions().timeZone;
  if (local && local.trim().length > 0) {
    return local;
  }

  return "UTC";
}

function parseZonedDateParts(
  now: Date,
  timeZone: string,
): {
  year: number;
  month: number;
  day: number;
  weekday: string;
  monthShort: string;
} {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "long",
    month: "short",
    day: "numeric",
    year: "numeric",
  });
  const parts = formatter.formatToParts(now);

  const byType = new Map<string, string>();
  for (const part of parts) {
    if (
      part.type === "weekday" ||
      part.type === "month" ||
      part.type === "day" ||
      part.type === "year"
    ) {
      byType.set(part.type, part.value);
    }
  }

  const weekday = byType.get("weekday");
  const monthShort = byType.get("month");
  const dayRaw = byType.get("day");
  const yearRaw = byType.get("year");
  if (!weekday || !monthShort || !dayRaw || !yearRaw) {
    throw new Error(`Unable to resolve date parts for timezone ${timeZone}`);
  }

  const month = Number.parseInt(
    new Intl.DateTimeFormat("en-US", { timeZone, month: "numeric" }).format(now),
    10,
  );
  const day = Number.parseInt(dayRaw, 10);
  const year = Number.parseInt(yearRaw, 10);
  if (!Number.isInteger(month) || !Number.isInteger(day) || !Number.isInteger(year)) {
    throw new Error(`Unable to parse date parts for timezone ${timeZone}`);
  }

  return {
    year,
    month,
    day,
    weekday,
    monthShort,
  };
}

export function formatDailyDisplayTitleFromDate(input: ParsedDailyDateInput): string {
  if (!isValidDateParts(input)) {
    throw new Error(`Invalid daily date: ${input.year}-${input.month}-${input.day}`);
  }

  const date = new Date(input.year, input.month - 1, input.day);
  const weekday = new Intl.DateTimeFormat("en-US", { weekday: "long" }).format(date);
  const monthShort = new Intl.DateTimeFormat("en-US", { month: "short" }).format(date);
  return `${weekday} ${monthShort} ${input.day}${ordinalSuffix(input.day)} ${input.year}`;
}

export function buildDailyNoteIdentity(now: Date, inputTimeZone?: string): DailyNoteIdentity {
  if (!(now instanceof Date) || Number.isNaN(now.valueOf())) {
    throw new Error("Invalid date supplied for daily note identity");
  }

  const timezone = resolveDailyTimeZone(inputTimeZone);
  const parts = parseZonedDateParts(now, timezone);
  const dayWithOrdinal = `${parts.day}${ordinalSuffix(parts.day)}`;
  const displayTitle = `${parts.weekday} ${parts.monthShort} ${dayWithOrdinal} ${parts.year}`;
  const dateKey = `${parts.year.toString().padStart(4, "0")}-${parts.month
    .toString()
    .padStart(2, "0")}-${parts.day.toString().padStart(2, "0")}`;
  const shortDate = `${parts.month}-${parts.day}-${parts.year}`;

  return {
    noteId: `${DAILY_NOTES_NOTE_ID_PREFIX}${dateKey}`,
    dateKey,
    shortDate,
    displayTitle,
    timezone,
  };
}

export function parseDailyDateInput(query: string): ParsedDailyDateInput | null {
  const normalized = query.trim();
  if (!normalized) {
    return null;
  }

  const mdYWithHyphen = /^(\d{1,2})-(\d{1,2})-(\d{4})$/;
  const mdYWithSlash = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/;
  const yMdWithHyphen = /^(\d{4})-(\d{1,2})-(\d{1,2})$/;

  let parsed: ParsedDailyDateInput | null = null;
  let match = mdYWithHyphen.exec(normalized);
  if (match) {
    const month = Number.parseInt(match[1] ?? "", 10);
    const day = Number.parseInt(match[2] ?? "", 10);
    const year = Number.parseInt(match[3] ?? "", 10);
    parsed = { year, month, day };
  }

  if (!parsed) {
    match = mdYWithSlash.exec(normalized);
    if (match) {
      const month = Number.parseInt(match[1] ?? "", 10);
      const day = Number.parseInt(match[2] ?? "", 10);
      const year = Number.parseInt(match[3] ?? "", 10);
      parsed = { year, month, day };
    }
  }

  if (!parsed) {
    match = yMdWithHyphen.exec(normalized);
    if (match) {
      const year = Number.parseInt(match[1] ?? "", 10);
      const month = Number.parseInt(match[2] ?? "", 10);
      const day = Number.parseInt(match[3] ?? "", 10);
      parsed = { year, month, day };
    }
  }

  if (!parsed || !isValidDateParts(parsed)) {
    return null;
  }

  return parsed;
}

export function toDailyDisplayTitleFromDateInput(query: string): string | null {
  const parsed = parseDailyDateInput(query);
  if (!parsed) {
    return null;
  }

  return formatDailyDisplayTitleFromDate(parsed);
}
