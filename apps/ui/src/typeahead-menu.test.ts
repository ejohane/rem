import { describe, expect, test } from "bun:test";

import {
  type CaretMeasurementWindowLike,
  type CollapsedSelectionLike,
  type FloatingMenuState,
  areFloatingMenuStatesEqual,
  buildFloatingMenuPosition,
  scheduleCollapsedCaretMeasurement,
} from "./typeahead-menu";

function makeMenuState(overrides?: Partial<FloatingMenuState>): FloatingMenuState {
  return {
    anchorKey: "node-1",
    anchorOffset: 4,
    query: "ali",
    replaceableString: "@ali",
    rect: {
      left: 120,
      top: 48,
      height: 20,
    },
    ...overrides,
  };
}

function makeSelection(input?: {
  collapsed?: boolean;
  left?: number;
  top?: number;
  height?: number;
}): CollapsedSelectionLike {
  return {
    rangeCount: 1,
    isCollapsed: input?.collapsed ?? true,
    getRangeAt: () => ({
      cloneRange() {
        return this;
      },
      collapse() {},
      getBoundingClientRect: () => ({
        left: input?.left ?? 200,
        top: input?.top ?? 80,
        height: input?.height ?? 0,
      }),
    }),
  };
}

function makeWindow(selection: CollapsedSelectionLike | null): CaretMeasurementWindowLike & {
  flush(): void;
  cancelledFrames: number[];
} {
  let callback: FrameRequestCallback | null = null;
  let nextHandle = 1;
  const cancelledFrames: number[] = [];

  return {
    getSelection: () => selection,
    requestAnimationFrame: (nextCallback) => {
      callback = nextCallback;
      return nextHandle++;
    },
    cancelAnimationFrame: (handle) => {
      cancelledFrames.push(handle);
      callback = null;
    },
    flush() {
      callback?.(0);
    },
    cancelledFrames,
  };
}

describe("typeahead menu helpers", () => {
  test("compares floating menu states deterministically", () => {
    const left = makeMenuState();
    const right = makeMenuState();

    expect(areFloatingMenuStatesEqual(left, right)).toBeTrue();
    expect(
      areFloatingMenuStatesEqual(left, makeMenuState({ rect: { left: 121, top: 48, height: 20 } })),
    ).toBeFalse();
    expect(areFloatingMenuStatesEqual(left, null)).toBeFalse();
  });

  test("builds a floating menu position within the viewport", () => {
    expect(
      buildFloatingMenuPosition(
        {
          left: 620,
          top: 500,
          height: 24,
        },
        {
          width: 800,
          height: 640,
        },
      ),
    ).toEqual({
      left: "450px",
      top: "420px",
    });
  });

  test("measures the collapsed caret rect on the next animation frame", () => {
    const targetWindow = makeWindow(makeSelection({ left: 240, top: 96, height: 0 }));
    const measured: Array<{ left: number; top: number; height: number } | null> = [];

    scheduleCollapsedCaretMeasurement(targetWindow, (rect) => {
      measured.push(rect);
    });
    targetWindow.flush();

    expect(measured).toEqual([
      {
        left: 240,
        top: 96,
        height: 18,
      },
    ]);
  });

  test("returns null when the DOM selection is not collapsed", () => {
    const targetWindow = makeWindow(makeSelection({ collapsed: false }));
    const measured: Array<{ left: number; top: number; height: number } | null> = [];

    scheduleCollapsedCaretMeasurement(targetWindow, (rect) => {
      measured.push(rect);
    });
    targetWindow.flush();

    expect(measured).toEqual([null]);
  });

  test("cancels a scheduled measurement before it runs", () => {
    const targetWindow = makeWindow(makeSelection());
    const measured: Array<{ left: number; top: number; height: number } | null> = [];

    const cancel = scheduleCollapsedCaretMeasurement(targetWindow, (rect) => {
      measured.push(rect);
    });
    cancel();
    targetWindow.flush();

    expect(targetWindow.cancelledFrames).toEqual([1]);
    expect(measured).toEqual([]);
  });
});
