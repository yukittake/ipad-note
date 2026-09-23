// Skiaによる罫線生成を担うHook。
import { useMemo } from 'react';
import { Skia } from '@shopify/react-native-skia';
import { NOTE_LINE_SPACING, NOTE_LINE_START } from '../constants';

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
