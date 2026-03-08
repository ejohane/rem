export interface EntityReference {
  namespace: string;
  entityType: string;
  entityId: string;
}

export interface EntityMentionTypeaheadMatch {
  leadOffset: number;
  matchingString: string;
  replaceableString: string;
}

export interface PersonMentionCandidate {
  handle: string;
  displayName: string;
  aliases?: string[];
  updatedAt: string;
  snippet?: string;
  team?: string | null;
}

const ENTITY_HASH_PREFIX = "#/entity/";
const MAX_PERSON_QUERY_LENGTH = 80;
const PERSON_HANDLE_ALLOWED = /^[a-z0-9._-]+$/;
const PERSON_QUERY_ALLOWED = /^[a-zA-Z0-9._-]*$/;
const MENTION_BOUNDARY_PATTERN = /[\s([{"'`<>{}\])!?.,;:/\\-]/;

export function buildEntityHref(reference: EntityReference): string {
  return `${ENTITY_HASH_PREFIX}${encodeURIComponent(reference.namespace)}/${encodeURIComponent(reference.entityType)}/${encodeURIComponent(reference.entityId)}`;
}

function extractHrefHash(rawHref: string): string {
  if (rawHref.startsWith("#")) {
    return rawHref;
  }

  try {
    return new URL(rawHref, "http://localhost").hash;
  } catch {
    const hashStart = rawHref.indexOf("#");
    return hashStart === -1 ? "" : rawHref.slice(hashStart);
  }
}

export function parseEntityReferenceFromHref(rawHref: string): EntityReference | null {
  const hash = extractHrefHash(rawHref);
  if (!hash.startsWith(ENTITY_HASH_PREFIX)) {
    return null;
  }

  const parts = hash
    .slice(ENTITY_HASH_PREFIX.length)
    .split("/")
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0);
  if (parts.length !== 3) {
    return null;
  }

  try {
    return {
      namespace: decodeURIComponent(parts[0] ?? ""),
      entityType: decodeURIComponent(parts[1] ?? ""),
      entityId: decodeURIComponent(parts[2] ?? ""),
    };
  } catch {
    return {
      namespace: parts[0] ?? "",
      entityType: parts[1] ?? "",
      entityId: parts[2] ?? "",
    };
  }
}

export function normalizePersonHandle(rawValue: string): string {
  return rawValue
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-\s]+/g, "")
    .replace(/\s+/g, "-")
    .replace(/[-_.]{2,}/g, "-")
    .replace(/^[-_.]+|[-_.]+$/g, "");
}

export function isValidPersonHandle(value: string): boolean {
  return value.length > 0 && PERSON_HANDLE_ALLOWED.test(value);
}

export function buildPersonMentionText(handle: string): string {
  return `@${handle}`;
}

export function extractPersonMentionTypeaheadMatch(
  text: string,
): EntityMentionTypeaheadMatch | null {
  const triggerOffset = text.lastIndexOf("@");
  if (triggerOffset === -1) {
    return null;
  }

  const previousCharacter = triggerOffset === 0 ? "" : (text[triggerOffset - 1] ?? "");
  if (previousCharacter && !MENTION_BOUNDARY_PATTERN.test(previousCharacter)) {
    return null;
  }

  const matchingString = text.slice(triggerOffset + 1);
  if (
    matchingString.length > MAX_PERSON_QUERY_LENGTH ||
    !PERSON_QUERY_ALLOWED.test(matchingString) ||
    matchingString.includes("\n") ||
    matchingString.includes("\r")
  ) {
    return null;
  }

  return {
    leadOffset: triggerOffset,
    matchingString,
    replaceableString: text.slice(triggerOffset),
  };
}

function normalizeSearchToken(value: string): string {
  return value.replace(/\s+/g, " ").trim().toLowerCase();
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function getSubsequenceGapPenalty(query: string, candidate: string): number | null {
  let queryIndex = 0;
  let previousMatchIndex = -1;
  let gapPenalty = 0;

  for (let index = 0; index < candidate.length && queryIndex < query.length; index += 1) {
    if (candidate[index] !== query[queryIndex]) {
      continue;
    }

    if (previousMatchIndex >= 0) {
      gapPenalty += Math.max(0, index - previousMatchIndex - 1);
    }
    previousMatchIndex = index;
    queryIndex += 1;
  }

  if (queryIndex !== query.length) {
    return null;
  }

  return gapPenalty;
}

function scoreCandidate(query: string, candidate: string): number {
  if (!query || !candidate) {
    return -1;
  }

  if (candidate === query) {
    return 1000;
  }

  if (candidate.startsWith(query)) {
    return 850 - Math.min(200, candidate.length - query.length);
  }

  const boundaryMatchIndex = candidate.search(new RegExp(`\\b${escapeRegExp(query)}`));
  if (boundaryMatchIndex >= 0) {
    return 730 - Math.min(240, boundaryMatchIndex * 6);
  }

  const includesIndex = candidate.indexOf(query);
  if (includesIndex >= 0) {
    return 620 - Math.min(220, includesIndex * 4);
  }

  const subsequenceGapPenalty = getSubsequenceGapPenalty(query, candidate);
  if (subsequenceGapPenalty !== null) {
    return 420 - Math.min(320, subsequenceGapPenalty * 8);
  }

  return -1;
}

export function rankPersonMentionCandidates(
  candidates: readonly PersonMentionCandidate[],
  rawQuery: string,
  limit = 8,
): PersonMentionCandidate[] {
  const normalizedQuery = normalizeSearchToken(rawQuery);
  if (normalizedQuery.length === 0) {
    return [...candidates]
      .sort(
        (left, right) =>
          right.updatedAt.localeCompare(left.updatedAt) || left.handle.localeCompare(right.handle),
      )
      .slice(0, limit);
  }

  const scored = candidates
    .map((candidate) => {
      const searchTerms = [
        candidate.handle,
        candidate.displayName,
        ...(candidate.aliases ?? []),
        candidate.team ?? "",
      ]
        .map(normalizeSearchToken)
        .filter((token, index, tokens) => token.length > 0 && tokens.indexOf(token) === index);

      const score = searchTerms.reduce((bestScore, term, index) => {
        const candidateScore = scoreCandidate(normalizedQuery, term);
        if (candidateScore < 0) {
          return bestScore;
        }

        const termWeight = index === 0 ? 0 : index === 1 ? -15 : -30;
        return Math.max(bestScore, candidateScore + termWeight);
      }, -1);

      return {
        candidate,
        score,
      };
    })
    .filter((entry) => entry.score >= 0);

  scored.sort((left, right) => {
    if (left.score !== right.score) {
      return right.score - left.score;
    }

    return (
      right.candidate.updatedAt.localeCompare(left.candidate.updatedAt) ||
      left.candidate.handle.localeCompare(right.candidate.handle)
    );
  });

  return scored.slice(0, limit).map((entry) => entry.candidate);
}
