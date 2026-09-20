# Expo HAS CHANGED

Read the exact versioned docs at https://docs.expo.dev/versions/v57.0.0/ before writing any code.

<!-- BEGIN: project-trules -->

# 基本ディレクトリ構造
src/
├── app/
│   ├── index.tsx     <!-- app/の中はURL管理のみを行う。よってindex.tsx, _layout.tsx,その他最低限のファイルのみ() -->
│   ├── _layout.tsx
│   └── privacy/
│       ├── index.tsx
│       └── _layout.tsx
├── attachments/
│   ├── routes/     <!-- ルートごと -->
│   │   ├── root/   <!-- 基本以下の1ディレクトリ、4ファイルから構成する。 -->
│   │   │   ├── components/     <!-- 見た目部分をまとめたディレクトリ。 -->
│   │   │   ├── hooks.ts        <!-- react hooksを書く。書き方は後述。一般の関数もここ。 -->
│   │   │   ├── constants.ts       
│   │   │   └── stores.ts       <!-- ファイルを跨いだ状態管理(zustandなど) -->
│   │   └── privacy/
│   │       ├── components/
│   │       ├── hooks.ts
│   │       └── stores.ts
│   └── common/      <!-- ルート横断で使える -->
│       └── forms/
│           ├── components/
│           └── stores.ts
├── infra/           <!-- 外への通信はここ。DBの種類が切り替わったときなどに修正しやすいようにする。 -->
│   └── supabase/     <!-- supabase.** などの呼び出しはここ以外で行ってはいけない。 -->
└── test/


## hooks.tsの例
```
function useUser(id: string) {
  const [user, setUser] = useState<User | null>(null)

  useEffect(() => {
    logic(id).then(setUser)
  }, [id])

  const updateName = (name: string) => {
    setUser(current =>
      current
        ? {
            ...current,
            name,
          }
        : null
    )
  }

  const clearUser = () => {
    setUser(null)
  }

  return {          // 戻り値の数が多くなる場合はjson形式をうまく活用してリーダブルに
    user,
    updateName,
    clearUser,
  }
}
```

# ファイルごとのルール

## index.tsx
index.tsxファイルが大きくなりすぎないように、要素ごとにコンポーネントに分解し、
コンポーネントごとにファイルを作成してcomponentsディレクトリに入れること。

<!-- END: project-rules -->

