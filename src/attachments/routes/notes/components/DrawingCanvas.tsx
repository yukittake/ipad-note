import { Canvas, Circle, DashPathEffect, Path, Rect, Skia } from '@shopify/react-native-skia';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import { Image, Pressable, StyleSheet, Text, View } from 'react-native';
import { memo } from 'react';
import Animated from 'react-native-reanimated';
import { Box, Selection, Tool, useDrawingCanvas, useItemOverlay, useNotebookLines } from '../hooks';
import type { InputMode } from '../stores';
import { PageItem, Point, Stroke } from '@/infra/local/notes';
import {
  DEFAULT_TEXT_COLOR,
  DEFAULT_TEXT_SIZE,
  ERASER_RADIUS,
  NOTE_PAPER_COLOR,
  NOTE_RULE_COLOR,
  RESIZE_NAMES,
} from '../constants';

const StrokePath = memo(function StrokePath({ stroke }: { stroke: Stroke }) {
  const path = Skia.PathBuilder.Make();
  const points = stroke.points;
  const first = points[0];
  if (!first) return null;
  path.moveTo(first.x, first.y);
  if (points.length === 2) {
    path.lineTo(points[1].x, points[1].y);
  } else if (points.length > 2) {
    path.lineTo((first.x + points[1].x) / 2, (first.y + points[1].y) / 2);
    for (let i = 1; i < points.length - 1; i++) {
      const point = points[i],
        next = points[i + 1];
      path.quadTo(point.x, point.y, (point.x + next.x) / 2, (point.y + next.y) / 2);
    }
    const last = points[points.length - 1];
    path.lineTo(last.x, last.y);
  }
  return (
    <Path
      path={path.build()}
      color={stroke.color}
      style="stroke"
      strokeWidth={stroke.width}
      strokeCap="round"
      strokeJoin="round"
    />
  );
});

const CommittedStrokeCanvas = memo(function CommittedStrokeCanvas({
  strokes,
}: {
  strokes: Stroke[];
}) {
  return (
    <Canvas style={StyleSheet.absoluteFill}>
      {strokes.map((stroke) => (
        <StrokePath key={stroke.id} stroke={stroke} />
      ))}
    </Canvas>
  );
});

const NotebookPaper = memo(function NotebookPaper({
  width,
  height,
}: {
  width: number;
  height: number;
}) {
  const lines = useNotebookLines(width, height);
  return (
    <>
      <Rect x={0} y={0} width={width} height={height} color={NOTE_PAPER_COLOR} />
      <Path path={lines} color={NOTE_RULE_COLOR} style="stroke" strokeWidth={1} />
    </>
  );
});

function ItemOverlay({
  item,
  state: { selected, interactionEnabled, showHandles, previewBox },
  viewport: { getScale, pageSize },
  actions: { onTap, onMove, onResize, onDragChange },
}: {
  item: PageItem;
  state: {
    selected: boolean;
    interactionEnabled: boolean;
    showHandles: boolean;
    previewBox: Box | null;
  };
  viewport: { getScale: () => number; pageSize: { width: number; height: number } };
  actions: {
    onTap: (id: string) => void;
    onMove: (id: string, x: number, y: number) => void;
    onResize: (id: string, box: Box) => void;
    onDragChange: (dragging: boolean) => void;
  };
}) {
  const { frame, gestures } = useItemOverlay({
    geometry: { item, getScale, pageSize },
    callbacks: { onTap, onMove, onResize, onDragChange },
  });
  const box = previewBox ?? frame.box;
  return (
    <>
      <GestureDetector gesture={Gesture.Exclusive(gestures.pan, gestures.tap)}>
        <View
          pointerEvents={interactionEnabled ? 'auto' : 'none'}
          style={[
            styles.item,
            {
              left: box.x + frame.drag.x,
              top: box.y + frame.drag.y,
              width: box.width,
              height: box.height,
            },
            selected && styles.selectedItem,
          ]}
        >
          {item.kind === 'text' ? (
            <Text
              style={[
                styles.itemText,
                {
                  fontSize: item.fontSize ?? DEFAULT_TEXT_SIZE,
                  color: item.color ?? DEFAULT_TEXT_COLOR,
                },
              ]}
            >
              {item.text}
            </Text>
          ) : item.image ? (
            <Image source={{ uri: item.image }} resizeMode="stretch" style={styles.itemImage} />
          ) : null}
        </View>
      </GestureDetector>
      {showHandles &&
        selected &&
        item.kind === 'image' &&
        gestures.resizeHandles.map(({ side, gesture, horizontal, vertical }) => (
          <GestureDetector key={side} gesture={gesture}>
            <View
              pointerEvents={interactionEnabled ? 'auto' : 'none'}
              accessibilityRole="adjustable"
              accessibilityLabel={`${RESIZE_NAMES[side]}で画像サイズを変更`}
              style={[
                styles.resizeHitArea,
                {
                  left: box.x + frame.drag.x + box.width * horizontal - 14,
                  top: box.y + frame.drag.y + box.height * vertical - 14,
                },
              ]}
            >
              <View style={styles.resizeHandle} />
            </View>
          </GestureDetector>
        ))}
    </>
  );
}

