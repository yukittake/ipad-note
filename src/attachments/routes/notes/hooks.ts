import { useEffect, useMemo, useRef, useState } from 'react';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { Alert } from 'react-native';
import * as ImagePicker from 'expo-image-picker';
import { Skia } from '@shopify/react-native-skia';
import { Gesture, PointerType } from 'react-native-gesture-handler';
import { useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated';
import {
  addPage,
  deletePage,
  getNote,
  listPages,
  loadPageContent,
  Note,
  Page,
  PageContent,
  PageItem,
  Point,
  reloadExternalNote,
  renameNote,
  savePageContent,
  Stroke,
} from '@/infra/local/notes';
import { useEditorPreferences, type EraserMode, type InputMode } from './stores';
import {
  CONTEXT_MENU_HEIGHT,
  DEFAULT_TEXT_COLOR,
  DEFAULT_TEXT_SIZE,
  ERASER_RADIUS,
  HOLD_MOVE_TOLERANCE,
  NOTE_LINE_SPACING,
  NOTE_LINE_START,
  RESIZE_SIDES,
  STRAIGHTEN_HOLD_MS,
  STRAIGHTEN_MIN_LENGTH,
  type ResizeSide,
} from './constants';

export type Tool = 'pen' | 'eraser' | 'select' | 'hand';
export type Box = { x: number; y: number; width: number; height: number };
export type Selection = { id: string; points: Point[]; bounds: Box };
type StrokeClipboard = { strokes: Stroke[]; outline: Point[]; bounds: Box };

function menuCoordinates({
  anchor,
  viewport,
  transform,
  width,
}: {
  anchor: Box;
  viewport: { width: number; height: number };
  transform: { scale: number; x: number; y: number };
  width: number;
}) {
  const centerX =
    viewport.width / 2 +
    transform.x +
    (anchor.x + anchor.width / 2 - viewport.width / 2) * transform.scale;
  const bottomY =
    viewport.height / 2 +
    transform.y +
    (anchor.y + anchor.height - viewport.height / 2) * transform.scale;
  const topY =
    viewport.height / 2 + transform.y + (anchor.y - viewport.height / 2) * transform.scale;
  const below = bottomY + 10;
  return {
    left: Math.max(8, Math.min(viewport.width - width - 8, centerX - width / 2)),
    top: Math.max(
      8,
      Math.min(
        viewport.height - CONTEXT_MENU_HEIGHT,
        below + CONTEXT_MENU_HEIGHT <= viewport.height ? below : topY - CONTEXT_MENU_HEIGHT - 10,
      ),
    ),
  };
}

function boundsOf(points: Point[]): Box {
  const xs = points.map((point) => point.x);
  const ys = points.map((point) => point.y);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y };
}

function insidePolygon(point: Point, polygon: Point[]) {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[i],
      b = polygon[j];
    if (
      a.y > point.y !== b.y > point.y &&
      point.x < ((b.x - a.x) * (point.y - a.y)) / (b.y - a.y) + a.x
    )
      inside = !inside;
  }
  return inside;
}

function strokeInsideSelection(stroke: Stroke, polygon: Point[]) {
  if (stroke.points.some((point) => insidePolygon(point, polygon))) return true;
  for (let i = 0; i < stroke.points.length - 1; i++) {
    for (let j = 0; j < polygon.length; j++) {
      if (
        segmentsIntersect(
          { from: stroke.points[i], to: stroke.points[i + 1] },
          { from: polygon[j], to: polygon[(j + 1) % polygon.length] },
        )
      )
        return true;
    }
  }
  return false;
}

function translateSelection(selection: Selection, dx: number, dy: number): Selection {
  return {
    id: selection.id,
    points: selection.points.map((point) => ({ x: point.x + dx, y: point.y + dy })),
    bounds: { ...selection.bounds, x: selection.bounds.x + dx, y: selection.bounds.y + dy },
  };
}

function pointToSegmentDistanceSquared(point: Point, start: Point, end: Point) {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const lengthSquared = dx * dx + dy * dy;
  const t =
    lengthSquared === 0
      ? 0
      : Math.max(
          0,
          Math.min(1, ((point.x - start.x) * dx + (point.y - start.y) * dy) / lengthSquared),
        );
  const x = point.x - (start.x + t * dx);
  const y = point.y - (start.y + t * dy);
  return x * x + y * y;
}

type Segment = { from: Point; to: Point };

function segmentsIntersect({ from: a, to: b }: Segment, { from: c, to: d }: Segment) {
  const cross = (p: Point, q: Point, r: Point) =>
    (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x);
  const abC = cross(a, b, c),
    abD = cross(a, b, d);
  const cdA = cross(c, d, a),
    cdB = cross(c, d, b);
  return (
    abC * abD <= 0 &&
    cdA * cdB <= 0 &&
    Math.max(a.x, b.x) >= Math.min(c.x, d.x) &&
    Math.max(c.x, d.x) >= Math.min(a.x, b.x) &&
    Math.max(a.y, b.y) >= Math.min(c.y, d.y) &&
    Math.max(c.y, d.y) >= Math.min(a.y, b.y)
  );
}

