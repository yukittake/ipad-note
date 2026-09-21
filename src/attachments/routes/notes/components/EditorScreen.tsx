import { Modal, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { SymbolView } from 'expo-symbols';
import type { SymbolViewProps } from 'expo-symbols';
import Animated from 'react-native-reanimated';
import { DrawingCanvas } from './DrawingCanvas';
import { Tool, useEditorScreen } from '../hooks';
import type { InputMode } from '../stores';
import { INK_COLORS, INK_WIDTHS, NOTE_PAPER_COLOR, TEXT_SIZES } from '../constants';
import { isNoteFolderConnected } from '@/infra/local/notes';

export function EditorScreen() {
  const { editor, tools, navigation, title, toast, text, items } = useEditorScreen();
  if (!editor.document.note)
    return (
      <SafeAreaView style={styles.root}>
        <Text style={styles.loading}>ノートを読み込み中…</Text>
      </SafeAreaView>
    );
  if (
    editor.document.note.external_uri &&
    (!isNoteFolderConnected(editor.document.note) || editor.document.accessError)
  )
    return (
      <SafeAreaView style={styles.root}>
        <View style={extraStyles.unavailable}>
          <Text style={styles.title}>外部ノートを読み込めません</Text>
          <Text style={extraStyles.unavailableText}>
            外部ファイルを確認できるまで、このノートの閲覧と編集はできません。フォルダを再接続した後、再読み込みしてください。
          </Text>
          {!!editor.document.accessError && (
            <Text style={extraStyles.unavailableText}>{editor.document.accessError}</Text>
          )}
          <Pressable style={extraStyles.reloadButton} onPress={editor.document.reload}>
            <Text style={styles.activeText}>再読み込み</Text>
          </Pressable>
          <Pressable onPress={() => navigation.goBack()}>
            <Text style={styles.back}>ノート一覧へ戻る</Text>
          </Pressable>
        </View>
      </SafeAreaView>
    );
  const toolButton = (value: Tool, label: string, name: SymbolViewProps['name']) => (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityHint={value === 'eraser' ? 'もう一度押すと消し方を選べます' : undefined}
      accessibilityState={{ selected: editor.preferences.tool === value }}
      style={[styles.tool, editor.preferences.tool === value && styles.active]}
      onPress={() => (value === 'eraser' ? tools.pressEraser() : editor.preferences.setTool(value))}
    >
      <SymbolView
        name={name}
        tintColor={editor.preferences.tool === value ? '#fff' : '#303a43'}
        size={value === 'eraser' ? 22 : 25}
      />
      {value === 'eraser' && (
        <Text
          style={[styles.eraserModeLabel, editor.preferences.tool === value && styles.activeText]}
        >
          {editor.preferences.eraserMode === 'partial' ? '部分' : '線'}
        </Text>
      )}
    </Pressable>
  );
  const historyButton = ({
    label,
    enabled,
    name,
    onPress,
  }: {
    label: string;
    enabled: boolean;
    name: SymbolViewProps['name'];
    onPress: () => void;
  }) => (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: !enabled }}
      disabled={!enabled}
      style={[extraStyles.historyButton, !enabled && extraStyles.historyDisabled]}
      onPress={onPress}
    >
      <SymbolView name={name} tintColor="#303a43" size={23} />
    </Pressable>
  );
  const modeButton = (value: InputMode, label: string) => (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ selected: editor.preferences.inputMode === value }}
      style={[styles.mode, editor.preferences.inputMode === value && styles.active]}
      onPress={() => editor.preferences.setInputMode(value)}
    >
      <Text style={[styles.modeText, editor.preferences.inputMode === value && styles.activeText]}>
        {label}
      </Text>
    </Pressable>
  );
  return (
    <SafeAreaView style={styles.root}>
      {!!editor.document.storageError && (
        <Text style={extraStyles.syncNotice}>{editor.document.storageError}</Text>
      )}
      <View style={styles.top}>
        <Pressable onPress={() => navigation.goBack()}>
          <Text style={styles.back}>‹ ノート</Text>
        </Pressable>
        {title.editing ? (
          <TextInput
            autoFocus
            selectTextOnFocus
            style={styles.titleInput}
            value={title.value}
            onChangeText={title.set}
            onSubmitEditing={title.finish}
            onBlur={title.finish}
          />
        ) : (
          <Pressable onPress={title.start}>
            <Text style={styles.title}>{editor.document.note.title} ✎</Text>
          </Pressable>
        )}
        <View style={styles.pageActions}>
          <Text style={styles.pageCount}>
            {editor.document.pageIndex + 1} / {editor.document.pages.length} ページ
          </Text>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="現在のページを削除"
            hitSlop={10}
            onPress={navigation.confirmDeletePage}
          >
            <SymbolView
              name={{ ios: 'trash', android: 'delete', web: 'delete' }}
              tintColor="#a34a4a"
              size={23}
            />
          </Pressable>
        </View>
      </View>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        style={styles.toolbar}
        contentContainerStyle={styles.toolbarContent}
      >
        {toolButton('hand', '指で移動・拡大縮小', {
          ios: 'hand.draw',
          android: 'pan_tool',
          web: 'pan_tool',
        })}
        {toolButton('pen', 'ペン', { ios: 'pencil', android: 'draw', web: 'draw' })}
        {toolButton(
          'eraser',
          `消しゴム（${editor.preferences.eraserMode === 'partial' ? '部分消し' : 'ストローク消し'}）`,
          {
            ios: 'eraser',
            android: 'ink_eraser',
            web: 'ink_eraser',
          },
        )}
        {toolButton('select', '範囲選択', { ios: 'lasso', android: 'gesture', web: 'gesture' })}
        <Pressable style={styles.tool} accessibilityLabel="文字を追加" onPress={() => text.open()}>
          <SymbolView
            name={{ ios: 'textformat', android: 'text_fields', web: 'text_fields' }}
            tintColor="#303a43"
            size={25}
          />
        </Pressable>
        <Pressable
          style={styles.tool}
          accessibilityLabel="写真を追加"
          onPress={() => {
            void items.insertPhoto();
          }}
        >
          <SymbolView
            name={{ ios: 'photo', android: 'image', web: 'image' }}
            tintColor="#303a43"
            size={25}
          />
        </Pressable>
        <View style={styles.divider} />
        {historyButton({
          label: '元に戻す',
          enabled: editor.history.canUndo,
          name: { ios: 'arrow.uturn.backward', android: 'undo', web: 'undo' },
          onPress: editor.history.undo,
        })}
        {historyButton({
          label: 'やり直す',
          enabled: editor.history.canRedo,
          name: { ios: 'arrow.uturn.forward', android: 'redo', web: 'redo' },
          onPress: editor.history.redo,
        })}
        <View style={styles.divider} />
        {INK_COLORS.map((color) => (
          <Pressable
            key={color}
            accessibilityLabel={`${color}のインク`}
            style={[
              styles.color,
              { backgroundColor: color },
              editor.preferences.color === color && styles.selectedColor,
            ]}
            onPress={() => {
              editor.preferences.setColor(color);
              editor.preferences.setTool('pen');
            }}
          />
        ))}
        {INK_WIDTHS.map((width) => (
          <Pressable
            key={width}
            style={[styles.width, editor.preferences.width === width && styles.active]}
            onPress={() => editor.preferences.setWidth(width)}
          >
            <View
              style={{
                width: width + 5,
                height: width + 5,
                borderRadius: 10,
                backgroundColor: '#263543',
              }}
            />
          </Pressable>
        ))}
        <View style={styles.modeGroup}>
          {modeButton('finger', '指で描画')}
          {modeButton('stylus', 'タッチペン')}
        </View>
      </ScrollView>
      <View style={styles.canvas}>
        <DrawingCanvas
          key={editor.document.pages[editor.document.pageIndex]?.id}
          content={{
            strokes: editor.canvas.strokes,
            items: editor.canvas.items,
            draft: editor.canvas.draft,
            eraserCursor: editor.canvas.eraserCursor,
          }}
          selectionState={{
            itemId: items.selectedId,
            strokeIds: editor.selection.selectedIds,
            outline: editor.selection.outline,
            draft: editor.selection.draft,
            onDelete: editor.selection.remove,
          }}
          itemActions={{
            onPress: items.tap,
            onMove: items.move,
            onResize: items.resize,
            onBackgroundTap: items.clearSelection,
            onEdit: text.open,
            onDelete: items.delete,
          }}
          drawing={{
            tool: editor.preferences.tool,
            inputMode: editor.preferences.inputMode,
            begin: editor.canvas.begin,
            move: editor.canvas.move,
            end: editor.canvas.end,
            cancel: editor.canvas.cancel,
          }}
          pages={{ canGoPrevious: editor.document.pageIndex > 0, onChange: navigation.changePage }}
        />
        {!!toast.text && (
          <Animated.View pointerEvents="none" style={[extraStyles.pageToast, toast.style]}>
            <Text style={extraStyles.pageToastText}>{toast.text}</Text>
          </Animated.View>
        )}
      </View>
      <Modal visible={text.modalOpen} transparent animationType="fade" onRequestClose={text.close}>
        <View style={extraStyles.modalBackdrop}>
          <View style={extraStyles.modalCard}>
            <Text style={styles.title}>{text.editingItemId ? '文字を編集' : '文字を追加'}</Text>
            <TextInput
              autoFocus
              multiline
              placeholder="文字を入力"
              value={text.draft}
              onChangeText={text.setDraft}
              style={extraStyles.textEditor}
            />
            <View style={extraStyles.textOptions}>
              <Text>文字サイズ</Text>
              {TEXT_SIZES.map((size) => (
                <Pressable
                  key={size}
                  accessibilityRole="button"
                  accessibilityLabel={`文字サイズ ${size}`}
                  accessibilityState={{ selected: text.size === size }}
                  style={[extraStyles.sizeOption, text.size === size && extraStyles.selectedOption]}
                  onPress={() => text.setSize(size)}
                >
                  <Text style={text.size === size && styles.activeText}>{size}</Text>
                </Pressable>
              ))}
            </View>
            <View style={extraStyles.textOptions}>
              <Text>文字色</Text>
              {INK_COLORS.map((color) => (
                <Pressable
                  key={color}
                  accessibilityRole="button"
                  accessibilityLabel={`文字色 ${color}`}
                  accessibilityState={{ selected: text.color === color }}
                  style={[
                    styles.color,
                    { backgroundColor: color },
                    text.color === color && styles.selectedColor,
                  ]}
                  onPress={() => text.setColor(color)}
                />
              ))}
            </View>
            <View style={extraStyles.modalButtons}>
              <Pressable onPress={text.close}>
                <Text style={styles.back}>キャンセル</Text>
              </Pressable>
              <Pressable onPress={text.save}>
                <Text style={styles.back}>保存</Text>
              </Pressable>
            </View>
          </View>
        </View>
      </Modal>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#f4f3ef' },
  loading: { margin: 30 },
  top: {
    height: 64,
    paddingHorizontal: 24,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  back: { color: '#314f72', fontSize: 17 },
  title: { fontSize: 20, fontWeight: '700', color: '#252927' },
  titleInput: { fontSize: 20, minWidth: 220, borderBottomWidth: 1, borderColor: '#314f72' },
  pageActions: { flexDirection: 'row', alignItems: 'center', gap: 18 },
  pageCount: { color: '#666' },
  toolbar: {
    flexGrow: 0,
    minHeight: 64,
  },
  toolbarContent: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 20,
    gap: 8,
  },
  tool: {
    width: 48,
    height: 44,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 9,
    backgroundColor: '#e9e8e3',
  },
  active: { backgroundColor: '#314f72' },
  activeText: { color: '#fff' },
  eraserModeLabel: { fontSize: 10, lineHeight: 11, color: '#303a43' },
  divider: { width: 1, height: 28, backgroundColor: '#cecec8', marginHorizontal: 8 },
  color: { height: 27, width: 27, borderRadius: 14, marginHorizontal: 3 },
  selectedColor: {
    borderWidth: 3,
    borderColor: '#f4f3ef',
    outlineWidth: 2,
    outlineColor: '#314f72',
  },
  width: { width: 35, height: 35, alignItems: 'center', justifyContent: 'center', borderRadius: 8 },
  remove: { marginLeft: 10 },
  removeText: { color: '#ae4242' },
  modeGroup: {
    marginLeft: 'auto',
    flexDirection: 'row',
    backgroundColor: '#e9e8e3',
    borderRadius: 9,
    overflow: 'hidden',
  },
  mode: { paddingHorizontal: 13, paddingVertical: 11 },
  modeText: { color: '#303a43', fontWeight: '600' },
  canvas: {
    flex: 1,
    marginHorizontal: 20,
    borderWidth: 1,
    borderColor: '#deddd7',
    overflow: 'hidden',
  },
});

