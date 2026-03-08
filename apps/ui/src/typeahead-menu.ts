export type FloatingMenuRect = {
  left: number;
  top: number;
  height: number;
};

export type FloatingMenuState = {
  anchorKey: string;
  anchorOffset: number;
  query: string;
  replaceableString: string;
  rect: FloatingMenuRect;
};

export interface CollapsedSelectionRangeLike {
  cloneRange(): CollapsedSelectionRangeLike;
  collapse(toStart: boolean): void;
  getBoundingClientRect(): FloatingMenuRect;
}

export interface CollapsedSelectionLike {
  rangeCount: number;
  isCollapsed: boolean;
  getRangeAt(index: number): CollapsedSelectionRangeLike;
}

export interface CaretMeasurementWindowLike {
  getSelection(): CollapsedSelectionLike | null;
  requestAnimationFrame(callback: FrameRequestCallback): number;
  cancelAnimationFrame(handle: number): void;
}

export function areFloatingMenuStatesEqual(
  left: FloatingMenuState | null,
  right: FloatingMenuState | null,
): boolean {
  if (left === right) {
    return true;
  }

  if (left === null || right === null) {
    return false;
  }

  return (
    left.anchorKey === right.anchorKey &&
    left.anchorOffset === right.anchorOffset &&
    left.query === right.query &&
    left.replaceableString === right.replaceableString &&
    left.rect.left === right.rect.left &&
    left.rect.top === right.rect.top &&
    left.rect.height === right.rect.height
  );
}

export function buildFloatingMenuPosition(
  rect: FloatingMenuRect,
  viewport: {
    width: number;
    height: number;
  },
  options?: {
    margin?: number;
    menuWidth?: number;
    maxBottomInset?: number;
  },
): {
  left: string;
  top: string;
} {
  const margin = options?.margin ?? 10;
  const menuWidth = options?.menuWidth ?? 340;
  const maxBottomInset = options?.maxBottomInset ?? 220;

  const nextLeft = Math.max(
    margin,
    Math.min(rect.left, Math.max(margin, viewport.width - menuWidth - margin)),
  );
  const nextTop = Math.max(
    margin,
    Math.min(rect.top + rect.height + 8, viewport.height - maxBottomInset),
  );

  return {
    left: `${nextLeft}px`,
    top: `${nextTop}px`,
  };
}

export function scheduleCollapsedCaretMeasurement(
  targetWindow: CaretMeasurementWindowLike,
  callback: (rect: FloatingMenuRect | null) => void,
): () => void {
  let cancelled = false;
  const frameHandle = targetWindow.requestAnimationFrame(() => {
    if (cancelled) {
      return;
    }

    const domSelection = targetWindow.getSelection();
    if (!domSelection || domSelection.rangeCount === 0 || !domSelection.isCollapsed) {
      callback(null);
      return;
    }

    const range = domSelection.getRangeAt(0).cloneRange();
    range.collapse(true);
    const caretRect = range.getBoundingClientRect();
    callback({
      left: caretRect.left,
      top: caretRect.top,
      height: caretRect.height || 18,
    });
  });

  return () => {
    cancelled = true;
    targetWindow.cancelAnimationFrame(frameHandle);
  };
}