function strokeTouchesEraser(stroke: Stroke, from: Point, to: Point) {
  const radiusSquared = Math.pow(ERASER_RADIUS + stroke.width / 2, 2);
  const points = stroke.points;
  for (let index = 0; index < points.length; index++) {
    const start = points[index],
      end = points[index + 1] ?? start;
    if (
      segmentsIntersect({ from: start, to: end }, { from, to }) ||
      pointToSegmentDistanceSquared(start, from, to) <= radiusSquared ||
      pointToSegmentDistanceSquared(end, from, to) <= radiusSquared ||
      pointToSegmentDistanceSquared(from, start, end) <= radiusSquared ||
      pointToSegmentDistanceSquared(to, start, end) <= radiusSquared
    )
      return true;
  }
  return false;
}

function eraseStrokePortion(stroke: Stroke, from: Point, to: Point): Stroke[] {
  if (!stroke.points.length || !strokeTouchesEraser(stroke, from, to)) return [stroke];
  const radiusSquared = (ERASER_RADIUS + stroke.width / 2) ** 2;
  const isErased = (point: Point) =>
    pointToSegmentDistanceSquared(point, from, to) <= radiusSquared;
  const fragments: Point[][] = [];
  let fragment: Point[] = [];
  let previous: Point | null = null;
  let previousErased = false;
  let removed = false;

  const boundary = (first: Point, second: Point, firstErased: boolean): Point => {
    let low = 0;
    let high = 1;
    for (let index = 0; index < 10; index++) {
      const middle = (low + high) / 2;
      const sample = {
        x: first.x + (second.x - first.x) * middle,
        y: first.y + (second.y - first.y) * middle,
      };
      if (isErased(sample) === firstErased) low = middle;
      else high = middle;
    }
    const ratio = (low + high) / 2;
    return {
      x: first.x + (second.x - first.x) * ratio,
      y: first.y + (second.y - first.y) * ratio,
    };
  };

  const visit = (point: Point) => {
    const erased = isErased(point);
    if (erased) removed = true;
    if (!erased) {
      if (previous && previousErased) fragment.push(boundary(previous, point, true));
      fragment.push(point);
    } else if (fragment.length) {
      if (previous && !previousErased) fragment.push(boundary(previous, point, false));
      fragments.push(fragment);
      fragment = [];
    }
    previous = point;
    previousErased = erased;
  };

  visit(stroke.points[0]);
  for (let index = 0; index < stroke.points.length - 1; index++) {
    const start = stroke.points[index];
    const end = stroke.points[index + 1];
    const distance = Math.hypot(end.x - start.x, end.y - start.y);
    const steps = Math.max(1, Math.ceil(distance / (ERASER_RADIUS / 3)));
    for (let step = 1; step <= steps; step++) {
      const ratio = step / steps;
      visit({ x: start.x + (end.x - start.x) * ratio, y: start.y + (end.y - start.y) * ratio });
    }
  }
  if (fragment.length) fragments.push(fragment);
  if (!removed) return [stroke];
  return fragments
    .filter((points) => points.length > 1)
    .map((points, index) => ({ ...stroke, id: index === 0 ? stroke.id : newElementId(), points }));
}

let elementSequence = 0;
const newElementId = () => `${Date.now()}-${++elementSequence}`;

function uniqueElements<T extends { id: string }>(elements: T[]): T[] {
  const seen = new Set<string>();
  let changed = false;
  const result = elements.map((element) => {
    if (element.id && !seen.has(element.id)) {
      seen.add(element.id);
      return element;
    }
    changed = true;
    let id = newElementId();
    while (seen.has(id)) id = newElementId();
    seen.add(id);
    return { ...element, id };
  });
  return changed ? result : elements;
}

function uniqueContent(content: PageContent): PageContent {
  const strokes = uniqueElements(content.strokes);
  const items = uniqueElements(content.items);
  return strokes === content.strokes && items === content.items ? content : { strokes, items };
}

function isNearlyStraight(points: Point[]) {
  const first = points[0],
    last = points[points.length - 1];
  if (!first || !last) return false;
  const length = Math.hypot(last.x - first.x, last.y - first.y);
  if (length < STRAIGHTEN_MIN_LENGTH) return false;
  let traveled = 0;
  let maxDeviation = 0;
  for (let i = 1; i < points.length; i++) {
    const previous = points[i - 1],
      point = points[i];
    traveled += Math.hypot(point.x - previous.x, point.y - previous.y);
    maxDeviation = Math.max(
      maxDeviation,
      Math.abs(
        (point.x - first.x) * (last.y - first.y) - (point.y - first.y) * (last.x - first.x),
      ) / length,
    );
  }
  return traveled <= length * 1.2 && maxDeviation <= Math.max(6, length * 0.06);
}

