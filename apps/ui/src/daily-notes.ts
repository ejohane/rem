export type DailyNoteRequestPayload = {
  timezone?: string;
};

export function resolveClientTimeZone(): string | undefined {
  if (typeof window === "undefined") {
    return undefined;
  }

  const timezone = window.Intl.DateTimeFormat().resolvedOptions().timeZone;
  if (typeof timezone !== "string") {
    return undefined;
  }

  const trimmed = timezone.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function buildDailyNoteRequestPayload(
  timezone: string | undefined,
): DailyNoteRequestPayload {
  if (!timezone) {
    return {};
  }

  const trimmed = timezone.trim();
  return trimmed.length > 0 ? { timezone: trimmed } : {};
}
