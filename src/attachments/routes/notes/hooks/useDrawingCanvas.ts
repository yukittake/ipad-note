// Canvas全体のGestureを管理するHook。
/* eslint-disable react-hooks/immutability, react-hooks/refs, react-hooks/set-state-in-effect */
import { useEffect, useRef, useState } from 'react';
import { Gesture, PointerType } from 'react-native-gesture-handler';
import { useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated';
import type { PageItem, Point } from '@/infra/local/notes';
import { CONTEXT_MENU_HEIGHT, RESIZE_SIDES, type ResizeSide } from '../constants';
import type { InputMode } from '../stores';
import { insidePolygon, menuCoordinates, resizedImageBox } from './lib';
import type { Box, Selection, Tool } from './types';

export type DrawingCanvasOptions = {
  content: {
    items: PageItem[];
    onItemMove: (id: string, x: number, y: number) => void;
    onItemResize: (id: string, box: Box) => void;
  };
  selection: {
    itemId: string | null;
    strokeIds: string[];
    outline: Selection | null;
    onItemTap: (id: string) => void;
    onBackgroundTap: () => void;
    onClearRange: () => void;
    onPaste: (point: Point) => void;
    canPaste: boolean;
  };
  drawing: {
    tool: Tool;
    inputMode: InputMode;
    begin: (point: Point) => void;
    move: (point: Point) => void;
    end: (point: Point) => void;
    cancel: () => void;
  };
  pages: { canGoPrevious: boolean; onChange: (direction: -1 | 1) => void };
};

export function useDrawingCanvas({
  content: { items, onItemMove, onItemResize },
  selection: {
    itemId: selectedItemId,
    strokeIds: selectedStrokeIds,
    outline: selection,
    onItemTap,
    onBackgroundTap,
    onClearRange,
    onPaste,
    canPaste,
  },
  drawing: { tool, inputMode, begin, move, end, cancel },
  pages: { canGoPrevious, onChange: onPageChange },
}: DrawingCanvasOptions) {
  const scale = useSharedValue(1);
  const offsetX = useSharedValue(0);
  const offsetY = useSharedValue(0);
  const [size, setSize] = useState({ width: 1, height: 1 });
  const [draggingItem, setDraggingItem] = useState(false);
  const [imagePreview, setImagePreview] = useState<{ id: string; box: Box } | null>(null);
  const imageGesture = useRef<{ item: PageItem; side: ResizeSide | null } | null>(null);
  const [draggingSelection, setDraggingSelection] = useState(false);
  const [pasteMenu, setPasteMenu] = useState<{
    left: number;
    top: number;
    point: Point;
  } | null>(null);
  const panStart = useRef({ x: 0, y: 0, scale: 1 });
  const pinchStart = useRef({ scale: 1, x: 0, y: 0, focalX: 0, focalY: 0 });
  const pinchedDuringPan = useRef(false);
  const pinchActive = useRef(false);
  const drawingActive = useRef(false);
  const drawingWithFinger = useRef(false);
  const panningActive = useRef(false);
  const twoFingerPanning = useRef(false);
  const lastTwoFingerTranslation = useRef({ x: 0, y: 0 });

  const snapToBounds = (width = size.width, height = size.height) => {
    const nextScale = Math.max(1, Math.min(4, scale.value));
    const limitX = (width * (nextScale - 1)) / 2;
    const limitY = (height * (nextScale - 1)) / 2;
    const animation = { duration: 220 };
    scale.value = withTiming(nextScale, animation);
    offsetX.value = withTiming(Math.max(-limitX, Math.min(limitX, offsetX.value)), animation);
    offsetY.value = withTiming(Math.max(-limitY, Math.min(limitY, offsetY.value)), animation);
    if (menuKey) {
      if (menuTimer.current) clearTimeout(menuTimer.current);
      menuTimer.current = setTimeout(() => {
        placeMenu();
        menuTimer.current = null;
      }, animation.duration + 16);
    }
  };
  const toPagePoint = (x: number, y: number): Point => ({
    x: (x - size.width / 2 - offsetX.value) / scale.value + size.width / 2,
    y: (y - size.height / 2 - offsetY.value) / scale.value + size.height / 2,
  });
  const insideSelection = (x: number, y: number) => {
    if (tool !== 'select' || !selection) return false;
    const point = toPagePoint(x, y);
    return insidePolygon(point, selection.points);
  };

  const pageStyle = useAnimatedStyle(() => ({
    left: offsetX.value,
    top: offsetY.value,
    transform: [{ scale: scale.value }],
  }));
  const selectedItem = items.find((item) => item.id === selectedItemId);
  const imageHandleAt = (item: PageItem | undefined, point: Point): ResizeSide | null => {
    if (item?.kind !== 'image') return null;
    const radius = 14 / scale.value;
    return (
      RESIZE_SIDES.find((side) => {
        const horizontal = side.includes('w') ? 0 : side.includes('e') ? 1 : 0.5;
        const vertical = side.includes('n') ? 0 : side.includes('s') ? 1 : 0.5;
        return (
          Math.abs(point.x - item.x - item.width * horizontal) <= radius &&
          Math.abs(point.y - item.y - item.height * vertical) <= radius
        );
      }) ?? null
    );
  };
  const selectedRange =
    !selectedItem && tool === 'select' && selectedStrokeIds.length > 0 ? selection : null;
  const menuKey = selectedItem
    ? `item:${selectedItem.id}:${selectedItem.x}:${selectedItem.y}:${selectedItem.width}:${selectedItem.height}`
    : selectedRange
      ? `range:${selectedRange.id}:${selectedRange.bounds.x}:${selectedRange.bounds.y}`
      : null;
  const anchor = selectedItem ?? selectedRange?.bounds;
  const menuWidth = selectedItem?.kind === 'text' ? 136 : selectedItem ? 72 : 224;
  const [menuPosition, setMenuPosition] = useState<{
    key: string;
    left: number;
    top: number;
  } | null>(null);
  const menuTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const placeMenu = () => {
    if (!menuKey || !anchor || size.width <= 1 || size.height <= 1) return;
    setMenuPosition({
      key: menuKey,
      ...menuCoordinates({
        anchor,
        viewport: size,
        transform: { scale: scale.value, x: offsetX.value, y: offsetY.value },
        width: menuWidth,
      }),
    });
  };
  useEffect(() => {
    if (!menuKey || !anchor || size.width <= 1 || size.height <= 1) return;
    setMenuPosition({
      key: menuKey,
      ...menuCoordinates({
        anchor,
        viewport: size,
        transform: { scale: scale.value, x: offsetX.value, y: offsetY.value },
        width: menuWidth,
      }),
    });
  }, [menuKey, menuWidth, size, anchor, scale, offsetX, offsetY]);
  useEffect(
    () => () => {
      if (menuTimer.current) clearTimeout(menuTimer.current);
    },
    [],
  );

  const drawGesture = Gesture.Pan()
    .minDistance(0)
    .runOnJS(true)
    .onBegin((event) => {
      if (tool === 'select' && selectedStrokeIds.length > 0 && insideSelection(event.x, event.y))
        setDraggingSelection(true);
      drawingWithFinger.current = event.pointerType !== PointerType.STYLUS;
      drawingActive.current =
        tool !== 'hand' &&
        event.numberOfPointers === 1 &&
        (inputMode === 'finger' ||
          event.pointerType === PointerType.STYLUS ||
          (event.pointerType === PointerType.TOUCH && insideSelection(event.x, event.y)));
      if (drawingActive.current) begin(toPagePoint(event.x, event.y));
    })
    .onUpdate((event) => {
      if (drawingActive.current && drawingWithFinger.current && event.numberOfPointers > 1) {
        cancel();
        drawingActive.current = false;
      } else if (drawingActive.current && !pinchActive.current && event.numberOfPointers === 1)
        move(toPagePoint(event.x, event.y));
    })
    .onEnd((event) => {
      if (drawingActive.current) end(toPagePoint(event.x, event.y));
      drawingActive.current = false;
    })
    .onFinalize(() => {
      if (drawingActive.current) cancel();
      drawingActive.current = false;
      setDraggingSelection(false);
    });

  const handPan = Gesture.Pan()
    .maxPointers(1)
    .runOnJS(true)
    .onBegin((event) => {
      if (
        inputMode === 'stylus' &&
        (tool === 'pen' || tool === 'eraser') &&
        event.pointerType !== PointerType.STYLUS
      ) {
        const point = toPagePoint(event.x, event.y);
        const selectedImage = items.find(
          (item) => item.id === selectedItemId && item.kind === 'image',
        );
        const side = imageHandleAt(selectedImage, point);
        const image = side
          ? selectedImage
          : [...items]
              .reverse()
              .find(
                (item) =>
                  item.kind === 'image' &&
                  point.x >= item.x &&
                  point.x <= item.x + item.width &&
                  point.y >= item.y &&
                  point.y <= item.y + item.height,
              );
        if (image) {
          imageGesture.current = { item: image, side: side || null };
          panningActive.current = false;
          return;
        }
      }
      panningActive.current =
        event.pointerType !== PointerType.STYLUS && !insideSelection(event.x, event.y);
      if (panningActive.current) {
        panStart.current = { x: offsetX.value, y: offsetY.value, scale: scale.value };
        pinchedDuringPan.current = pinchActive.current;
      }
    })
    .onStart(() => {
      if (imageGesture.current) {
        setDraggingItem(true);
        onItemTap(imageGesture.current.item.id);
      }
    })
    .onUpdate((event) => {
      if (imageGesture.current && event.numberOfPointers === 1) {
        const { item, side } = imageGesture.current;
        const dx = event.translationX / scale.value;
        const dy = event.translationY / scale.value;
        const box = side
          ? resizedImageBox(item, size, side, dx, dy)
          : {
              x: Math.max(0, Math.min(size.width - item.width, item.x + dx)),
              y: Math.max(0, Math.min(size.height - item.height, item.y + dy)),
              width: item.width,
              height: item.height,
            };
        setImagePreview({ id: item.id, box });
        return;
      }
      if (panningActive.current && event.numberOfPointers === 1) {
        offsetX.value = panStart.current.x + event.translationX;
        offsetY.value = panStart.current.y + event.translationY;
        placeMenu();
      }
    })
    .onEnd((event) => {
      if (imageGesture.current) {
        const { item, side } = imageGesture.current;
        const dx = event.translationX / scale.value;
        const dy = event.translationY / scale.value;
        if (Math.abs(dx) + Math.abs(dy) >= 0.5) {
          if (side) onItemResize(item.id, resizedImageBox(item, size, side, dx, dy));
          else
            onItemMove(
              item.id,
              Math.max(0, Math.min(size.width - item.width, item.x + dx)),
              Math.max(0, Math.min(size.height - item.height, item.y + dy)),
            );
        }
        imageGesture.current = null;
        setImagePreview(null);
        setDraggingItem(false);
        return;
      }
      if (!panningActive.current) return;
      panningActive.current = false;
      if (pinchActive.current || pinchedDuringPan.current) return;
      const horizontalSwipe =
        Math.abs(event.translationX) >= Math.max(120, size.width * 0.18) &&
        Math.abs(event.translationX) > Math.abs(event.translationY) * 1.3;
      if (panStart.current.scale <= 1.01 && horizontalSwipe) {
        const direction = event.translationX < 0 ? 1 : -1;
        if (direction === 1 || canGoPrevious) {
          onPageChange(direction);
          return;
        }
      }
      snapToBounds();
    })
    .onFinalize(() => {
      if (imageGesture.current) {
        imageGesture.current = null;
        setImagePreview(null);
        setDraggingItem(false);
      }
    });

  const twoFingerPan = Gesture.Pan()
    .minPointers(2)
    .runOnJS(true)
    .onStart(() => {
      if (imageGesture.current) {
        imageGesture.current = null;
        setImagePreview(null);
        setDraggingItem(false);
      }
      twoFingerPanning.current = true;
      pinchedDuringPan.current = true;
      panningActive.current = false;
      lastTwoFingerTranslation.current = { x: 0, y: 0 };
      if (drawingActive.current && drawingWithFinger.current) {
        cancel();
        drawingActive.current = false;
      }
    })
    .onUpdate((event) => {
      const previous = lastTwoFingerTranslation.current;
      if (!pinchActive.current) {
        offsetX.value += event.translationX - previous.x;
        offsetY.value += event.translationY - previous.y;
        placeMenu();
      }
      lastTwoFingerTranslation.current = { x: event.translationX, y: event.translationY };
    })
    .onFinalize(() => {
      if (!twoFingerPanning.current) return;
      twoFingerPanning.current = false;
      if (!pinchActive.current) snapToBounds();
    });

  const pinch = Gesture.Pinch()
    .runOnJS(true)
    .onStart((event) => {
      if (event.pointerType === PointerType.STYLUS) return;
      if (imageGesture.current) {
        imageGesture.current = null;
        setImagePreview(null);
        setDraggingItem(false);
      }
      pinchActive.current = true;
      pinchedDuringPan.current = true;
      panningActive.current = false;
      if (drawingActive.current && drawingWithFinger.current) {
        cancel();
        drawingActive.current = false;
      }
      pinchStart.current = {
        scale: scale.value,
        x: offsetX.value,
        y: offsetY.value,
        focalX: event.focalX,
        focalY: event.focalY,
      };
    })
    .onUpdate((event) => {
      if (!pinchActive.current) return;
      const next = Math.max(0.5, Math.min(4, pinchStart.current.scale * event.scale));
      const ratio = next / pinchStart.current.scale;
      offsetX.value =
        event.focalX -
        size.width / 2 -
        (pinchStart.current.focalX - size.width / 2 - pinchStart.current.x) * ratio;
      offsetY.value =
        event.focalY -
        size.height / 2 -
        (pinchStart.current.focalY - size.height / 2 - pinchStart.current.y) * ratio;
      scale.value = next;
      placeMenu();
    })
    .onFinalize(() => {
      if (!pinchActive.current) return;
      pinchActive.current = false;
      if (!twoFingerPanning.current) snapToBounds();
    });

  const gesture =
    tool === 'hand'
      ? Gesture.Simultaneous(handPan, twoFingerPan, pinch)
      : inputMode === 'stylus'
        ? Gesture.Simultaneous(drawGesture, handPan, twoFingerPan, pinch)
        : Gesture.Simultaneous(drawGesture, twoFingerPan, pinch);
  const fingerImageTapEnabled = inputMode === 'stylus' && (tool === 'pen' || tool === 'eraser');
  const pasteLongPressEnabled =
    inputMode === 'stylus' || (inputMode === 'finger' && tool === 'select');
  const backgroundTap = Gesture.Tap()
    .runOnJS(true)
    .onEnd((event) => {
      if (pasteMenu) {
        setPasteMenu(null);
        return;
      }
      if (
        inputMode === 'stylus' &&
        selectedStrokeIds.length > 0 &&
        !insideSelection(event.x, event.y)
      )
        onClearRange();
      if (fingerImageTapEnabled && event.pointerType !== PointerType.STYLUS) {
        const point = toPagePoint(event.x, event.y);
        if (imageHandleAt(selectedItem, point)) return;
        const image = [...items]
          .reverse()
          .find(
            (item) =>
              item.kind === 'image' &&
              point.x >= item.x &&
              point.x <= item.x + item.width &&
              point.y >= item.y &&
              point.y <= item.y + item.height,
          );
        if (image) {
          onItemTap(image.id);
          return;
        }
      }
      if (selectedItemId) onBackgroundTap();
    });
  const pasteLongPress = Gesture.LongPress()
    .minDuration(450)
    .maxDistance(12)
    .runOnJS(true)
    .onStart((event) => {
      if (!pasteLongPressEnabled || event.pointerType === PointerType.STYLUS || !canPaste) return;
      setPasteMenu({
        left: Math.max(8, Math.min(size.width - 96, event.x - 44)),
        top: Math.max(8, Math.min(size.height - CONTEXT_MENU_HEIGHT, event.y + 10)),
        point: toPagePoint(event.x, event.y),
      });
    });
  const tapGesture =
    fingerImageTapEnabled ||
    selectedItemId ||
    (inputMode === 'stylus' && selectedStrokeIds.length > 0) ||
    !!pasteMenu
      ? backgroundTap
      : null;
  const backgroundGesture = pasteLongPressEnabled
    ? Gesture.Simultaneous(
        tapGesture ? Gesture.Exclusive(pasteLongPress, tapGesture) : pasteLongPress,
        gesture,
      )
    : tapGesture
      ? Gesture.Exclusive(tapGesture, gesture)
      : gesture;

  return {
    viewport: {
      size,
      onLayout: (width: number, height: number) => {
        setSize({ width, height });
        snapToBounds(width, height);
      },
      pageStyle,
      getScale: () => scale.value,
    },
    menu: {
      position: menuPosition,
      ready: !!menuKey && menuPosition?.key === menuKey,
      selectedItem,
      selectedRange,
      width: menuWidth,
      pastePosition: pasteMenu,
      pasteReady: !!pasteMenu,
      paste: () => {
        if (pasteMenu) onPaste(pasteMenu.point);
        setPasteMenu(null);
      },
    },
    interaction: {
      draggingItem,
      draggingSelection,
      setDraggingItem,
      imagePreview,
      backgroundGesture,
    },
  };
}
