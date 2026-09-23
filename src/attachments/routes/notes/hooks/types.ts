import type { Point } from '@/infra/local/notes';

export type Tool = 'pen' | 'eraser' | 'select' | 'hand';

export type Box = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type Selection = {
  id: string;
  points: Point[];
  bounds: Box;
};
