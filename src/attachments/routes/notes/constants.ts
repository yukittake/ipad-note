export const INK_COLORS = ['#202a36', '#d2493d', '#246fb1', '#268160'];
export const INK_WIDTHS = [2, 4, 8];
export const TEXT_SIZES = [16, 22, 28, 36, 48];
export const DEFAULT_TEXT_SIZE = 22;
export const DEFAULT_TEXT_COLOR = INK_COLORS[0];
export const DEFAULT_INK_COLOR = INK_COLORS[0];
export const DEFAULT_INK_WIDTH = 3;
export const NOTE_PAPER_COLOR = '#fffdf4';
export const NOTE_RULE_COLOR = '#d9e4e7';
export const ERASER_RADIUS = 12;
export const CONTEXT_MENU_HEIGHT = 56;

export const STRAIGHTEN_HOLD_MS = 1000;
export const STRAIGHTEN_MIN_LENGTH = 12;
export const HOLD_MOVE_TOLERANCE = 1;

export type ResizeSide = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w';
export const RESIZE_SIDES: ResizeSide[] = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];
export const RESIZE_NAMES: Record<ResizeSide, string> = {
  nw: '左上',
  n: '上',
  ne: '右上',
  e: '右',
  se: '右下',
  s: '下',
  sw: '左下',
  w: '左',
};

export const NOTE_LINE_START = 48;
export const NOTE_LINE_SPACING = 36;
