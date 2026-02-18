export function matchesCommandQuery(query: string, aliases: readonly string[]): boolean {
  const normalizedQuery = query.trim().toLowerCase();
  if (normalizedQuery.length === 0) {
    return true;
  }

  return aliases.some((alias) => alias.toLowerCase().includes(normalizedQuery));
}
