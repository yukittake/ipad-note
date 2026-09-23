// エディタ本体の状態・操作を管理するHook。
/* eslint-disable react-hooks/set-state-in-effect */
import { useEffect, useRef, useState } from 'react';
import { AppState } from 'react-native';
import {
  addPage,
  deletePage,
  getNote,
  listPages,
  loadPageContent,
  type Note,
  type Page,
  type PageContent,
  type PageItem,
  type Point,
  reloadExternalNote,
  renameNote,
  savePageContent,
  type Stroke,
} from '@/infra/local/notes';
import {
  DEFAULT_TEXT_COLOR,
  DEFAULT_TEXT_SIZE,
  HOLD_MOVE_TOLERANCE,
  STRAIGHTEN_HOLD_MS,
} from '../constants';
import { useEditorPreferences } from '../stores';
import {
  addStrokeToSpatialIndex,
  boundsOf,
  buildStrokeSpatialIndex,
  eraseStrokePortion,
  insidePolygon,
  isNearlyStraight,
  newElementId,
  removeStrokeFromSpatialIndex,
  strokeInsideSelection,
  strokeTouchesEraser,
  strokesNearEraser,
  translateSelection,
  uniqueContent,
  uniqueElements,
} from './lib';
import type { Box, Selection, Tool } from './types';

