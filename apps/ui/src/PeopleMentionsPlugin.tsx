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

import {
  type EntityReference,
  type PersonMentionCandidate,
  buildEntityHref,
  buildPersonMentionText,
  extractPersonMentionTypeaheadMatch,
  normalizePersonHandle,
  parseEntityReferenceFromHref,
  rankPersonMentionCandidates,
} from "./entity-links";
import {
  type FloatingMenuState,
  areFloatingMenuStatesEqual,
  buildFloatingMenuPosition,
  scheduleCollapsedCaretMeasurement,
} from "./typeahead-menu";

export interface PeopleMentionsPluginProps {
  onSearchPeople: (query: string) => Promise<PersonMentionCandidate[]>;
  onEnsurePerson: (handle: string) => Promise<PersonMentionCandidate | null>;
  onOpenPerson: (reference: EntityReference) => Promise<void> | void;
}

type PeopleMentionOption =
  | {
      mode: "existing";
      key: string;
      candidate: PersonMentionCandidate;
      label: string;
      helper: string;
    }
  | {
      mode: "create";
      key: string;
      handle: string;
      label: string;
      helper: string;
    };

type MentionMenuState = FloatingMenuState & {
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

function buildPersonOptionHelper(candidate: PersonMentionCandidate): string {
  const parts = [candidate.displayName.trim(), candidate.team?.trim() ?? ""].filter(
    (value) => value.length > 0,
  );
  if (parts.length > 0) {
    return parts.join(" · ");
  }

  return candidate.snippet?.trim() || "Open person";
}

function PeopleMentionTypeaheadPlugin(
  props: Pick<PeopleMentionsPluginProps, "onSearchPeople" | "onEnsurePerson">,
): React.JSX.Element {
  const [editor] = useLexicalComposerContext();
  const [menuState, setMenuState] = useState<MentionMenuState | null>(null);
  const [highlightedIndex, setHighlightedIndex] = useState(0);
  const [searchState, setSearchState] = useState<{
    query: string;
    candidates: PersonMentionCandidate[];
    loading: boolean;
  }>({
    query: "",
    candidates: [],
    loading: false,
  });
  const menuStateRef = useRef<MentionMenuState | null>(null);
  const pendingMeasurementRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    menuStateRef.current = menuState;
  }, [menuState]);

  useEffect(() => {
    return () => {
      pendingMeasurementRef.current?.();
    };
  }, []);

  useEffect(() => {
    const query = menuState?.query ?? "";
    let cancelled = false;

    if (menuState === null) {
      setSearchState({
        query: "",
        candidates: [],
        loading: false,
      });
      return;
    }

    setSearchState((current) => ({
      query,
      candidates: current.query === query ? current.candidates : [],
      loading: true,
    }));

    void props.onSearchPeople(query).then((candidates) => {
      if (cancelled) {
        return;
      }

      setSearchState({
        query,
        candidates: rankPersonMentionCandidates(candidates, query, 8),
        loading: false,
      });
    });

    return () => {
      cancelled = true;
    };
  }, [menuState, props]);

  const options = useMemo<PeopleMentionOption[]>(() => {
    if (menuState === null) {
      return [];
    }

    const normalizedHandle = normalizePersonHandle(menuState.query);
    const ranked = searchState.query === menuState.query ? searchState.candidates : [];
    const nextOptions: PeopleMentionOption[] = ranked.map((candidate) => ({
      mode: "existing" as const,
      key: `existing:${candidate.handle}`,
      candidate,
      label: buildPersonMentionText(candidate.handle),
      helper: buildPersonOptionHelper(candidate),
    }));
    const hasExactMatch =
      normalizedHandle.length > 0 &&
      ranked.some((candidate) => candidate.handle.toLowerCase() === normalizedHandle);

    if (normalizedHandle.length > 0 && !hasExactMatch) {
      nextOptions.unshift({
        mode: "create",
        key: `create:${normalizedHandle}`,
        handle: normalizedHandle,
        label: buildPersonMentionText(normalizedHandle),
        helper: `Create person ${buildPersonMentionText(normalizedHandle)}`,
      });
    }

    return nextOptions.slice(0, 8);
  }, [menuState, searchState]);

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

  const insertMention = useCallback(
    (target: ReplacementTarget, candidate: PersonMentionCandidate): void => {
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

        const linkNode = $createLinkNode(
          buildEntityHref({
            namespace: "people",
            entityType: "person",
            entityId: candidate.handle,
          }),
        );
        linkNode.append($createTextNode(buildPersonMentionText(candidate.handle)));
        matchedNode.replace(linkNode);
        linkNode.selectEnd();
      });
    },
    [editor],
  );

  const applyOption = useCallback(
    (option: PeopleMentionOption): void => {
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

      if (option.mode === "existing") {
        insertMention(replacementTarget, option.candidate);
        return;
      }

      void props.onEnsurePerson(option.handle).then((candidate) => {
        if (!candidate) {
          return;
        }

        insertMention(replacementTarget, candidate);
      });
    },
    [closeMenu, insertMention, props],
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
        const typeaheadMatch = extractPersonMentionTypeaheadMatch(textUpToCaret);
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

          const measuredMenuState: MentionMenuState = {
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
  }, [editor]);

  const isMenuOpen = menuState !== null && (options.length > 0 || searchState.loading);

  useEffect(() => {
    return editor.registerCommand(
      KEY_ARROW_DOWN_COMMAND,
      (event) => {
        if (!isMenuOpen || options.length === 0) {
          return false;
        }

        event.preventDefault();
        event.stopPropagation();
        setHighlightedIndex((current) => (current + 1) % options.length);
        return true;
      },
      COMMAND_PRIORITY_HIGH,
    );
  }, [editor, isMenuOpen, options.length]);

  useEffect(() => {
    return editor.registerCommand(
      KEY_ARROW_UP_COMMAND,
      (event) => {
        if (!isMenuOpen || options.length === 0) {
          return false;
        }

        event.preventDefault();
        event.stopPropagation();
        setHighlightedIndex((current) => (current - 1 + options.length) % options.length);
        return true;
      },
      COMMAND_PRIORITY_HIGH,
    );
  }, [editor, isMenuOpen, options.length]);

  useEffect(() => {
    return editor.registerCommand(
      KEY_ENTER_COMMAND,
      (event) => {
        if (!isMenuOpen || options.length === 0) {
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
  }, [confirmHighlightedOption, editor, isMenuOpen, options.length]);

  useEffect(() => {
    return editor.registerCommand(
      KEY_TAB_COMMAND,
      (event) => {
        if (!isMenuOpen || options.length === 0) {
          return false;
        }

        event.preventDefault();
        event.stopPropagation();
        return confirmHighlightedOption();
      },
      COMMAND_PRIORITY_HIGH,
    );
  }, [confirmHighlightedOption, editor, isMenuOpen, options.length]);

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
    <div
      className="wiki-link-menu wiki-link-menu-floating person-mention-menu"
      style={menuPosition}
    >
      <ul>
        {searchState.loading && options.length === 0 ? (
          <li>
            <div className="wiki-link-menu-item wiki-link-menu-item-static">
              <span className="wiki-link-menu-main">Searching people…</span>
              <span className="wiki-link-menu-meta">Looking up handles and aliases</span>
            </div>
          </li>
        ) : (
          options.map((option, index) => (
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
          ))
        )}
      </ul>
    </div>,
    document.body,
  );
}

function PeopleMentionClickPlugin(props: Pick<PeopleMentionsPluginProps, "onOpenPerson">): null {
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

      const reference = parseEntityReferenceFromHref(anchor.getAttribute("href") ?? anchor.href);
      if (!reference || reference.namespace !== "people" || reference.entityType !== "person") {
        return;
      }

      event.preventDefault();
      event.stopPropagation();
      void props.onOpenPerson(reference);
    },
    [props.onOpenPerson],
  );

  useEffect(() => {
    return editor.registerRootListener((rootElement, prevRootElement) => {
      prevRootElement?.removeEventListener("click", handleClick);
      rootElement?.addEventListener("click", handleClick);
    });
  }, [editor, handleClick]);

  return null;
}

export function PeopleMentionsPlugin(props: PeopleMentionsPluginProps): React.JSX.Element {
  return (
    <>
      <PeopleMentionTypeaheadPlugin
        onSearchPeople={props.onSearchPeople}
        onEnsurePerson={props.onEnsurePerson}
      />
      <PeopleMentionClickPlugin onOpenPerson={props.onOpenPerson} />
    </>
  );
}