type DrawingCanvasProps = {
  content: {
    strokes: Stroke[];
    items: PageItem[];
    draft: Stroke | null;
    eraserCursor: Point | null;
  };
  selectionState: {
    itemId: string | null;
    strokeIds: string[];
    outline: Selection | null;
    draft: Point[] | null;
    onDelete: () => void;
    onClear: () => void;
    onCopy: () => void;
    onCut: () => void;
    onPaste: (point: Point) => void;
    canPaste: boolean;
  };
  itemActions: {
    onPress: (id: string) => void;
    onMove: (id: string, x: number, y: number) => void;
    onResize: (id: string, box: Box) => void;
    onBackgroundTap: () => void;
    onEdit: (id: string) => void;
    onDelete: (id: string) => void;
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

export function DrawingCanvas({
  content,
  selectionState,
  itemActions,
  drawing,
  pages,
}: DrawingCanvasProps) {
  const { strokes, items, draft, eraserCursor } = content;
  const {
    itemId: selectedItemId,
    strokeIds: selectedStrokeIds,
    outline: selection,
    draft: selectionDraft,
    onDelete: onDeleteSelection,
    onClear: onClearSelection,
    onCopy: onCopySelection,
    onCut: onCutSelection,
    onPaste: onPasteSelection,
    canPaste,
  } = selectionState;
  const {
    onPress: onItemPress,
    onMove: onItemMove,
    onResize: onItemResize,
    onBackgroundTap,
    onEdit: onEditItem,
    onDelete: onDeleteItem,
  } = itemActions;
  const { tool, inputMode, begin, move, end, cancel } = drawing;
  const { canGoPrevious, onChange: onPageChange } = pages;
  const {
    viewport: { size, onLayout, pageStyle, getScale },
    menu: {
      position: menuPosition,
      ready: menuReady,
      selectedItem,
      selectedRange,
      width: menuWidth,
      pastePosition,
      pasteReady,
      paste: pasteAtRequestedPoint,
    },
    interaction: {
      draggingItem,
      draggingSelection,
      setDraggingItem,
      imagePreview,
      backgroundGesture,
    },
  } = useDrawingCanvas({
    content: { items, onItemMove, onItemResize },
    selection: {
      itemId: selectedItemId,
      strokeIds: selectedStrokeIds,
      outline: selection,
      onItemTap: onItemPress,
      onBackgroundTap,
      onClearRange: onClearSelection,
      onPaste: onPasteSelection,
      canPaste,
    },
    drawing: { tool, inputMode, begin, move, end, cancel },
    pages: { canGoPrevious, onChange: onPageChange },
  });
  const outline = selectionDraft ?? selection?.points;
  const selectionPath =
    outline && outline.length > 1 ? buildSelectionPath(outline, !!selection) : null;
  return (
    <View
      style={styles.surface}
      onLayout={(e) => {
        const { width, height } = e.nativeEvent.layout;
        onLayout(width, height);
      }}
    >
      <GestureDetector gesture={backgroundGesture}>
        <View style={StyleSheet.absoluteFill}>
          <Animated.View pointerEvents="none" style={[styles.page, pageStyle]}>
            <Canvas style={StyleSheet.absoluteFill}>
              <NotebookPaper width={size.width} height={size.height} />
            </Canvas>
          </Animated.View>
        </View>
      </GestureDetector>
      <Animated.View pointerEvents="box-none" style={[styles.itemLayer, pageStyle]}>
        {items.map((item) => (
          <ItemOverlay
            key={item.id}
            item={item}
            state={{
              selected: selectedItemId === item.id,
              interactionEnabled: tool !== 'pen' && tool !== 'eraser',
              showHandles: (tool !== 'pen' && tool !== 'eraser') || inputMode === 'stylus',
              previewBox: imagePreview?.id === item.id ? imagePreview.box : null,
            }}
            viewport={{ getScale, pageSize: size }}
            actions={{
              onTap: onItemPress,
              onMove: onItemMove,
              onResize: onItemResize,
              onDragChange: setDraggingItem,
            }}
          />
        ))}
      </Animated.View>
      <Animated.View pointerEvents="none" style={[styles.strokeLayer, pageStyle]}>
        <CommittedStrokeCanvas strokes={strokes} />
        <Canvas style={StyleSheet.absoluteFill}>
          {draft && <StrokePath stroke={draft} />}
          {selectionPath && (
            <Path path={selectionPath} color="#3776b8" style="stroke" strokeWidth={1.5}>
              <DashPathEffect intervals={[7, 5]} />
            </Path>
          )}
          {tool === 'eraser' && eraserCursor && (
            <>
              <Circle
                cx={eraserCursor.x}
                cy={eraserCursor.y}
                r={ERASER_RADIUS}
                color="rgba(49,79,114,0.16)"
              />
              <Circle
                cx={eraserCursor.x}
                cy={eraserCursor.y}
                r={ERASER_RADIUS}
                color="#314f72"
                style="stroke"
                strokeWidth={1.5}
              />
            </>
          )}
        </Canvas>
      </Animated.View>
      {menuReady &&
        !pasteReady &&
        (selectedItem || selectedRange) &&
        !draggingItem &&
        !draggingSelection && (
          <View
            style={[
              styles.contextMenu,
              { width: menuWidth, left: menuPosition?.left, top: menuPosition?.top },
            ]}
          >
            {selectedItem ? (
              <>
                {selectedItem.kind === 'text' && (
                  <Pressable
                    accessibilityLabel="文字を編集"
                    style={styles.contextAction}
                    onPress={() => onEditItem(selectedItem.id)}
                  >
                    <Text style={styles.contextText}>編集</Text>
                  </Pressable>
                )}
                <Pressable
                  accessibilityLabel="アイテムを削除"
                  style={styles.contextAction}
                  onPress={() => onDeleteItem(selectedItem.id)}
                >
                  <Text style={styles.contextDelete}>削除</Text>
                </Pressable>
              </>
            ) : (
              <>
                <Pressable
                  accessibilityLabel="選択範囲をコピー"
                  style={styles.contextAction}
                  onPress={onCopySelection}
                >
                  <Text style={styles.contextText}>コピー</Text>
                </Pressable>
                <Pressable
                  accessibilityLabel="選択範囲をカット"
                  style={styles.contextAction}
                  onPress={onCutSelection}
                >
                  <Text style={styles.contextText}>カット</Text>
                </Pressable>
                <Pressable
                  accessibilityLabel="選択を削除"
                  style={styles.contextAction}
                  onPress={onDeleteSelection}
                >
                  <Text style={styles.contextDelete}>削除</Text>
                </Pressable>
              </>
            )}
          </View>
        )}
      {pasteReady && pastePosition && (
        <View
          style={[
            styles.contextMenu,
            styles.pasteMenu,
            { left: pastePosition.left, top: pastePosition.top },
          ]}
        >
          <Pressable
            accessibilityLabel="選択範囲をペースト"
            style={styles.contextAction}
            onPress={pasteAtRequestedPoint}
          >
            <Text style={styles.contextText}>ペースト</Text>
          </Pressable>
        </View>
      )}
    </View>
  );
}

function buildSelectionPath(points: Point[], closed: boolean) {
  const builder = Skia.PathBuilder.Make();
  builder.moveTo(points[0].x, points[0].y);
  for (const point of points.slice(1)) builder.lineTo(point.x, point.y);
  if (closed) builder.close();
  return builder.build();
}

const styles = StyleSheet.create({
  surface: { flex: 1, backgroundColor: '#e9e9e5', overflow: 'hidden' },
  page: { position: 'absolute', width: '100%', height: '100%', backgroundColor: NOTE_PAPER_COLOR },
  itemLayer: { position: 'absolute', width: '100%', height: '100%' },
  strokeLayer: { position: 'absolute', width: '100%', height: '100%' },
  item: { position: 'absolute' },
  selectedItem: { borderWidth: 2, borderColor: '#3776b8' },
  itemText: { fontSize: DEFAULT_TEXT_SIZE, color: DEFAULT_TEXT_COLOR },
  itemImage: { width: '100%', height: '100%' },
  resizeHitArea: {
    position: 'absolute',
    width: 28,
    height: 28,
    alignItems: 'center',
    justifyContent: 'center',
  },
  resizeHandle: {
    width: 14,
    height: 14,
    borderRadius: 4,
    backgroundColor: '#3776b8',
    borderWidth: 2,
    borderColor: '#fff',
  },
  contextMenu: {
    position: 'absolute',
    zIndex: 10,
    minHeight: 44,
    padding: 4,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 12,
    backgroundColor: NOTE_PAPER_COLOR,
    borderWidth: 1,
    borderColor: '#d4d9dc',
    shadowColor: '#000',
    shadowOpacity: 0.16,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 3 },
    elevation: 6,
  },
  contextAction: {
    minWidth: 56,
    minHeight: 48,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 8,
    paddingVertical: 6,
  },
  pasteMenu: { width: 88 },
  contextText: { color: '#314f72', fontSize: 16, fontWeight: '600' },
  contextDelete: { color: '#a34a4a', fontSize: 16, fontWeight: '600' },
});