export function useEditor(noteId: string) {
  const [note, setNote] = useState<Note | null>(null);
  const [pages, setPages] = useState<Page[]>([]);
  const [pageIndex, setPageIndex] = useState(0);
  const [strokes, setStrokes] = useState<Stroke[]>([]);
  const [items, setItems] = useState<PageItem[]>([]);
  const [storageError, setStorageError] = useState('');
  const [accessError, setAccessError] = useState('');
  const [reloadKey, setReloadKey] = useState(0);
  const [loadedPageId, setLoadedPageId] = useState<string | null>(null);
  const [draft, setDraft] = useState<Stroke | null>(null);
  const { settings, actions } = useEditorPreferences();
  const { tool, inputMode, eraserMode, color, width } = settings;
  const { setTool, setInputMode, setEraserMode, setColor, setWidth } = actions;
  const [eraserCursor, setEraserCursor] = useState<Point | null>(null);
  const [selection, setSelection] = useState<Selection | null>(null);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [selectionDraft, setSelectionDraft] = useState<Point[] | null>(null);
  const [clipboard, setClipboard] = useState<StrokeClipboard | null>(null);
  const gesture = useRef<{
    start: Point;
    mode: 'draw' | 'erase' | 'select' | 'move';
    originals?: Stroke[];
    selectionStart?: Selection;
    selectionPoints?: Point[];
    straightened?: boolean;
  } | null>(null);
  const straightenTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const strokesRef = useRef(strokes);
  const itemsRef = useRef(items);
  const draftRef = useRef(draft);
  const changingPages = useRef(false);
  const historyRef = useRef<Record<string, { past: PageContent[]; future: PageContent[] }>>({});
  const [historyAvailability, setHistoryAvailability] = useState({
    canUndo: false,
    canRedo: false,
  });
  useEffect(() => {
    strokesRef.current = strokes;
  }, [strokes]);
  useEffect(() => {
    itemsRef.current = items;
  }, [items]);
  useEffect(() => {
    draftRef.current = draft;
  }, [draft]);
  const clearStraightenTimer = () => {
    if (straightenTimer.current !== null) clearTimeout(straightenTimer.current);
    straightenTimer.current = null;
  };
  const scheduleStraighten = () => {
    clearStraightenTimer();
    straightenTimer.current = setTimeout(() => {
      straightenTimer.current = null;
      const current = gesture.current;
      const stroke = draftRef.current;
      if (current?.mode !== 'draw' || !stroke || !isNearlyStraight(stroke.points)) return;
      const straightened = {
        ...stroke,
        points: [stroke.points[0], stroke.points[stroke.points.length - 1]],
      };
      current.straightened = true;
      draftRef.current = straightened;
      setDraft(straightened);
    }, STRAIGHTEN_HOLD_MS);
  };
  useEffect(() => () => clearStraightenTimer(), []);
  const page = pages[pageIndex];
  const pageId = page?.id;

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const [loadedNote, loadedPages] = await Promise.all([getNote(noteId), listPages(noteId)]);
        if (active) {
          setNote(loadedNote);
          setPages(loadedPages);
          setAccessError('');
        }
      } catch (error) {
        if (active) setAccessError(String(error));
      }
    })();
    return () => {
      active = false;
    };
  }, [noteId]);
  useEffect(() => {
    let active = true;
    clearStraightenTimer();
    gesture.current = null;
    draftRef.current = null;
    setDraft(null);
    setEraserCursor(null);
    setLoadedPageId(null);
    setSelection(null);
    setSelectionDraft(null);
    setSelectedIds([]);
    strokesRef.current = [];
    setStrokes([]);
    itemsRef.current = [];
    setItems([]);
    if (pageId)
      void (async () => {
        const loaded = await loadPageContent(pageId);
        const value = uniqueContent(loaded);
        if (value !== loaded) await savePageContent(noteId, pageId, value);
        if (active) {
          strokesRef.current = value.strokes;
          setStrokes(value.strokes);
          itemsRef.current = value.items;
          setItems(value.items);
          setLoadedPageId(pageId);
          setAccessError('');
          setStorageError('');
          const history = historyRef.current[pageId];
          setHistoryAvailability({
            canUndo: !!history?.past.length,
            canRedo: !!history?.future.length,
          });
        }
      })().catch((error) => {
        if (active) setAccessError(String(error));
      });
    return () => {
      active = false;
    };
  }, [pageId, reloadKey, noteId]);

  const historyFor = (pageId: string) => (historyRef.current[pageId] ??= { past: [], future: [] });
  const recordContent = (before: PageContent, after: PageContent) => {
    if (!page || (before.strokes === after.strokes && before.items === after.items)) return;
    const history = historyFor(page.id);
    history.past.push(before);
    if (history.past.length > 50) history.past.shift();
    history.future = [];
    setHistoryAvailability({ canUndo: true, canRedo: false });
  };
  const record = (before: Stroke[], after: Stroke[]) =>
    recordContent(
      { strokes: before, items: itemsRef.current },
      { strokes: after, items: itemsRef.current },
    );
  const persist = (pageId: string, content: PageContent) => {
    void savePageContent(noteId, pageId, content)
      .then(() => setStorageError(''))
      .catch((error) => {
        setStorageError(`保存できませんでした: ${String(error)}`);
        setAccessError(String(error));
        setLoadedPageId(null);
      });
  };
  const commit = (next: Stroke[], recordChange = true) => {
    if (next === strokesRef.current) return;
    next = uniqueElements(next);
    if (recordChange) record(strokesRef.current, next);
    setStrokes(next);
    strokesRef.current = next;
    if (page) persist(page.id, { strokes: next, items: itemsRef.current });
  };
  const commitItems = (next: PageItem[]) => {
    if (!page || loadedPageId !== page.id) return;
    next = uniqueElements(next);
    recordContent(
      { strokes: strokesRef.current, items: itemsRef.current },
      { strokes: strokesRef.current, items: next },
    );
    itemsRef.current = next;
    setItems(next);
    persist(page.id, { strokes: strokesRef.current, items: next });
  };
  const addText = (text: string, fontSize = DEFAULT_TEXT_SIZE, textColor = DEFAULT_TEXT_COLOR) => {
    if (!text.trim()) return;
    commitItems([
      ...itemsRef.current,
      {
        id: newElementId(),
        kind: 'text',
        x: 40,
        y: 70 + itemsRef.current.length * 48,
        width: 280,
        height: Math.max(80, fontSize * 3),
        text,
        fontSize,
        color: textColor,
      },
    ]);
  };
  const addImage = (image: string, ratio: number) => {
    commitItems([
      ...itemsRef.current,
      {
        id: newElementId(),
        kind: 'image',
        x: 40,
        y: 70 + itemsRef.current.length * 48,
        width: 280,
        height: Math.min(320, 280 / ratio),
        image,
      },
    ]);
  };
  const updateItem = (id: string, change: Partial<PageItem>) =>
    commitItems(itemsRef.current.map((item) => (item.id === id ? { ...item, ...change } : item)));
  const removeItem = (id: string) => commitItems(itemsRef.current.filter((item) => item.id !== id));

  const begin = (point: Point) => {
    if (tool === 'hand' || !page || loadedPageId !== page.id) return;
    if (tool === 'pen') {
      const stroke = { id: newElementId(), color, width, points: [point] };
      gesture.current = { start: point, mode: 'draw' };
      setDraft(stroke);
      draftRef.current = stroke;
      scheduleStraighten();
    } else if (tool === 'eraser') {
      gesture.current = { start: point, mode: 'erase', originals: strokesRef.current };
      setEraserCursor(point);
      erase(point, point);
    } else if (selection && insidePolygon(point, selection.points) && selectedIds.length) {
      gesture.current = {
        start: point,
        mode: 'move',
        originals: strokesRef.current,
        selectionStart: selection,
      };
    } else {
      gesture.current = { start: point, mode: 'select', selectionPoints: [point] };
      setSelection(null);
      setSelectedIds([]);
      setSelectionDraft([point]);
    }
  };

  const erase = (from: Point, to: Point) => {
    const current = strokesRef.current;
    const next =
      eraserMode === 'stroke'
        ? current.filter((stroke) => !strokeTouchesEraser(stroke, from, to))
        : current.flatMap((stroke) => eraseStrokePortion(stroke, from, to));
    if (next.length !== current.length || next.some((stroke, index) => stroke !== current[index]))
      commit(next, false);
  };

  const move = (point: Point) => {
    const current = gesture.current;
    if (!current) return;
    if (current.mode === 'draw') {
      const previous = draftRef.current;
      if (previous) {
        const last = previous.points[previous.points.length - 1];
        if (Math.hypot(point.x - last.x, point.y - last.y) < HOLD_MOVE_TOLERANCE) return;
        const next = {
          ...previous,
          points: current.straightened ? [previous.points[0], point] : [...previous.points, point],
        };
        draftRef.current = next;
        setDraft(next);
        if (!current.straightened) scheduleStraighten();
      }
    } else if (current.mode === 'erase') {
      setEraserCursor(point);
      erase(current.start, point);
      current.start = point;
    } else if (current.mode === 'select') {
      const points = current.selectionPoints ?? [current.start];
      if (
        Math.hypot(point.x - points[points.length - 1].x, point.y - points[points.length - 1].y) >=
        2
      ) {
        current.selectionPoints = [...points, point];
        setSelectionDraft(current.selectionPoints);
      }
    } else if (current.originals) {
      const dx = point.x - current.start.x,
        dy = point.y - current.start.y;
      const ids = new Set(selectedIds);
      setStrokes(
        current.originals.map((stroke) =>
          ids.has(stroke.id)
            ? { ...stroke, points: stroke.points.map((p) => ({ x: p.x + dx, y: p.y + dy })) }
            : stroke,
        ),
      );
      if (current.selectionStart) setSelection(translateSelection(current.selectionStart, dx, dy));
    }
  };

  const end = (point: Point) => {
    const current = gesture.current;
    if (!current) return;
    setEraserCursor(null);
    clearStraightenTimer();
    if (current.mode === 'draw' && draftRef.current) {
      const stroke = draftRef.current;
      commit([
        ...strokesRef.current,
        {
          ...stroke,
          points:
            stroke.points.length === 1
              ? [...stroke.points, { x: stroke.points[0].x + 0.1, y: stroke.points[0].y + 0.1 }]
              : stroke.points,
        },
      ]);
      setDraft(null);
      draftRef.current = null;
    } else if (current.mode === 'erase') {
      erase(current.start, point);
      if (current.originals) record(current.originals, strokesRef.current);
    } else if (current.mode === 'select') {
      const points = [...(current.selectionPoints ?? [current.start]), point];
      const bounds = boundsOf(points);
      const ids = strokesRef.current
        .filter((stroke) => points.length >= 3 && strokeInsideSelection(stroke, points))
        .map((stroke) => stroke.id);
      setSelectedIds(ids);
      setSelection(ids.length ? { id: newElementId(), points, bounds } : null);
      setSelectionDraft(null);
    } else if (current.mode === 'move' && current.originals) {
      const dx = point.x - current.start.x,
        dy = point.y - current.start.y;
      if (Math.abs(dx) + Math.abs(dy) >= 0.5) {
        const ids = new Set(selectedIds);
        const moved = current.originals.map((stroke) =>
          ids.has(stroke.id)
            ? { ...stroke, points: stroke.points.map((p) => ({ x: p.x + dx, y: p.y + dy })) }
            : stroke,
        );
        record(current.originals, moved);
        commit(moved, false);
        if (current.selectionStart)
          setSelection(translateSelection(current.selectionStart, dx, dy));
      } else {
        setStrokes(current.originals);
        strokesRef.current = current.originals;
        if (current.selectionStart) setSelection(current.selectionStart);
      }
    }
    gesture.current = null;
  };

  const cancel = () => {
    const current = gesture.current;
    if (!current) return;
    setEraserCursor(null);
    clearStraightenTimer();
    if (current.mode === 'draw') {
      draftRef.current = null;
      setDraft(null);
    } else if (current.mode === 'move' && current.originals) {
      strokesRef.current = current.originals;
      setStrokes(current.originals);
      if (current.selectionStart) setSelection(current.selectionStart);
    } else if (current.mode === 'erase' && current.originals) {
      commit(current.originals, false);
    } else if (current.mode === 'select') {
      setSelectionDraft(null);
    }
    gesture.current = null;
  };

  const removeSelection = () => {
    if (selectedIds.length) commit(strokesRef.current.filter((s) => !selectedIds.includes(s.id)));
    setSelectedIds([]);
    setSelection(null);
  };
  const clearSelection = () => {
    setSelectedIds([]);
    setSelection(null);
  };
  const copySelection = () => {
    if (!selection || !selectedIds.length) return;
    const ids = new Set(selectedIds);
    setClipboard({
      strokes: strokesRef.current
        .filter((stroke) => ids.has(stroke.id))
        .map((stroke) => ({ ...stroke, points: stroke.points.map((point) => ({ ...point })) })),
      outline: selection.points.map((point) => ({ ...point })),
      bounds: { ...selection.bounds },
    });
  };
  const cutSelection = () => {
    copySelection();
    removeSelection();
  };
  const pasteSelection = (point: Point) => {
    if (!clipboard?.strokes.length || !page || loadedPageId !== page.id) return;
    const dx = point.x - (clipboard.bounds.x + clipboard.bounds.width / 2);
    const dy = point.y - (clipboard.bounds.y + clipboard.bounds.height / 2);
    const pasted = clipboard.strokes.map((stroke) => ({
      ...stroke,
      id: newElementId(),
      points: stroke.points.map((source) => ({ x: source.x + dx, y: source.y + dy })),
    }));
    commit([...strokesRef.current, ...pasted]);
    setSelectedIds(pasted.map((stroke) => stroke.id));
    setSelection({
      id: newElementId(),
      points: clipboard.outline.map((source) => ({ x: source.x + dx, y: source.y + dy })),
      bounds: { ...clipboard.bounds, x: clipboard.bounds.x + dx, y: clipboard.bounds.y + dy },
    });
  };
  const undo = () => {
    if (!page || loadedPageId !== page.id) return;
    const history = historyFor(page.id);
    const previous = history.past.pop();
    if (!previous) return;
    history.future.push({ strokes: strokesRef.current, items: itemsRef.current });
    setHistoryAvailability({ canUndo: !!history.past.length, canRedo: true });
    setSelection(null);
    setSelectedIds([]);
    strokesRef.current = previous.strokes;
    itemsRef.current = previous.items;
    setStrokes(previous.strokes);
    setItems(previous.items);
    persist(page.id, previous);
  };
  const redo = () => {
    if (!page || loadedPageId !== page.id) return;
    const history = historyFor(page.id);
    const next = history.future.pop();
    if (!next) return;
    history.past.push({ strokes: strokesRef.current, items: itemsRef.current });
    setHistoryAvailability({ canUndo: true, canRedo: !!history.future.length });
    setSelection(null);
    setSelectedIds([]);
    strokesRef.current = next.strokes;
    itemsRef.current = next.items;
    setStrokes(next.strokes);
    setItems(next.items);
    persist(page.id, next);
  };
  const appendPage = async () => {
    if (changingPages.current || loadedPageId !== page?.id) return;
    changingPages.current = true;
    try {
      const next = await addPage(noteId);
      setPages((current) => [...current, next]);
      setPageIndex(pages.length);
    } finally {
      changingPages.current = false;
    }
  };
  const deleteCurrentPage = async () => {
    if (changingPages.current || !page || loadedPageId !== page.id) return;
    changingPages.current = true;
    try {
      const remaining = await deletePage(noteId, page.id);
      delete historyRef.current[page.id];
      setPages(remaining);
      setPageIndex(Math.min(pageIndex, remaining.length - 1));
    } finally {
      changingPages.current = false;
    }
  };
  const updateTitle = async (title: string) => {
    if (loadedPageId !== page?.id) return;
    await renameNote(noteId, title);
    setNote((current) => current && { ...current, title: title.trim() || '無題のノート' });
  };
  const reload = () => {
    void (async () => {
      setLoadedPageId(null);
      try {
        await reloadExternalNote(noteId);
        const [loadedNote, loadedPages] = await Promise.all([getNote(noteId), listPages(noteId)]);
        setNote(loadedNote);
        setPages(loadedPages);
        setPageIndex((index) => Math.min(index, Math.max(0, loadedPages.length - 1)));
        setAccessError('');
        setStorageError('');
        setReloadKey((key) => key + 1);
      } catch (error) {
        setAccessError(String(error));
      }
    })();
  };
  return {
    document: {
      note,
      pages,
      pageIndex,
      setPageIndex,
      storageError,
      accessError,
      reload,
      ready: !!page && loadedPageId === page.id,
      appendPage,
      deleteCurrentPage,
      updateTitle,
    },
    canvas: { strokes, items, draft, eraserCursor, begin, move, end, cancel },
    preferences: {
      tool,
      setTool: (nextTool: Tool) => {
        if (nextTool === 'pen') clearSelection();
        setTool(nextTool);
      },
      inputMode,
      setInputMode,
      eraserMode,
      setEraserMode,
      color,
      setColor,
      width,
      setWidth,
    },
    selection: {
      outline: selection,
      selectedIds,
      draft: selectionDraft,
      remove: removeSelection,
      clear: clearSelection,
      copy: copySelection,
      cut: cutSelection,
      paste: pasteSelection,
      canPaste: !!clipboard?.strokes.length,
    },
    content: { addText, addImage, updateItem, removeItem },
    history: {
      undo,
      redo,
      canUndo: !!page && loadedPageId === page.id && historyAvailability.canUndo,
      canRedo: !!page && loadedPageId === page.id && historyAvailability.canRedo,
    },
  };
}

