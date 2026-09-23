import { FlatList, Pressable, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { readableFolderUri, useHomeScreen } from '../hooks';
import { isNoteFolderConnected, type Note } from '@/infra/local/notes';

function NoteCard({
  note,
  details,
  actions,
}: {
  note: Note;
  details: { visible: boolean };
  actions: { open: () => void; toggleDetails: () => void; delete: () => void };
}) {
  const location = note.external_uri
    ? isNoteFolderConnected(note)
      ? '外部フォルダ'
      : '外部フォルダの再接続が必要'
    : 'アプリ内保存';

  return (
    <Pressable style={styles.card} onPress={actions.open}>
      <View style={styles.preview}>
        <Text style={styles.previewIcon}>✎</Text>
      </View>
      <View style={styles.cardFooter}>
        <View style={styles.cardDetails}>
          <Text style={styles.title}>{note.title}</Text>
          <Text style={styles.date}>{new Date(note.updated_at).toLocaleDateString('ja-JP')}</Text>
          <Text style={styles.date}>{location}</Text>
          {note.external_uri && details.visible && (
            <Text selectable style={styles.uri}>
              {readableFolderUri(note.external_uri)}
            </Text>
          )}
        </View>
        <View style={styles.cardActions}>
          {note.external_uri && (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="保存先ディレクトリを表示"
              accessibilityState={{ expanded: details.visible }}
              hitSlop={8}
              onPress={(event) => {
                event.stopPropagation();
                actions.toggleDetails();
              }}
            >
              <Text style={styles.info}>ⓘ</Text>
            </Pressable>
          )}
          <Pressable
            hitSlop={12}
            onPress={(event) => {
              event.stopPropagation();
              actions.delete();
            }}
          >
            <Text style={styles.delete}>削除</Text>
          </Pressable>
        </View>
      </View>
    </Pressable>
  );
}

export function HomeScreen() {
  const { list, actions } = useHomeScreen();

  return (
    <SafeAreaView style={styles.root}>
      <View style={styles.header}>
        <Text style={styles.heading}>ノート</Text>
        <View style={styles.headerActions}>
          <Pressable style={styles.secondaryAction} onPress={actions.openTrash}>
            <Text style={styles.secondaryActionText}>ゴミ箱</Text>
          </Pressable>
          <Pressable style={styles.add} onPress={actions.connectFolder}>
            <Text style={styles.addText}>外部フォルダを追加</Text>
          </Pressable>
          <Pressable style={styles.add} onPress={actions.chooseNewNoteLocation}>
            <Text style={styles.addText}>＋ 新しいノート</Text>
          </Pressable>
        </View>
      </View>
      {!!list.error && <Text style={styles.error}>{list.error}</Text>}
      <FlatList
        data={list.notes}
        keyExtractor={(note) => note.id}
        numColumns={2}
        contentContainerStyle={styles.list}
        ListEmptyComponent={
          <Text style={styles.empty}>ノートはまだありません。新しいノートを作成してください。</Text>
        }
        renderItem={({ item }) => (
          <NoteCard
            note={item}
            details={{ visible: list.detailsNoteId === item.id }}
            actions={{
              open: () => actions.openNote(item.id),
              toggleDetails: () =>
                list.setDetailsNoteId((current) => (current === item.id ? null : item.id)),
              delete: () => actions.confirmDelete(item),
            }}
          />
        )}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#f4f3ef' },
  header: {
    paddingHorizontal: 32,
    paddingVertical: 24,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  headerActions: { flexDirection: 'row', gap: 12 },
  heading: { fontSize: 34, fontWeight: '700', color: '#252927' },
  add: { backgroundColor: '#314f72', borderRadius: 12, paddingHorizontal: 18, paddingVertical: 12 },
  addText: { color: 'white', fontWeight: '700' },
  secondaryAction: {
    borderColor: '#314f72',
    borderRadius: 12,
    borderWidth: 1,
    paddingHorizontal: 18,
    paddingVertical: 12,
  },
  secondaryActionText: { color: '#314f72', fontWeight: '700' },
  list: { paddingHorizontal: 24, paddingBottom: 32 },
  card: {
    backgroundColor: 'white',
    borderRadius: 16,
    margin: 8,
    width: 230,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: '#e0dfd9',
  },
  preview: {
    height: 160,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#fffdf7',
  },
  previewIcon: { fontSize: 52, color: '#c8d0d4' },
  cardFooter: {
    padding: 16,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: 8,
  },
  cardDetails: { flex: 1, minWidth: 0 },
  cardActions: { alignItems: 'center', gap: 10 },
  title: { fontSize: 17, fontWeight: '600', color: '#252927' },
  date: { color: '#777', marginTop: 5 },
  uri: { color: '#777', fontSize: 11, marginTop: 6 },
  info: { color: '#314f72', fontSize: 22 },
  delete: { color: '#a34a4a' },
  empty: { margin: 16, color: '#777', fontSize: 16 },
  error: { color: '#a34a4a', marginHorizontal: 32 },
});
