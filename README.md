# DriveSync Tube

車内用リアルタイムYouTube共有プレイヤー

## 概要

車内という閉じた空間で、複数のユーザー（乗員）が各自のスマートフォンから共通の再生リストを操作するWebアプリケーションです。

- **ホスト（車載モニター）** が動画を再生
- **ゲスト（同乗者）** がリモコンとして動画を追加・操作

トンネルや山間部での通信断絶・リロードに対して堅牢な設計になっています。

## 技術スタック

| レイヤー | 技術 |
|---|---|
| インフラ | Docker Compose |
| データベース | PostgreSQL 15 (Alpine) |
| バックエンド | Hono, Prisma ORM, WebSocket (`@hono/node-ws`) |
| フロントエンド | Vite, React 19 (TypeScript), Tailwind CSS, React Router DOM |
| 動画再生 | YouTube IFrame Player API |

## ディレクトリ構成

```
.
├── docker-compose.yml
├── .env
├── backend/
│   ├── Dockerfile
│   ├── package.json
│   ├── tsconfig.json
│   ├── prisma/
│   │   └── schema.prisma
│   └── src/
│       ├── index.ts          # REST API エンドポイント
│       ├── db.ts             # Prisma クライアント
│       └── websocket.ts      # WebSocket ハンドラ
└── frontend/
    ├── Dockerfile
    ├── package.json
    ├── vite.config.ts
    ├── tailwind.config.js
    └── src/
        ├── main.tsx
        ├── App.tsx            # ルーティング設定
        ├── pages/
        │   ├── TopPage.tsx    # ルーム作成・参加
        │   ├── HostPage.tsx   # 動画再生（ホスト画面）
        │   └── GuestPage.tsx  # リモコン（ゲスト画面）
        ├── hooks/
        │   ├── useSocket.ts         # WebSocket（自動再接続・ハートビート）
        │   └── useUserIdentity.ts   # LocalStorage によるユーザーID管理
        ├── lib/
        │   └── config.ts     # API/WS URL 解決
        └── types/
            └── index.ts      # 共有型定義
```

## セットアップ

### 前提条件

- Docker および Docker Compose がインストール済みであること

### 環境変数

プロジェクトルートの `.env` ファイルに以下を設定してください。

```env
POSTGRES_USER=drivesync
POSTGRES_PASSWORD=drivesync_pass
POSTGRES_DB=drivesync_db
YOUTUBE_API_KEY=YOUR_YOUTUBE_API_KEY
```

`YOUTUBE_API_KEY` には [Google Cloud Console](https://console.cloud.google.com/) で取得した YouTube Data API v3 のキーを設定してください。

### 起動

```bash
docker compose up --build
```

以下のサービスが起動します。

| サービス | ポート | 説明 |
|---|---|---|
| db | 5432 | PostgreSQL |
| backend | 3000 | Hono API + WebSocket サーバー |
| frontend | 5173 | Vite 開発サーバー |

起動後、ブラウザで `http://localhost:5173` にアクセスしてください。

### スマートフォンからのアクセス

同じ Wi-Fi ネットワークに接続し、ホストマシンの LAN IP アドレスでアクセスします。

```
http://192.168.x.x:5173
```

フロントエンドはブラウザのホスト名から API / WebSocket の URL を自動解決するため、環境変数 `VITE_API_URL` / `VITE_WS_URL` の設定は通常不要です。

## 使い方

### 1. ルームを作成する（ホスト）

1. トップページで「ルームを作成」をタップ
2. ホスト画面（`/host/:roomCode`）に遷移し、QRコードが表示される
3. 動画再生の準備ができたら画面をタップ（ブラウザの自動再生制限対策）

### 2. ルームに参加する（ゲスト）

1. ホスト画面の QR コードを読み取る、またはルームコードを入力して参加
2. ゲスト画面（`/guest/:roomCode`）で動画の検索・追加・操作が可能

### 3. 主な操作

- **動画検索・追加:** ゲスト画面の検索バーからYouTube動画を検索して追加。YouTube URLの直接貼り付けにも対応
- **再生/一時停止:** ゲスト画面のコントロールボタンから操作
- **次の動画へスキップ:** 再生リストの次の動画に進む
- **動画の選択・削除:** 再生リストから任意の動画を選択・削除

## 主要機能

### WebSocket リアルタイム同期

ホストとゲスト間の状態同期は WebSocket で行います。

| メッセージ | 方向 | 説明 |
|---|---|---|
| `JOIN` | Client → Server | ルーム参加 |
| `ADD_VIDEO` | Client → Server | 動画追加 |
| `PLAY` / `PAUSE` | 双方向 | 再生/一時停止 |
| `SYNC_TIME` | Host → Server → Guest | 再生位置同期（2秒間隔） |
| `NEXT_VIDEO` | Client → Server | 次の動画 |
| `SELECT_VIDEO` | Client → Server | 動画選択 |
| `REMOVE_VIDEO` | Client → Server | 動画削除 |
| `SYNC_STATE` | Server → Client | 全状態同期（接続時） |
| `PING` / `PONG` | 双方向 | ハートビート |

### ネットワーク耐障害性

車内での不安定なネットワーク環境を想定し、以下の対策を実装しています。

- **自動再接続:** WebSocket 切断時に指数バックオフ（1秒〜最大30秒）で自動再接続
- **ハートビート:** 30秒間隔の PING/PONG でゾンビコネクションを検知
- **サーバー権威モデル:** 再生リスト・再生状態はサーバーが正となり、再接続時に `SYNC_STATE` で完全同期
- **楽観的UI:** ゲスト操作は即座にUIに反映し、失敗時にロールバック
- **URL ベースのルーム復帰:** URL に `roomId` を含むため、リロードしても同じルームに復帰
- **LocalStorage:** ユーザーIDをブラウザに永続保存し、再接続時にセッションを復元

### データモデル

**Room**
| カラム | 型 | 説明 |
|---|---|---|
| id | UUID | 主キー |
| code | String | 6文字のルームコード（ユニーク） |
| currentVideoId | String? | 現在再生中の YouTube 動画ID |
| isPlaying | Boolean | 再生中かどうか |
| currentTime | Float | 再生位置（秒） |

**Video**
| カラム | 型 | 説明 |
|---|---|---|
| id | UUID | 主キー |
| youtubeId | String | YouTube 動画ID |
| title | String | 動画タイトル |
| thumbnail | String | サムネイルURL |
| addedBy | String | 追加したユーザーID |
| isPlayed | Boolean | 再生済みフラグ |
| order | Int | 再生リスト内の順番 |
| roomId | UUID | 所属ルーム（外部キー） |

## API エンドポイント

| メソッド | パス | 説明 |
|---|---|---|
| POST | `/api/rooms` | ルーム作成 |
| GET | `/api/rooms/:code` | ルーム情報取得 |
| GET | `/api/youtube/search?q=` | YouTube動画検索 |
| GET | `/api/youtube/video?id=` | YouTube動画詳細取得 |
| GET | `/ws` | WebSocket エンドポイント |

## 開発コマンド

### バックエンド

```bash
# 開発サーバー起動（ホットリロード）
npm run dev

# Prisma マイグレーション実行
npm run db:migrate

# Prisma クライアント生成
npm run db:generate

# スキーマをDBに反映
npm run db:push
```

### フロントエンド

```bash
# 開発サーバー起動
npm run dev

# プロダクションビルド
npm run build

# ビルドプレビュー
npm run preview
```

## ライセンス

MIT
