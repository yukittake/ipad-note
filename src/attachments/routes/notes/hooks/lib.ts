import type { PageContent, PageItem, Point, Stroke } from '@/infra/local/notes';
import {
  CONTEXT_MENU_HEIGHT,
  ERASER_RADIUS,
  STRAIGHTEN_MIN_LENGTH,
  type ResizeSide,
} from '../constants';
import type { Box, Selection } from './types';

export function menuCoordinates({
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

export function boundsOf(points: Point[]): Box {
  const xs = points.map((point) => point.x);
  const ys = points.map((point) => point.y);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y };
}

export function insidePolygon(point: Point, polygon: Point[]) {
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

export function strokeInsideSelection(stroke: Stroke, polygon: Point[]) {
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

export function translateSelection(selection: Selection, dx: number, dy: number): Selection {
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

export function segmentsIntersect({ from: a, to: b }: Segment, { from: c, to: d }: Segment) {
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

export function strokeTouchesEraser(stroke: Stroke, from: Point, to: Point) {
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

export function eraseStrokePortion(stroke: Stroke, from: Point, to: Point): Stroke[] {
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
export const newElementId = () => `${Date.now()}-${++elementSequence}`;

export function uniqueElements<T extends { id: string }>(elements: T[]): T[] {
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

export function uniqueContent(content: PageContent): PageContent {
  const strokes = uniqueElements(content.strokes);
  const items = uniqueElements(content.items);
  return strokes === content.strokes && items === content.items ? content : { strokes, items };
}

export function isNearlyStraight(points: Point[]) {
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

export function resizedImageBox(
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