const extraStyles = StyleSheet.create({
  unavailable: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 32, gap: 20 },
  unavailableText: {
    maxWidth: 520,
    fontSize: 16,
    lineHeight: 24,
    color: '#5c646a',
    textAlign: 'center',
  },
  reloadButton: {
    backgroundColor: '#314f72',
    borderRadius: 10,
    paddingHorizontal: 20,
    paddingVertical: 12,
  },
  historyButton: {
    width: 42,
    height: 44,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 9,
    backgroundColor: '#e9e8e3',
  },
  historyDisabled: { opacity: 0.35 },
  pageToast: {
    position: 'absolute',
    alignSelf: 'center',
    top: 16,
    zIndex: 10,
    backgroundColor: '#314f72',
    borderRadius: 18,
    paddingHorizontal: 18,
    paddingVertical: 8,
  },
  pageToastText: { color: '#fff', fontSize: 16, fontWeight: '700' },
  modalBackdrop: {
    flex: 1,
    backgroundColor: '#0008',
    alignItems: 'center',
    justifyContent: 'center',
  },
  modalCard: {
    width: '75%',
    padding: 24,
    borderRadius: 16,
    backgroundColor: NOTE_PAPER_COLOR,
    gap: 20,
  },
  textEditor: {
    minHeight: 120,
    borderWidth: 1,
    borderColor: '#cecec8',
    borderRadius: 8,
    padding: 12,
    fontSize: 20,
    textAlignVertical: 'top',
  },
  textOptions: { flexDirection: 'row', alignItems: 'center', gap: 10, flexWrap: 'wrap' },
  sizeOption: {
    minWidth: 38,
    paddingHorizontal: 8,
    paddingVertical: 7,
    alignItems: 'center',
    borderRadius: 8,
    backgroundColor: '#e9e8e3',
  },
  selectedOption: { backgroundColor: '#314f72' },
  modalButtons: { flexDirection: 'row', justifyContent: 'flex-end', gap: 24 },
  syncNotice: {
    paddingHorizontal: 24,
    paddingVertical: 8,
    color: '#8a5a19',
    backgroundColor: '#fff0d0',
  },
});
