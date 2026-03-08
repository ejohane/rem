import { $createLinkNode } from "@lexical/link";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import {
  $createTextNode,
  $getNodeByKey,
  $getSelection,
  $isElementNode,
  $isRangeSelection,
  $isTextNode,
  COMMAND_PRIORITY_HIGH,
  KEY_ARROW_DOWN_COMMAND,
  KEY_ARROW_UP_COMMAND,
  KEY_ENTER_COMMAND,
  KEY_ESCAPE_COMMAND,
  KEY_TAB_COMMAND,
  type NodeKey,
  type PointType,
  type TextNode,
} from "lexical";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { buildDailyTitleDateAliases } from "./daily-note-search";
import {
  type FloatingMenuState,
  areFloatingMenuStatesEqual,
  buildFloatingMenuPosition,
  scheduleCollapsedCaretMeasurement,
} from "./typeahead-menu";
import {
  type WikiLinkSearchNote,
  buildWikiNoteHref,
  extractCompletedWikiLinkMatch,
  extractWikiTypeaheadMatch,
  normalizeWikiTitle,
  parseWikiNoteIdFromHref,
  rankWikiLinkNotes,
} from "./wiki-links";

export interface WikiLinkNoteSummary {
  id: string;
  title: string;
  updatedAt: string;
}

export interface WikiLinksPluginProps {
  notes: WikiLinkNoteSummary[];
  onOpenNote: (noteId: string) => Promise<void> | void;
  onCreateNote: (title: string) => Promise<WikiLinkNoteSummary | null>;
}

type WikiLinkOptionMode = "existing" | "create";

type WikiLinkOption = {
  mode: WikiLinkOptionMode;
  label: string;
  noteId: string | null;
  helper: string;
  key: string;
};

type WikiMenuState = FloatingMenuState & {
  anchorKey: NodeKey;
};

type ReplacementTarget = {
  anchorKey: NodeKey;
  anchorOffset: number;
  replaceableString: string;
};

function resolveSimpleTextAnchor(anchor: PointType): { node: TextNode; offset: number } | null {
  const anchorNode = anchor.getNode();
  if ($isTextNode(anchorNode) && anchorNode.isSimpleText()) {
    return {
      node: anchorNode,
      offset: anchor.offset,
    };
  }

  if (anchor.type !== "element" || !$isElementNode(anchorNode)) {
    return null;
  }

  const candidateIndexes = [anchor.offset, anchor.offset - 1];
  for (const candidateIndex of candidateIndexes) {
    if (candidateIndex < 0) {
      continue;
    }

    const candidateNode = anchorNode.getDescendantByIndex<TextNode>(candidateIndex);
    if (!$isTextNode(candidateNode) || !candidateNode.isSimpleText()) {
      continue;
    }

    return {
      node: candidateNode,
      offset: candidateIndex < anchor.offset ? candidateNode.getTextContent().length : 0,
    };
  }

  const lastDescendant = anchorNode.getLastDescendant<TextNode>();
  if (!$isTextNode(lastDescendant) || !lastDescendant.isSimpleText()) {
    return null;
  }

  return {
    node: lastDescendant,
    offset: lastDescendant.getTextContent().length,
  };
}