export function useEditorScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const editor = useEditor(id ?? '');
  const [editingTitle, setEditingTitle] = useState(false);
  const [title, setTitle] = useState('');
  const [pageToast, setPageToast] = useState('');
  const [textDraft, setTextDraft] = useState('');
  const [textSize, setTextSize] = useState(DEFAULT_TEXT_SIZE);
  const [textColor, setTextColor] = useState(DEFAULT_TEXT_COLOR);
  const [editingItemId, setEditingItemId] = useState<string | null>(null);
  const [textModalOpen, setTextModalOpen] = useState(false);
  const [selectedItemId, setSelectedItemId] = useState<string | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const toastOpacity = useSharedValue(0);
  const toastStyle = useAnimatedStyle(() => ({ opacity: toastOpacity.value }));

  useEffect(() => {
    if (editor.preferences.tool === 'pen') setSelectedItemId(null);
  }, [editor.preferences.tool]);

  useEffect(
    () => () => {
      if (toastTimer.current) clearTimeout(toastTimer.current);
    },
    [],
  );

  const showPageToast = (index: number, count: number) => {
    setPageToast(`${index + 1}/${count}`);
    toastOpacity.value = 1;
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => {
      toastOpacity.value = withTiming(0, { duration: 250 });
      toastTimer.current = null;
    }, 1100);
  };

  const changePage = (direction: -1 | 1) => {
    setSelectedItemId(null);
    if (direction === 1 && editor.document.pageIndex === editor.document.pages.length - 1) {
      void editor.document
        .appendPage()
        .then(() => showPageToast(editor.document.pages.length, editor.document.pages.length + 1))
        .catch(() => Alert.alert('ページを追加できませんでした'));
      return;
    }
    const nextIndex = editor.document.pageIndex + direction;
    editor.document.setPageIndex(nextIndex);
    showPageToast(nextIndex, editor.document.pages.length);
  };

  const confirmDeletePage = () =>
    Alert.alert(
      'ページを削除',
      editor.document.pages.length === 1
        ? 'このページを削除し、空白ページに置き換えますか？'
        : `現在の${editor.document.pageIndex + 1}ページ目を削除しますか？`,
      [
        { text: 'キャンセル', style: 'cancel' },
        {
          text: '削除',
          style: 'destructive',
          onPress: () => {
            void editor.document
              .deleteCurrentPage()
              .then(() => {
                setSelectedItemId(null);
                const count = Math.max(1, editor.document.pages.length - 1);
                showPageToast(Math.min(editor.document.pageIndex, count - 1), count);
              })
              .catch(() => Alert.alert('ページを削除できませんでした'));
          },
        },
      ],
    );

  const openText = (itemId: string | null = null) => {
    const item = itemId ? editor.canvas.items.find((candidate) => candidate.id === itemId) : null;
    setEditingItemId(itemId);
    setTextDraft(item?.text ?? '');
    setTextSize(item?.fontSize ?? DEFAULT_TEXT_SIZE);
    setTextColor(item?.color ?? DEFAULT_TEXT_COLOR);
    setTextModalOpen(true);
  };

  const saveText = () => {
    if (editingItemId) {
      editor.content.updateItem(editingItemId, {
        text: textDraft,
        fontSize: textSize,
        color: textColor,
        height: Math.max(80, textSize * 3),
      });
    } else {
      editor.content.addText(textDraft, textSize, textColor);
    }
    setTextModalOpen(false);
  };

  const tapItem = (itemId: string) => {
    const alreadySelected = selectedItemId === itemId;
    setSelectedItemId(itemId);
    if (alreadySelected && editor.canvas.items.find((item) => item.id === itemId)?.kind === 'text')
      openText(itemId);
  };

  const insertPhoto = async () => {
    try {
      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ['images'],
        base64: true,
        quality: 0.7,
      });
      if (result.canceled) return;
      const asset = result.assets[0];
      if (!asset?.base64) throw new Error('画像を読み込めませんでした');
      editor.content.addImage(
        `data:image/jpeg;base64,${asset.base64}`,
        asset.width / Math.max(1, asset.height),
      );
    } catch (cause) {
      Alert.alert('写真を挿入できませんでした', String(cause));
    }
  };

  const pressEraser = () => {
    if (editor.preferences.tool !== 'eraser') {
      editor.preferences.setTool('eraser');
      return;
    }
    const choose = (mode: EraserMode) => {
      editor.preferences.setEraserMode(mode);
      editor.preferences.setTool('eraser');
    };
    Alert.alert('消しゴムの種類', '消し方を選んでください', [
      { text: 'キャンセル', style: 'cancel' },
      { text: '部分消し', onPress: () => choose('partial') },
      { text: 'ストローク消し', onPress: () => choose('stroke') },
    ]);
  };

  return {
    editor,
    tools: { pressEraser },
    navigation: { goBack: () => router.back(), changePage, confirmDeletePage },
    title: {
      editing: editingTitle,
      value: title,
      set: setTitle,
      start: () => {
        setTitle(editor.document.note?.title ?? '');
        setEditingTitle(true);
      },
      finish: () => {
        void editor.document.updateTitle(title);
        setEditingTitle(false);
      },
    },
    toast: { text: pageToast, style: toastStyle },
    text: {
      draft: textDraft,
      setDraft: setTextDraft,
      size: textSize,
      setSize: setTextSize,
      color: textColor,
      setColor: setTextColor,
      editingItemId,
      modalOpen: textModalOpen,
      close: () => setTextModalOpen(false),
      open: openText,
      save: saveText,
    },
    items: {
      selectedId: selectedItemId,
      tap: tapItem,
      insertPhoto,
      move: (itemId: string, x: number, y: number) => {
        setSelectedItemId(itemId);
        editor.content.updateItem(itemId, { x, y });
      },
      resize: (itemId: string, box: Box) => editor.content.updateItem(itemId, box),
      clearSelection: () => setSelectedItemId(null),
      delete: (itemId: string) => {
        editor.content.removeItem(itemId);
        setSelectedItemId(null);
      },
    },
  };
}

