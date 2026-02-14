# プロジェクト: 車内用リアルタイムYouTube共有プレイヤー (DriveSync Tube) 開発仕様書

あなたはシニアフルスタックエンジニアとして振る舞ってください。
以下の仕様に基づき、Dockerを用いた開発環境の構築から、Hono (Backend) と Vite + React (Frontend) を用いたアプリケーションの実装コードを作成してください。

## 1. プロジェクト概要
車内という閉じた空間で、複数のユーザー（乗員）が各自のスマートフォンから共通の再生リストを操作するWebアプリケーションです。
ホスト（車載モニター）が動画を再生し、ゲスト（同乗者）がリモコンとして動画を追加・操作します。
**最も重要な要件は、トンネルや山間部での「通信断絶」と「リロード」に対する堅牢性です。**

## 2. 技術スタック & 環境
* **Infrastructure:** Docker Compose (全サービスをコンテナ化)
* **Database:** PostgreSQL 15 (Alpine)
* **Backend:** Hono (Node.js runtime), Prisma ORM (またはDrizzle), WebSocket
* **Frontend:** Vite, React (TypeScript), Tailwind CSS, React Router DOM, YouTube IFrame Player API

## 3. Docker構成要件
`docker-compose.yml` をルートに配置し、以下の3つのサービスを定義してください。

1.  **db:** PostgreSQL
    * 環境変数でUser/Pass/DB名を設定可能にする。
    * ボリュームでデータを永続化。
2.  **backend:** Node.js (Hono)
    * ポート: 3000
    * DBコンテナへの接続待機 (depends_on)。
3.  **frontend:** Node.js (Vite)
    * ポート: 5173
    * ホストマシンのIPアドレスでスマホからアクセスするため、`--host` オプション必須。
    * 環境変数 `VITE_API_URL` でバックエンドの場所を指定。

## 4. 機能要件

### 4.1 ルーム管理 & ルーティング
* **Host (再生機):** `/host/:roomId`
    * QRコードを表示し、ゲストを招待する。
    * YouTube Playerを表示する。
* **Guest (リモコン):** `/guest/:roomId`
    * 検索フォームと再生リストを表示する。
* **共通:**
    * URLに `roomId` を含めることで、リロードしても同じ部屋に戻れるようにする。

### 4.2 状態管理と永続化 (重要)
リロードやブラウザの再起動に対応するため、以下の戦略を実装してください。

1.  **User Identity:**
    * ブラウザの `LocalStorage` に `userId` (UUID) を保存する。
    * WebSocket接続時に `userId` を送信し、サーバー側でセッションを復元する。
2.  **Server Authority:**
    * 「再生リスト」「現在の再生動画」「再生中の状態(Playing/Paused)」「シーク位置」はサーバー(DB/メモリ)が正解を持つ。
    * クライアント接続時(onOpen)に、即座に最新の `SYNC_STATE` を送信して同期させる。

### 4.3 不安定なネットワークへの対策 (必須)
車内利用のため、通信断絶は頻繁に起こる前提で実装してください。

1.  **WebSocket再接続ロジック:**
    * 切断時(onClose)に、指数バックオフ(Exponential Backoff)を用いて自動再接続を試みるカスタムフック `useSocket` を作成する。
    * ハートビート(Ping/Pong)を実装し、ゾンビコネクションを検知して再接続する。
2.  **Optimistic UI (楽観的UI):**
    * ゲストが「動画追加」等の操作をした際、サーバーのレスポンスを待たずにUIを更新する。失敗したらロールバックする。

## 5. データモデル (Prisma Schema イメージ)
* **Room:** id, code, currentVideoId, isPlaying, currentTime
* **Video:** id, youtubeId, title, addedBy, roomId, isPlayed

## 6. 実装ステップの指示
以下の順序でコードと設定ファイルを提示してください。

**Step 1: インフラ構築**
* ディレクトリ構成
* `docker-compose.yml`
* Frontend/Backend それぞれの `Dockerfile`

**Step 2: バックエンド実装 (Hono)**
* Prisma Schema
* WebSocketサーバーのセットアップ (HonoのWebSocketヘルパー使用)
* メッセージハンドリング (JOIN, ADD_VIDEO, PLAY/PAUSE, SYNC_TIME)
    * 特に `SYNC_TIME` はホストから定期送信させ、サーバーのメモリ状態を更新すること。

**Step 3: フロントエンド実装 (共通・Hooks)**
* `useSocket` フック (自動再接続・ハートビート付き)
* `useUserIdentity` フック (LocalStorage管理)

**Step 4: フロントエンド実装 (UI)**
* ルーティング設定 (`App.tsx`)
* **HostPage:** YouTube IFrame APIのラッパー。自動再生制限対策として「初回クリック」を促すUI。
* **GuestPage:** 動画検索(YouTube Data API または モック)とリスト追加UI。

## 注意点
* コード内でのプレースホルダー（APIキーなど）はわかりやすく記述してください。
* エラーハンドリングを省略せず、特にネットワーク周りのエラーはコンソールに出力するようにしてください。