function WikiLinkTypeaheadPlugin(props: {
  notes: WikiLinkNoteSummary[];
  onCreateNote: WikiLinksPluginProps["onCreateNote"];
}): React.JSX.Element {
  const [editor] = useLexicalComposerContext();
  const [menuState, setMenuState] = useState<WikiMenuState | null>(null);
  const [highlightedIndex, setHighlightedIndex] = useState(0);
  const menuStateRef = useRef<WikiMenuState | null>(null);
  const pendingCompletedMatchRef = useRef<string | null>(null);
  const pendingMeasurementRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    menuStateRef.current = menuState;
  }, [menuState]);

  useEffect(() => {
    return () => {
      pendingMeasurementRef.current?.();
    };
  }, []);

  const searchableNotes = useMemo<WikiLinkSearchNote[]>(
    () =>
      props.notes.map((note) => ({
        ...note,
        aliases: buildDailyTitleDateAliases(note.title),
      })),
    [props.notes],
  );

  const options = useMemo<WikiLinkOption[]>(() => {
    if (menuState === null) {
      return [];
    }

    const ranked: WikiLinkOption[] = rankWikiLinkNotes(searchableNotes, menuState.query, 8).map(
      (note) => ({
        mode: "existing",
        label: note.title,
        noteId: note.id,
        helper: `Open #${note.id.slice(0, 8)}`,
        key: `existing:${note.id}`,
      }),
    );

    const normalizedTitle = normalizeWikiTitle(menuState.query);
    const hasExactMatch =
      normalizedTitle.length > 0 &&
      searchableNotes.some(
        (note) => normalizeWikiTitle(note.title).toLowerCase() === normalizedTitle.toLowerCase(),
      );

    if (normalizedTitle.length > 0 && !hasExactMatch) {
      ranked.unshift({
        mode: "create",
        label: normalizedTitle,
        noteId: null,
        helper: "Create new note",
        key: `create:${normalizedTitle.toLowerCase()}`,
      });
    }

    return ranked.slice(0, 8);
  }, [menuState, searchableNotes]);

  useEffect(() => {
    setHighlightedIndex((current) => {
      if (options.length === 0) {
        return 0;
      }

      return Math.min(current, options.length - 1);
    });
  }, [options.length]);

  const closeMenu = useCallback((): void => {
    setMenuState(null);
    setHighlightedIndex(0);
  }, []);

  const insertWikiLink = useCallback(
    (target: ReplacementTarget, note: WikiLinkNoteSummary): void => {
      editor.update(() => {
        const node = $getNodeByKey(target.anchorKey);
        if (!$isTextNode(node) || !node.isSimpleText()) {
          return;
        }

        const textContent = node.getTextContent();
        const boundedAnchorOffset = Math.min(target.anchorOffset, textContent.length);
        const startOffset = boundedAnchorOffset - target.replaceableString.length;
        if (startOffset < 0) {
          return;
        }

        if (textContent.slice(startOffset, boundedAnchorOffset) !== target.replaceableString) {
          return;
        }

        let matchedNode: TextNode | null = null;
        if (startOffset === 0) {
          [matchedNode] = node.splitText(boundedAnchorOffset);
        } else {
          [, matchedNode] = node.splitText(startOffset, boundedAnchorOffset);
        }

        if (!matchedNode) {
          return;
        }

        const linkNode = $createLinkNode(buildWikiNoteHref(note.id));
        linkNode.append($createTextNode(note.title));
        matchedNode.replace(linkNode);
        linkNode.selectEnd();
      });
    },
    [editor],
  );

  const resolveNoteByTitle = useCallback(
    async (rawTitle: string): Promise<WikiLinkNoteSummary | null> => {
      const normalizedTitle = normalizeWikiTitle(rawTitle);
      if (!normalizedTitle) {
        return null;
      }

      const existingNote = props.notes.find(
        (note) => normalizeWikiTitle(note.title).toLowerCase() === normalizedTitle.toLowerCase(),
      );
      if (existingNote) {
        return existingNote;
      }

      return props.onCreateNote(normalizedTitle);
    },
    [props.notes, props.onCreateNote],
  );

  const applyOption = useCallback(
    (option: WikiLinkOption): void => {
      const activeMenuState = menuStateRef.current;
      if (!activeMenuState) {
        return;
      }

      closeMenu();

      const replacementTarget: ReplacementTarget = {
        anchorKey: activeMenuState.anchorKey,
        anchorOffset: activeMenuState.anchorOffset,
        replaceableString: activeMenuState.replaceableString,
      };

      if (option.mode === "existing" && option.noteId) {
        const selectedNote = props.notes.find((note) => note.id === option.noteId);
        if (selectedNote) {
          insertWikiLink(replacementTarget, selectedNote);
        }
        return;
      }

      void resolveNoteByTitle(option.label).then((note) => {
        if (!note) {
          return;
        }
        insertWikiLink(replacementTarget, note);
      });
    },
    [closeMenu, insertWikiLink, props.notes, resolveNoteByTitle],
  );

  const confirmHighlightedOption = useCallback((): boolean => {
    if (!menuStateRef.current || options.length === 0) {
      return false;
    }

    const optionIndex = Math.max(0, Math.min(highlightedIndex, options.length - 1));
    const option = options[optionIndex];
    if (!option) {
      return false;
    }

    applyOption(option);
    return true;
  }, [applyOption, highlightedIndex, options]);

  useEffect(() => {
    return editor.registerUpdateListener(({ editorState }) => {
      editorState.read(() => {
        const selection = $getSelection();
        if (!$isRangeSelection(selection) || !selection.isCollapsed()) {
          pendingMeasurementRef.current?.();
          pendingMeasurementRef.current = null;
          setMenuState((current) => (current === null ? current : null));
          return;
        }

        const anchor = selection.anchor;
        const resolvedAnchor = resolveSimpleTextAnchor(anchor);
        if (!resolvedAnchor) {
          pendingMeasurementRef.current?.();
          pendingMeasurementRef.current = null;
          setMenuState((current) => (current === null ? current : null));
          return;
        }

        const textUpToCaret = resolvedAnchor.node.getTextContent().slice(0, resolvedAnchor.offset);
        const completedMatch = extractCompletedWikiLinkMatch(textUpToCaret);
        if (completedMatch) {
          const signature = `${resolvedAnchor.node.getKey()}:${resolvedAnchor.offset}:${completedMatch.replaceableString}`;
          if (pendingCompletedMatchRef.current === signature) {
            return;
          }

          pendingCompletedMatchRef.current = signature;
          pendingMeasurementRef.current?.();
          pendingMeasurementRef.current = null;
          setMenuState((current) => (current === null ? current : null));

          const replacementTarget: ReplacementTarget = {
            anchorKey: resolvedAnchor.node.getKey(),
            anchorOffset: resolvedAnchor.offset,
            replaceableString: completedMatch.replaceableString,
          };

          void resolveNoteByTitle(completedMatch.title)
            .then((note) => {
              if (!note) {
                return;
              }
              insertWikiLink(replacementTarget, note);
            })
            .finally(() => {
              if (pendingCompletedMatchRef.current === signature) {
                pendingCompletedMatchRef.current = null;
              }
            });

          return;
        }

        const typeaheadMatch = extractWikiTypeaheadMatch(textUpToCaret);
        if (!typeaheadMatch) {
          pendingMeasurementRef.current?.();
          pendingMeasurementRef.current = null;
          setMenuState((current) => (current === null ? current : null));
          return;
        }

        if (typeof window === "undefined") {
          pendingMeasurementRef.current?.();
          pendingMeasurementRef.current = null;
          setMenuState((current) => (current === null ? current : null));
          return;
        }

        const nextMenuState = {
          anchorKey: resolvedAnchor.node.getKey(),
          anchorOffset: resolvedAnchor.offset,
          query: typeaheadMatch.matchingString,
          replaceableString: typeaheadMatch.replaceableString,
        };
        pendingMeasurementRef.current?.();
        pendingMeasurementRef.current = scheduleCollapsedCaretMeasurement(window, (rect) => {
          pendingMeasurementRef.current = null;
          if (!rect) {
            setMenuState((current) => (current === null ? current : null));
            return;
          }

          const measuredMenuState: WikiMenuState = {
            ...nextMenuState,
            rect,
          };

          setMenuState((current) => {
            if (areFloatingMenuStatesEqual(current, measuredMenuState)) {
              return current;
            }

            if (current?.query !== measuredMenuState.query) {
              setHighlightedIndex(0);
            }

            return measuredMenuState;
          });
        });
      });
    });
  }, [editor, insertWikiLink, resolveNoteByTitle]);

  const isMenuOpen = menuState !== null && options.length > 0;

  useEffect(() => {
    return editor.registerCommand(
      KEY_ARROW_DOWN_COMMAND,
      (event) => {
        if (!isMenuOpen) {
          return false;
        }

        event.preventDefault();
        event.stopPropagation();
        setHighlightedIndex((current) => {
          if (options.length === 0) {
            return 0;
          }
          return (current + 1) % options.length;
        });
        return true;
      },
      COMMAND_PRIORITY_HIGH,
    );
  }, [editor, isMenuOpen, options.length]);

  useEffect(() => {
    return editor.registerCommand(
      KEY_ARROW_UP_COMMAND,
      (event) => {
        if (!isMenuOpen) {
          return false;
        }

        event.preventDefault();
        event.stopPropagation();
        setHighlightedIndex((current) => {
          if (options.length === 0) {
            return 0;
          }
          return (current - 1 + options.length) % options.length;
        });
        return true;
      },
      COMMAND_PRIORITY_HIGH,
    );
  }, [editor, isMenuOpen, options.length]);

  useEffect(() => {
    return editor.registerCommand(
      KEY_ENTER_COMMAND,
      (event) => {
        if (!isMenuOpen) {
          return false;
        }

        if (event !== null) {
          event.preventDefault();
          event.stopPropagation();
        }
        return confirmHighlightedOption();
      },
      COMMAND_PRIORITY_HIGH,
    );
  }, [confirmHighlightedOption, editor, isMenuOpen]);

  useEffect(() => {
    return editor.registerCommand(
      KEY_TAB_COMMAND,
      (event) => {
        if (!isMenuOpen) {
          return false;
        }

        event.preventDefault();
        event.stopPropagation();
        return confirmHighlightedOption();
      },
      COMMAND_PRIORITY_HIGH,
    );
  }, [confirmHighlightedOption, editor, isMenuOpen]);

  useEffect(() => {
    return editor.registerCommand(
      KEY_ESCAPE_COMMAND,
      (event) => {
        if (!isMenuOpen) {
          return false;
        }

        event.preventDefault();
        event.stopPropagation();
        closeMenu();
        return true;
      },
      COMMAND_PRIORITY_HIGH,
    );
  }, [closeMenu, editor, isMenuOpen]);

  const menuPosition = useMemo(() => {
    if (menuState === null || typeof window === "undefined") {
      return null;
    }

    return buildFloatingMenuPosition(menuState.rect, {
      width: window.innerWidth,
      height: window.innerHeight,
    });
  }, [menuState]);

  if (!isMenuOpen || menuPosition === null || typeof document === "undefined") {
    return <></>;
  }

  return createPortal(
    <div className="wiki-link-menu wiki-link-menu-floating" style={menuPosition}>
      <ul>
        {options.map((option, index) => (
          <li key={option.key}>
            <button
              type="button"
              className={`wiki-link-menu-item ${highlightedIndex === index ? "wiki-link-menu-item-active" : ""}`}
              onMouseDown={(event) => {
                event.preventDefault();
              }}
              onMouseEnter={() => {
                setHighlightedIndex(index);
              }}
              onClick={() => {
                setHighlightedIndex(index);
                applyOption(option);
              }}
            >
              <span className="wiki-link-menu-main">{option.label}</span>
              <span className="wiki-link-menu-meta">{option.helper}</span>
            </button>
          </li>
        ))}
      </ul>
    </div>,
    document.body,
  );
}

