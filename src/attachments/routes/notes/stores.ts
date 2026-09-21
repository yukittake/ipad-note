import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import type { Tool } from './hooks';
import { DEFAULT_INK_COLOR, DEFAULT_INK_WIDTH } from './constants';
import { editorPreferencesStorage } from '@/infra/local/preferences';

export type InputMode = 'finger' | 'stylus';
export type EraserMode = 'partial' | 'stroke';

type EditorPreferences = {
  settings: {
    tool: Tool;
    inputMode: InputMode;
    eraserMode: EraserMode;
    color: string;
    width: number;
  };
  actions: {
    setTool: (tool: Tool) => void;
    setInputMode: (mode: InputMode) => void;
    setEraserMode: (mode: EraserMode) => void;
    setColor: (color: string) => void;
    setWidth: (width: number) => void;
  };
};

export const useEditorPreferences = create<EditorPreferences>()(
  persist<EditorPreferences, [], [], Pick<EditorPreferences, 'settings'>>(
    (set) => ({
      settings: {
        tool: 'pen',
        inputMode: 'finger',
        eraserMode: 'stroke',
        color: DEFAULT_INK_COLOR,
        width: DEFAULT_INK_WIDTH,
      },
      actions: {
        setTool: (tool) => set((state) => ({ settings: { ...state.settings, tool } })),
        setInputMode: (inputMode) =>
          set((state) => ({ settings: { ...state.settings, inputMode } })),
        setEraserMode: (eraserMode) =>
          set((state) => ({ settings: { ...state.settings, eraserMode } })),
        setColor: (color) => set((state) => ({ settings: { ...state.settings, color } })),
        setWidth: (width) => set((state) => ({ settings: { ...state.settings, width } })),
      },
    }),
    {
      name: 'editor',
      storage: createJSONStorage(() => editorPreferencesStorage),
      partialize: ({ settings }) => ({ settings }),
      version: 1,
      migrate: (persistedState) => {
        const saved = persistedState as Partial<Pick<EditorPreferences, 'settings'>>;
        return {
          settings: {
            tool: saved.settings?.tool ?? 'pen',
            inputMode: saved.settings?.inputMode ?? 'finger',
            eraserMode: saved.settings?.eraserMode ?? 'stroke',
            color: saved.settings?.color ?? DEFAULT_INK_COLOR,
            width: saved.settings?.width ?? DEFAULT_INK_WIDTH,
          },
        };
      },
    },
  ),
);
