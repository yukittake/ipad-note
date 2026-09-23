// アイテム移動・リサイズを扱うHook。
import { useState } from 'react';
import { Gesture } from 'react-native-gesture-handler';
import type { PageItem } from '@/infra/local/notes';
import { RESIZE_SIDES } from '../constants';
import { resizedImageBox } from './lib';
import type { Box } from './types';

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