function WikiLinkClickPlugin(props: {
  onOpenNote: WikiLinksPluginProps["onOpenNote"];
}): null {
  const [editor] = useLexicalComposerContext();

  const handleClick = useCallback(
    (event: MouseEvent): void => {
      if (!(event.target instanceof HTMLElement)) {
        return;
      }

      const anchor = event.target.closest("a");
      if (!(anchor instanceof HTMLAnchorElement)) {
        return;
      }

      const noteId = parseWikiNoteIdFromHref(anchor.getAttribute("href") ?? anchor.href);
      if (!noteId) {
        return;
      }

      event.preventDefault();
      event.stopPropagation();
      void props.onOpenNote(noteId);
    },
    [props.onOpenNote],
  );

  useEffect(() => {
    return editor.registerRootListener((rootElement, prevRootElement) => {
      prevRootElement?.removeEventListener("click", handleClick);
      rootElement?.addEventListener("click", handleClick);
    });
  }, [editor, handleClick]);

  return null;
}

export function WikiLinksPlugin(props: WikiLinksPluginProps): React.JSX.Element {
  return (
    <>
      <WikiLinkTypeaheadPlugin notes={props.notes} onCreateNote={props.onCreateNote} />
      <WikiLinkClickPlugin onOpenNote={props.onOpenNote} />
    </>
  );
}