export function useNotebookLines(width: number, height: number) {
  return useMemo(() => {
    const builder = Skia.PathBuilder.Make();
    for (let y = NOTE_LINE_START; y < height; y += NOTE_LINE_SPACING) {
      builder.moveTo(0, y);
      builder.lineTo(width, y);
    }
    return builder.build();
  }, [width, height]);
}

function resizedImageBox(
  item: PageItem,
  pageSize: { width: number; height: number },
  side: ResizeSide,
  dx: number,
  dy: number,
): Box {
  const ratio = item.width / Math.max(1, item.height);
  const west = side.includes('w'),
    east = side.includes('e');
  const north = side.includes('n'),
    south = side.includes('s');
  const right = item.x + item.width,
    bottom = item.y + item.height;
  const clamp = (value: number, maximum: number, minimum = 48) => {
    const limit = Math.max(1, maximum);
    return Math.min(limit, Math.max(Math.min(minimum, limit), value));
  };
  if ((west || east) && (north || south)) {
    const horizontal = (east ? 1 : -1) * dx;
    const vertical = (south ? 1 : -1) * dy * ratio;
    const delta = Math.abs(horizontal) >= Math.abs(vertical) ? horizontal : vertical;
    const maxWidth = Math.min(
      west ? right : pageSize.width - item.x,
      (north ? bottom : pageSize.height - item.y) * ratio,
    );
    const width = clamp(item.width + delta, maxWidth, Math.max(48, 48 * ratio));
    const height = width / ratio;
    return { x: west ? right - width : item.x, y: north ? bottom - height : item.y, width, height };
  }
  if (west || east) {
    const width = clamp(item.width + (east ? dx : -dx), west ? right : pageSize.width - item.x);
    return { x: west ? right - width : item.x, y: item.y, width, height: item.height };
  }
  const height = clamp(item.height + (south ? dy : -dy), north ? bottom : pageSize.height - item.y);
  return { x: item.x, y: north ? bottom - height : item.y, width: item.width, height };
}