type StrokeClipboard = { strokes: Stroke[]; outline: Point[]; bounds: Box };
type SaveStatus = 'saved' | 'saving' | 'error';
type PendingSave = { pageId: string; content: PageContent };

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
  const [saveStatus, setSaveStatus] = useState<SaveStatus>('saved');
  const [lastSavedAt, setLastSavedAt] = useState<number | null>(null);
  const gesture = useRef<{
    start: Point;
    mode: 'draw' | 'erase' | 'select' | 'move';
    originals?: Stroke[];
    selectionStart?: Selection;
    selectionPoints?: Point[];
    straightened?: boolean;
  } | null>(null);
  const straightenTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingPenPointsRef = useRef<Point[]>([]);
  const penPointsFrameRef = useRef<number | null>(null);
  const strokesRef = useRef(strokes);
  const strokeSpatialIndexRef = useRef(buildStrokeSpatialIndex(strokes));
  const pendingEraserStrokesRef = useRef<Stroke[] | null>(null);
  const pendingEraserCursorRef = useRef<Point | null>(null);
  const eraserFrameRef = useRef<number | null>(null);
  const itemsRef = useRef(items);
  const draftRef = useRef(draft);
  const committedDraftIdRef = useRef<string | null>(null);
  const draftClearFrameRef = useRef<number | null>(null);
  const changingPages = useRef(false);
  const historyRef = useRef<Record<string, { past: PageContent[]; future: PageContent[] }>>({});
  const pendingSaveRef = useRef<PendingSave | null>(null);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const saveChainRef = useRef<Promise<void>>(Promise.resolve());
  const flushPersistRef = useRef<() => Promise<void>>(async () => {});
  const mountedRef = useRef(true);
  const [historyAvailability, setHistoryAvailability] = useState({
    canUndo: false,
    canRedo: false,
  });
  useEffect(() => {
    const committedId = committedDraftIdRef.current;
    if (!committedId || !strokes.some((stroke) => stroke.id === committedId)) return;
    if (draftClearFrameRef.current !== null) cancelAnimationFrame(draftClearFrameRef.current);
    draftClearFrameRef.current = requestAnimationFrame(() => {
      draftClearFrameRef.current = null;
      setDraft((current) => (current?.id === committedId ? null : current));
      if (draftRef.current?.id === committedId) draftRef.current = null;
      if (committedDraftIdRef.current === committedId) committedDraftIdRef.current = null;
    });
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
  const flushPendingPenPoints = () => {
    if (penPointsFrameRef.current !== null) cancelAnimationFrame(penPointsFrameRef.current);
    penPointsFrameRef.current = null;
    const points = pendingPenPointsRef.current;
    pendingPenPointsRef.current = [];
    const current = gesture.current;
    const stroke = draftRef.current;
    if (current?.mode !== 'draw' || !stroke || !points.length) return;
    if (current.straightened) {
      const last = points[points.length - 1];
      const next = { ...stroke, points: [stroke.points[0], last] };
      draftRef.current = next;
      setDraft(next);
    } else {
      for (const point of points) {
        const last = stroke.points[stroke.points.length - 1];
        if (Math.hypot(point.x - last.x, point.y - last.y) >= HOLD_MOVE_TOLERANCE)
          stroke.points.push(point);
      }
      scheduleStraighten();
    }
  };
  const schedulePenPointsFlush = () => {
    if (penPointsFrameRef.current !== null) return;
    penPointsFrameRef.current = requestAnimationFrame(flushPendingPenPoints);
  };
  useEffect(
    () => () => {
      mountedRef.current = false;
      clearStraightenTimer();
      if (penPointsFrameRef.current !== null) cancelAnimationFrame(penPointsFrameRef.current);
      if (draftClearFrameRef.current !== null) cancelAnimationFrame(draftClearFrameRef.current);
      if (eraserFrameRef.current !== null) cancelAnimationFrame(eraserFrameRef.current);
      void flushPersistRef.current();
    },
    [],
  );
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
    pendingPenPointsRef.current = [];
    if (penPointsFrameRef.current !== null) cancelAnimationFrame(penPointsFrameRef.current);
    penPointsFrameRef.current = null;
    committedDraftIdRef.current = null;
    if (draftClearFrameRef.current !== null) cancelAnimationFrame(draftClearFrameRef.current);
    draftClearFrameRef.current = null;
    setDraft(null);
    setEraserCursor(null);
    setLoadedPageId(null);
    setSelection(null);
    setSelectionDraft(null);
    setSelectedIds([]);
    strokesRef.current = [];
    strokeSpatialIndexRef.current = buildStrokeSpatialIndex([]);
    pendingEraserStrokesRef.current = null;
    pendingEraserCursorRef.current = null;
    if (eraserFrameRef.current !== null) cancelAnimationFrame(eraserFrameRef.current);
    eraserFrameRef.current = null;
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
          strokeSpatialIndexRef.current = buildStrokeSpatialIndex(value.strokes);
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
  const flushPersist = async () => {
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = null;
    const pending = pendingSaveRef.current;
    pendingSaveRef.current = null;
    if (!pending) return saveChainRef.current;
    const operation = saveChainRef.current
      .catch(() => {})
      .then(async () => {
        if (mountedRef.current) setSaveStatus('saving');
        await savePageContent(noteId, pending.pageId, pending.content);
      });
    saveChainRef.current = operation;
    try {
      await operation;
      if (mountedRef.current) {
        setStorageError('');
        if (!pendingSaveRef.current && saveChainRef.current === operation) {
          setLastSavedAt(Date.now());
          setSaveStatus('saved');
        }
      }
    } catch (error) {
      if (mountedRef.current) {
        setSaveStatus('error');
        setStorageError(`保存できませんでした: ${String(error)}`);
        setAccessError(String(error));
        setLoadedPageId(null);
      }
    }
  };
  useEffect(() => {
    flushPersistRef.current = flushPersist;
  });
  const persist = (pageId: string, content: PageContent) => {
    pendingSaveRef.current = { pageId, content };
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => {
      saveTimerRef.current = null;
      void flushPersistRef.current();
    }, 500);
  };
  useEffect(() => {
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'inactive' || state === 'background') void flushPersistRef.current();
    });
    return () => subscription.remove();
  }, []);
  useEffect(() => () => void flushPersistRef.current(), [pageId]);

  const scheduleEraserRender = () => {
    if (eraserFrameRef.current !== null) return;
    eraserFrameRef.current = requestAnimationFrame(() => {
      eraserFrameRef.current = null;
      const nextStrokes = pendingEraserStrokesRef.current;
      const nextCursor = pendingEraserCursorRef.current;
      pendingEraserStrokesRef.current = null;
      pendingEraserCursorRef.current = null;
      if (nextStrokes) setStrokes(nextStrokes);
      if (nextCursor) setEraserCursor(nextCursor);
    });
  };
  const flushEraserRender = (cursor: Point | null) => {
    if (eraserFrameRef.current !== null) cancelAnimationFrame(eraserFrameRef.current);
    eraserFrameRef.current = null;
    const nextStrokes = pendingEraserStrokesRef.current;
    pendingEraserStrokesRef.current = null;
    pendingEraserCursorRef.current = null;
    if (nextStrokes) setStrokes(nextStrokes);
    setEraserCursor(cursor);
  };
  const commitEraserChanges = (next: Stroke[], removed: Stroke[], added: Stroke[]) => {
    const index = strokeSpatialIndexRef.current;
    for (const stroke of removed) removeStrokeFromSpatialIndex(index, stroke);
    for (const stroke of added) addStrokeToSpatialIndex(index, stroke);
    strokesRef.current = next;
    pendingEraserStrokesRef.current = next;
    scheduleEraserRender();
  };

  const commit = (next: Stroke[], recordChange = true, saveChange = true) => {
    if (next === strokesRef.current) return;
    next = uniqueElements(next);
    if (recordChange) record(strokesRef.current, next);
    setStrokes(next);
    strokesRef.current = next;
    strokeSpatialIndexRef.current = buildStrokeSpatialIndex(next);
    if (page && saveChange) persist(page.id, { strokes: next, items: itemsRef.current });
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
      committedDraftIdRef.current = null;
      if (draftClearFrameRef.current !== null) cancelAnimationFrame(draftClearFrameRef.current);
      draftClearFrameRef.current = null;
      pendingPenPointsRef.current = [];
      if (penPointsFrameRef.current !== null) cancelAnimationFrame(penPointsFrameRef.current);
      penPointsFrameRef.current = null;
      const stroke = { id: newElementId(), color, width, points: [point] };
      gesture.current = { start: point, mode: 'draw' };
      setDraft(null);
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
    const candidates = strokesNearEraser(strokeSpatialIndexRef.current, from, to);
    if (!candidates.size) return;
    const changes: { index: number; original: Stroke; replacements: Stroke[] }[] = [];
    for (const stroke of candidates) {
      const index = current.indexOf(stroke);
      if (index < 0) continue;
      if (eraserMode === 'stroke') {
        if (strokeTouchesEraser(stroke, from, to))
          changes.push({ index, original: stroke, replacements: [] });
      } else {
        const replacements = eraseStrokePortion(stroke, from, to);
        if (replacements.length !== 1 || replacements[0] !== stroke)
          changes.push({ index, original: stroke, replacements });
      }
    }
    if (!changes.length) return;
    const next = current.slice();
    changes.sort((left, right) => right.index - left.index);
    for (const change of changes) next.splice(change.index, 1, ...change.replacements);
    commitEraserChanges(
      next,
      changes.map((change) => change.original),
      changes.flatMap((change) => change.replacements),
    );
  };

  const move = (point: Point) => {
    const current = gesture.current;
    if (!current) return;
    if (current.mode === 'draw') {
      pendingPenPointsRef.current.push(point);
      schedulePenPointsFlush();
    } else if (current.mode === 'erase') {
      pendingEraserCursorRef.current = point;
      scheduleEraserRender();
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
    if (current.mode === 'draw') {
      pendingPenPointsRef.current.push(point);
      flushPendingPenPoints();
    }
    clearStraightenTimer();
    if (current.mode === 'draw' && draftRef.current) {
      const stroke = draftRef.current;
      committedDraftIdRef.current = stroke.id;
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
    } else if (current.mode === 'erase') {
      erase(current.start, point);
      flushEraserRender(null);
      if (current.originals && current.originals !== strokesRef.current) {
        record(current.originals, strokesRef.current);
        if (page) persist(page.id, { strokes: strokesRef.current, items: itemsRef.current });
      }
    } else if (current.mode === 'select') {
      setEraserCursor(null);
      const points = [...(current.selectionPoints ?? [current.start]), point];
      const bounds = boundsOf(points);
      const ids = strokesRef.current
        .filter((stroke) => points.length >= 3 && strokeInsideSelection(stroke, points))
        .map((stroke) => stroke.id);
      setSelectedIds(ids);
      setSelection(ids.length ? { id: newElementId(), points, bounds } : null);
      setSelectionDraft(null);
    } else if (current.mode === 'move' && current.originals) {
      setEraserCursor(null);
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
    clearStraightenTimer();
    if (current.mode === 'draw') {
      pendingPenPointsRef.current = [];
      if (penPointsFrameRef.current !== null) cancelAnimationFrame(penPointsFrameRef.current);
      penPointsFrameRef.current = null;
      setEraserCursor(null);
      draftRef.current = null;
      setDraft(null);
    } else if (current.mode === 'move' && current.originals) {
      setEraserCursor(null);
      strokesRef.current = current.originals;
      setStrokes(current.originals);
      if (current.selectionStart) setSelection(current.selectionStart);
    } else if (current.mode === 'erase' && current.originals) {
      if (eraserFrameRef.current !== null) cancelAnimationFrame(eraserFrameRef.current);
      eraserFrameRef.current = null;
      pendingEraserStrokesRef.current = null;
      pendingEraserCursorRef.current = null;
      strokesRef.current = current.originals;
      strokeSpatialIndexRef.current = buildStrokeSpatialIndex(current.originals);
      setStrokes(current.originals);
      setEraserCursor(null);
    } else if (current.mode === 'select') {
      setEraserCursor(null);
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
    strokeSpatialIndexRef.current = buildStrokeSpatialIndex(previous.strokes);
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
    strokeSpatialIndexRef.current = buildStrokeSpatialIndex(next.strokes);
    itemsRef.current = next.items;
    setStrokes(next.strokes);
    setItems(next.items);
    persist(page.id, next);
  };
  const appendPage = async () => {
    if (changingPages.current || loadedPageId !== page?.id) return;
    changingPages.current = true;
    try {
      await flushPersist();
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
      await flushPersist();
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
        await flushPersist();
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
      setPageIndex: (index: number) => {
        void flushPersist();
        setPageIndex(index);
      },
      saveStatus,
      lastSavedAt,
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
