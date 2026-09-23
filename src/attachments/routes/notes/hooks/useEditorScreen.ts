// 画面状態、Router、ImagePickerなどを管理するHook。
/* eslint-disable react-hooks/immutability, react-hooks/set-state-in-effect */
import { useEffect, useRef, useState } from 'react';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { Alert } from 'react-native';
import * as ImagePicker from 'expo-image-picker';
import { useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated';
import { DEFAULT_TEXT_COLOR, DEFAULT_TEXT_SIZE } from '../constants';
import type { EraserMode } from '../stores';
import type { Box } from './types';
import { useEditor } from './useEditor';

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