type ItemOverlayOptions = {
  geometry: {
    item: PageItem;
    getScale: () => number;
    pageSize: { width: number; height: number };
  };
  callbacks: {
    onTap: (id: string) => void;
    onMove: (id: string, x: number, y: number) => void;
    onResize: (id: string, box: Box) => void;
    onDragChange: (dragging: boolean) => void;
  };
};

export function useItemOverlay({
  geometry: { item, getScale, pageSize },
  callbacks: { onTap, onMove, onResize, onDragChange },
}: ItemOverlayOptions) {
  const [drag, setDrag] = useState({ x: 0, y: 0 });
  const [preview, setPreview] = useState<Box | null>(null);
  const box = preview ?? item;

  const pan = Gesture.Pan()
    .minDistance(8)
    .runOnJS(true)
    .onStart(() => onDragChange(true))
    .onUpdate((event) =>
      setDrag({ x: event.translationX / getScale(), y: event.translationY / getScale() }),
    )
    .onEnd((event) => {
      const nextX = Math.max(
        0,
        Math.min(pageSize.width - item.width, item.x + event.translationX / getScale()),
      );
      const nextY = Math.max(
        0,
        Math.min(pageSize.height - item.height, item.y + event.translationY / getScale()),
      );
      onMove(item.id, nextX, nextY);
      setDrag({ x: 0, y: 0 });
    })
    .onFinalize(() => {
      setDrag({ x: 0, y: 0 });
      onDragChange(false);
    });
  const tap = Gesture.Tap()
    .runOnJS(true)
    .onEnd(() => onTap(item.id));

  const resizeHandles = RESIZE_SIDES.map((side) => {
    const gesture = Gesture.Pan()
      .minDistance(0)
      .runOnJS(true)
      .onStart(() => onDragChange(true))
      .onUpdate((event) =>
        setPreview(
          resizedImageBox(
            item,
            pageSize,
            side,
            event.translationX / getScale(),
            event.translationY / getScale(),
          ),
        ),
      )
      .onEnd((event) => {
        if (Math.abs(event.translationX) + Math.abs(event.translationY) >= 1) {
          const next = resizedImageBox(
            item,
            pageSize,
            side,
            event.translationX / getScale(),
            event.translationY / getScale(),
          );
          if (Math.abs(next.width - item.width) >= 1 || Math.abs(next.height - item.height) >= 1)
            onResize(item.id, next);
        }
        setPreview(null);
      })
      .onFinalize(() => {
        setPreview(null);
        onDragChange(false);
      });
    const horizontal = side.includes('w') ? 0 : side.includes('e') ? 1 : 0.5;
    const vertical = side.includes('n') ? 0 : side.includes('s') ? 1 : 0.5;
    return { side, gesture, horizontal, vertical };
  });

  return {
    frame: { box, drag },
    gestures: { pan, tap, resizeHandles },
  };
}

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
