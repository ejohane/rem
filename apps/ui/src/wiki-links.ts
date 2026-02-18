export interface WikiLinkSearchNote {
  id: string;
  title: string;
  updatedAt: string;
  aliases?: string[];
}

export interface WikiTypeaheadMatch {
  leadOffset: number;
  matchingString: string;
  replaceableString: string;
}

export interface CompletedWikiLinkMatch {
  leadOffset: number;
  title: string;
  replaceableString: string;
}

const WIKI_TRIGGER = "[[";
const WIKI_NOTE_HASH_PREFIX = "#/note/";
const MAX_WIKI_QUERY_LENGTH = 160;

export function buildWikiNoteHref(noteId: string): string {
  return `${WIKI_NOTE_HASH_PREFIX}${encodeURIComponent(noteId)}`;
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

export function parseWikiNoteIdFromHref(rawHref: string): string | null {
  const hash = extractHrefHash(rawHref);
  if (!hash.startsWith(WIKI_NOTE_HASH_PREFIX)) {
    return null;
  }

  const encodedNoteId = hash.slice(WIKI_NOTE_HASH_PREFIX.length);
  if (encodedNoteId.length === 0) {
    return null;
  }

  try {
    return decodeURIComponent(encodedNoteId);
  } catch {
    return encodedNoteId;
  }
}

export function normalizeWikiTitle(rawTitle: string): string {
  return rawTitle.replace(/\s+/g, " ").trim();
}

export function extractWikiTypeaheadMatch(text: string): WikiTypeaheadMatch | null {
  const triggerOffset = text.lastIndexOf(WIKI_TRIGGER);
  if (triggerOffset === -1) {
    return null;
  }

  const matchingString = text.slice(triggerOffset + WIKI_TRIGGER.length);
  if (
    matchingString.length > MAX_WIKI_QUERY_LENGTH ||
    matchingString.includes("]") ||
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

export function extractCompletedWikiLinkMatch(text: string): CompletedWikiLinkMatch | null {
  const closingOffset = text.lastIndexOf("]]");
  if (closingOffset === -1 || closingOffset !== text.length - 2) {
    return null;
  }

  const triggerOffset = text.lastIndexOf(WIKI_TRIGGER, closingOffset - 1);
  if (triggerOffset === -1) {
    return null;
  }

  const rawTitle = text.slice(triggerOffset + WIKI_TRIGGER.length, closingOffset);
  if (
    rawTitle.length > MAX_WIKI_QUERY_LENGTH ||
    rawTitle.includes("[") ||
    rawTitle.includes("]") ||
    rawTitle.includes("\n") ||
    rawTitle.includes("\r")
  ) {
    return null;
  }

  const title = normalizeWikiTitle(rawTitle);
  if (title.length === 0) {
    return null;
  }

  return {
    leadOffset: triggerOffset,
    title,
    replaceableString: text.slice(triggerOffset, closingOffset + 2),
  };
}

function normalizeSearchToken(value: string): string {
  return normalizeWikiTitle(value).toLowerCase();
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

export function rankWikiLinkNotes(
  notes: readonly WikiLinkSearchNote[],
  query: string,
  limit = 8,
): WikiLinkSearchNote[] {
  const normalizedQuery = normalizeSearchToken(query);

  if (normalizedQuery.length === 0) {
    return [...notes]
      .sort(
        (left, right) =>
          right.updatedAt.localeCompare(left.updatedAt) || left.title.localeCompare(right.title),
      )
      .slice(0, limit);
  }

  const scored = notes
    .map((note) => {
      const terms = [note.title, note.id, ...(note.aliases ?? [])]
        .map(normalizeSearchToken)
        .filter((token, index, tokens) => token.length > 0 && tokens.indexOf(token) === index);

      const score = terms.reduce((bestScore, term, index) => {
        const candidateScore = scoreCandidate(normalizedQuery, term);
        if (candidateScore < 0) {
          return bestScore;
        }

        const termWeight = index === 0 ? 0 : index === 1 ? -35 : -15;
        return Math.max(bestScore, candidateScore + termWeight);
      }, -1);

      return {
        note,
        score,
      };
    })
    .filter((entry) => entry.score >= 0);

  scored.sort((left, right) => {
    if (left.score !== right.score) {
      return right.score - left.score;
    }

    const updatedAtOrder = right.note.updatedAt.localeCompare(left.note.updatedAt);
    if (updatedAtOrder !== 0) {
      return updatedAtOrder;
    }

    return left.note.title.localeCompare(right.note.title);
  });

  return scored.slice(0, limit).map((entry) => entry.note);
}
