import { useState, useCallback, useRef } from 'react';
import { useParams } from 'react-router-dom';
import { useSocket } from '../hooks/useSocket';
import { useUserIdentity } from '../hooks/useUserIdentity';
import type { Video, WSMessage, WSServerMessage, YouTubeSearchResult, YouTubePlaylistInfo } from '../types';
import { API_URL, WS_URL } from '../lib/config';

// ============================================================
// GuestPage - 同乗者向けリモコンページ
// ============================================================
export default function GuestPage() {
  const { roomId } = useParams<{ roomId: string }>();
  const userId = useUserIdentity();

  // ----------------------------------------------------------
  // State
  // ----------------------------------------------------------
  const [playlist, setPlaylist] = useState<Video[]>([]);
  const [currentVideoId, setCurrentVideoId] = useState<string | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);

  // 検索関連
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<YouTubeSearchResult[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [showSearchResults, setShowSearchResults] = useState(true);

  // 楽観的UI用: 追加中の動画の youtubeId を追跡
  const [optimisticIds, setOptimisticIds] = useState<Set<string>>(new Set());

  // エラー表示
  const [wsError, setWsError] = useState<string | null>(null);

  // URL追加関連
  const [urlError, setUrlError] = useState<string | null>(null);
  const [isAddingByUrl, setIsAddingByUrl] = useState(false);

  // プレイリストインポート関連
  const [playlistPreview, setPlaylistPreview] = useState<YouTubePlaylistInfo | null>(null);
  const [isFetchingPlaylist, setIsFetchingPlaylist] = useState(false);
  const [isImporting, setIsImporting] = useState(false);
  const [playlistError, setPlaylistError] = useState<string | null>(null);

  // 検索フォーム ref
  const searchInputRef = useRef<HTMLInputElement>(null);

  // send 関数の ref（handleConnect から最新の send を参照するため）
  const sendRef = useRef<(message: WSMessage) => void>(() => {});

  // ----------------------------------------------------------
  // WebSocket メッセージハンドラ
  // ----------------------------------------------------------
  const handleMessage = useCallback((message: WSServerMessage) => {
    switch (message.type) {
      case 'SYNC_STATE':
        setPlaylist(message.playlist);
        setCurrentVideoId(message.currentVideoId);
        setIsPlaying(message.isPlaying);
        setCurrentTime(message.currentTime);
        setOptimisticIds(new Set()); // サーバーと同期完了
        setWsError(null);
        break;

      case 'PLAYLIST_UPDATE':
        setPlaylist(message.playlist);
        setOptimisticIds(new Set()); // 楽観的更新を確定
        break;

      case 'PLAY':
        setIsPlaying(true);
        break;

      case 'PAUSE':
        setIsPlaying(false);
        break;

      case 'PLAY_VIDEO':
        setCurrentVideoId(message.videoId);
        break;

      case 'SYNC_TIME':
        setCurrentTime(message.currentTime);
        setIsPlaying(message.isPlaying);
        break;

      case 'ERROR':
        setWsError(message.message);
        // 楽観的更新をロールバック（エラー時はサーバーが拒否した可能性）
        setOptimisticIds(new Set());
        console.error('[GuestPage] Server error:', message.message);
        break;

      case 'PONG':
        // 無視
        break;
    }
  }, []);

  // ----------------------------------------------------------
  // WebSocket 接続
  // ----------------------------------------------------------
  // handleConnect は sendRef 経由で send を呼び出す。
  // useSocket は onConnect を ref で保持するため、WebSocket open 時点で
  // sendRef.current は最新の send 関数を指している。
  const handleConnect = useCallback(() => {
    if (!roomId) return;
    sendRef.current({
      type: 'JOIN',
      roomId,
      userId,
      role: 'guest',
    });
  }, [roomId, userId]);

  const { send, connectionState, reconnectCount } = useSocket({
    url: `${WS_URL}/ws`,
    onMessage: handleMessage,
    onConnect: handleConnect,
    enabled: !!roomId,
  });

  // send を ref に同期
  sendRef.current = send;

  // ----------------------------------------------------------
  // YouTube URL からの動画ID抽出
  // ----------------------------------------------------------
  /**
   * YouTube の各種URLフォーマットから動画IDを抽出する。
   * 対応形式:
   *   - https://www.youtube.com/watch?v=VIDEO_ID
   *   - https://youtu.be/VIDEO_ID
   *   - https://www.youtube.com/embed/VIDEO_ID
   *   - https://www.youtube.com/shorts/VIDEO_ID
   *   - https://m.youtube.com/watch?v=VIDEO_ID
   * 該当しなければ null を返す。
   */
  const extractYouTubeVideoId = useCallback((input: string): string | null => {
    const trimmed = input.trim();

    // youtu.be 短縮URL (例: https://youtu.be/VIDEO_ID?si=xxx)
    const shortMatch = trimmed.match(
      /(?:https?:\/\/)?youtu\.be\/([a-zA-Z0-9_-]{11})(?:[?&/]|$)/,
    );
    if (shortMatch) return shortMatch[1];

    // youtube.com 各種パス (例: watch?v=, embed/, shorts/, ?si= 付き等)
    const longMatch = trimmed.match(
      /(?:https?:\/\/)?(?:www\.|m\.)?youtube\.com\/(?:watch\?.*v=|embed\/|shorts\/)([a-zA-Z0-9_-]{11})(?:[?&/]|$)/,
    );
    if (longMatch) return longMatch[1];

    return null;
  }, []);

  // ----------------------------------------------------------
  // YouTube プレイリストURL からプレイリストIDを抽出
  // ----------------------------------------------------------
  const extractYouTubePlaylistId = useCallback((input: string): string | null => {
    const trimmed = input.trim();
    try {
      // URLっぽい文字列ならURLSearchParamsで安全にパース
      if (trimmed.includes('youtube.com') || trimmed.includes('youtu.be')) {
        const url = new URL(
          trimmed.startsWith('http') ? trimmed : `https://${trimmed}`,
        );
        const listId = url.searchParams.get('list');
        if (listId && listId.startsWith('PL')) return listId;
      }
    } catch {
      // URL パース失敗 → プレイリストではない
    }
    return null;
  }, []);

  // ----------------------------------------------------------
  // YouTube 検索
  // ----------------------------------------------------------
  const handleSearch = useCallback(async () => {
    const query = searchQuery.trim();
    if (!query) return;

    setIsSearching(true);
    setSearchError(null);
    setShowSearchResults(true);

    try {
      const res = await fetch(
        `${API_URL}/api/youtube/search?q=${encodeURIComponent(query)}`,
      );
      if (!res.ok) {
        throw new Error(`検索に失敗しました (${res.status})`);
      }
      const data = (await res.json()) as { results: YouTubeSearchResult[] };
      setSearchResults(data.results);
    } catch (err) {
      const message =
        err instanceof Error ? err.message : '検索中にエラーが発生しました';
      setSearchError(message);
      console.error('[GuestPage] Search error:', err);
    } finally {
      setIsSearching(false);
    }
  }, [searchQuery]);

  // ----------------------------------------------------------
  // ヘルパー: 動画がプレイリストに存在するか
  // ----------------------------------------------------------
  const isVideoInPlaylist = useCallback(
    (youtubeId: string) => {
      return (
        playlist.some((v) => v.youtubeId === youtubeId) ||
        optimisticIds.has(youtubeId)
      );
    },
    [playlist, optimisticIds],
  );

  // ----------------------------------------------------------
  // 動画追加 (Optimistic UI)
  // ----------------------------------------------------------
  const handleAddVideo = useCallback(
    (result: YouTubeSearchResult) => {
      if (!roomId) return;

      // 既にプレイリストに存在するか、楽観的追加済みならスキップ
      if (
        playlist.some((v) => v.youtubeId === result.youtubeId) ||
        optimisticIds.has(result.youtubeId)
      ) {
        return;
      }

      // 楽観的にUIを更新
      setOptimisticIds((prev) => new Set(prev).add(result.youtubeId));
      setPlaylist((prev) => [
        ...prev,
        {
          id: `optimistic-${result.youtubeId}`,
          youtubeId: result.youtubeId,
          title: result.title,
          thumbnail: result.thumbnail,
          addedBy: userId,
          isPlayed: false,
          order: prev.length,
        },
      ]);

      // WebSocket で送信
      send({
        type: 'ADD_VIDEO',
        roomId,
        video: {
          youtubeId: result.youtubeId,
          title: result.title,
          thumbnail: result.thumbnail,
        },
        userId,
      });
    },
    [roomId, userId, playlist, optimisticIds, send],
  );

  // ----------------------------------------------------------
  // URL から動画を追加
  // ----------------------------------------------------------
  const handleAddByUrl = useCallback(
    async (videoId: string) => {
      if (!roomId) return;
      if (isVideoInPlaylist(videoId)) {
        setUrlError('この動画は既にプレイリストに追加されています');
        return;
      }

      setIsAddingByUrl(true);
      setUrlError(null);

      try {
        const res = await fetch(
          `${API_URL}/api/youtube/video?id=${encodeURIComponent(videoId)}`,
        );
        if (!res.ok) {
          if (res.status === 404) {
            throw new Error('動画が見つかりませんでした');
          }
          throw new Error(`動画情報の取得に失敗しました (${res.status})`);
        }
        const data = (await res.json()) as { result: YouTubeSearchResult };
        const result = data.result;

        handleAddVideo(result);
        setSearchQuery('');
      } catch (err) {
        const message =
          err instanceof Error ? err.message : '動画の追加に失敗しました';
        setUrlError(message);
        console.error('[GuestPage] URL add error:', err);
      } finally {
        setIsAddingByUrl(false);
      }
    },
    [roomId, isVideoInPlaylist, handleAddVideo],
  );

  // ----------------------------------------------------------
  // プレイリスト情報を取得してプレビュー表示
  // ----------------------------------------------------------
  const handleFetchPlaylist = useCallback(
    async (playlistId: string) => {
      setIsFetchingPlaylist(true);
      setPlaylistError(null);
      setPlaylistPreview(null);

      try {
        const res = await fetch(
          `${API_URL}/api/youtube/playlist?id=${encodeURIComponent(playlistId)}`,
        );
        if (!res.ok) {
          throw new Error(`プレイリストの取得に失敗しました (${res.status})`);
        }
        const data = (await res.json()) as YouTubePlaylistInfo;
        if (!data.videos || data.videos.length === 0) {
          throw new Error('プレイリストに動画がありません');
        }
        setPlaylistPreview(data);
        setSearchQuery('');
      } catch (err) {
        const message =
          err instanceof Error ? err.message : 'プレイリストの取得に失敗しました';
        setPlaylistError(message);
        console.error('[GuestPage] Playlist fetch error:', err);
      } finally {
        setIsFetchingPlaylist(false);
      }
    },
    [],
  );

  // ----------------------------------------------------------
  // プレイリスト一括追加
  // ----------------------------------------------------------
  const handleImportPlaylist = useCallback(() => {
    if (!roomId || !playlistPreview) return;

    // 追加済みを除外
    const newVideos = playlistPreview.videos.filter(
      (v) => !playlist.some((pv) => pv.youtubeId === v.youtubeId),
    );
    if (newVideos.length === 0) {
      setPlaylistPreview(null);
      return;
    }

    setIsImporting(true);

    // 楽観的UI: ローカルプレイリストに即座に反映
    const optimisticVideos = newVideos.map((v, i) => ({
      id: `optimistic-pl-${v.youtubeId}`,
      youtubeId: v.youtubeId,
      title: v.title,
      thumbnail: v.thumbnail,
      addedBy: userId,
      isPlayed: false,
      order: playlist.length + i,
    }));
    setPlaylist((prev) => [...prev, ...optimisticVideos]);
    setOptimisticIds((prev) => {
      const next = new Set(prev);
      for (const v of newVideos) next.add(v.youtubeId);
      return next;
    });

    // WebSocket で一括送信
    send({
      type: 'ADD_VIDEOS',
      roomId,
      videos: newVideos.map((v) => ({
        youtubeId: v.youtubeId,
        title: v.title,
        thumbnail: v.thumbnail,
      })),
      userId,
    });

    setPlaylistPreview(null);
    setIsImporting(false);
  }, [roomId, playlistPreview, playlist, userId, send]);

  // ----------------------------------------------------------
  // フォーム送信（URL検出時は追加、それ以外は検索）
  // ----------------------------------------------------------
  const handleSearchSubmit = useCallback(
    (e: React.FormEvent) => {
      e.preventDefault();
      // プレイリストURLを動画URLより先にチェック
      const playlistId = extractYouTubePlaylistId(searchQuery);
      if (playlistId) {
        handleFetchPlaylist(playlistId);
        return;
      }
      const videoId = extractYouTubeVideoId(searchQuery);
      if (videoId) {
        handleAddByUrl(videoId);
      } else {
        handleSearch();
      }
    },
    [searchQuery, extractYouTubePlaylistId, extractYouTubeVideoId, handleFetchPlaylist, handleAddByUrl, handleSearch],
  );

  // ----------------------------------------------------------
  // 動画削除
  // ----------------------------------------------------------
  const handleRemoveVideo = useCallback(
    (videoId: string) => {
      if (!roomId) return;
      send({ type: 'REMOVE_VIDEO', roomId, videoId });
    },
    [roomId, send],
  );

  // ----------------------------------------------------------
  // 再生コントロール
  // ----------------------------------------------------------
  const handlePlayPause = useCallback(() => {
    if (!roomId) return;
    if (isPlaying) {
      setIsPlaying(false); // 楽観的UI更新
      send({ type: 'PAUSE', roomId });
    } else {
      setIsPlaying(true); // 楽観的UI更新
      send({ type: 'PLAY', roomId });
    }
  }, [roomId, isPlaying, send]);

  const handleNextVideo = useCallback(() => {
    if (!roomId) return;
    send({ type: 'NEXT_VIDEO', roomId });
  }, [roomId, send]);

  const handleSelectVideo = useCallback(
    (youtubeId: string) => {
      if (!roomId) return;
      // 既に再生中の動画を選択した場合は何もしない
      if (youtubeId === currentVideoId) return;
      setCurrentVideoId(youtubeId);
      setIsPlaying(true);
      send({ type: 'SELECT_VIDEO', roomId, youtubeId });
    },
    [roomId, currentVideoId, send],
  );

  // ----------------------------------------------------------
  // ヘルパー: 現在再生中の動画を取得
  // ----------------------------------------------------------
  const currentVideo = playlist.find((v) => v.youtubeId === currentVideoId);

  // ----------------------------------------------------------
  // ヘルパー: 再生時間フォーマット
  // ----------------------------------------------------------
  const formatTime = (seconds: number) => {
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    return `${m}:${s.toString().padStart(2, '0')}`;
  };

  // ----------------------------------------------------------
  // 接続状態インジケーター
  // ----------------------------------------------------------
  const connectionIndicator = (() => {
    switch (connectionState) {
      case 'connected':
        return (
          <span className="flex items-center gap-1.5 text-xs text-emerald-400">
            <span className="inline-block h-2 w-2 rounded-full bg-emerald-400" />
            接続中
          </span>
        );
      case 'connecting':
        return (
          <span className="flex items-center gap-1.5 text-xs text-amber-400">
            <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-amber-400" />
            {reconnectCount > 0
              ? `再接続中... (${reconnectCount}回目)`
              : '接続中...'}
          </span>
        );
      case 'disconnected':
        return (
          <span className="flex items-center gap-1.5 text-xs text-red-400">
            <span className="inline-block h-2 w-2 rounded-full bg-red-400" />
            {reconnectCount > 0
              ? `再接続中... (${reconnectCount}回目)`
              : '切断'}
          </span>
        );
    }
  })();

  // ----------------------------------------------------------
  // roomId が無い場合
  // ----------------------------------------------------------
  if (!roomId) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-slate-900 px-4">
        <p className="text-red-400">ルームIDが指定されていません。</p>
      </div>
    );
  }

  // ----------------------------------------------------------
  // レンダリング
  // ----------------------------------------------------------
  return (
    <div className="min-h-screen bg-slate-900 pb-8">
      <div className="mx-auto max-w-lg px-4">
        {/* ========== ヘッダー ========== */}
        <header className="sticky top-0 z-10 bg-slate-900/95 pb-3 pt-4 backdrop-blur-sm">
          <div className="flex items-center justify-between">
            <div>
              <h1 className="text-lg font-bold text-white">DriveSync Tube</h1>
              <p className="text-xs text-slate-400">
                ルーム:{' '}
                <span className="font-mono text-emerald-400">{roomId}</span>
              </p>
            </div>
            {connectionIndicator}
          </div>

          {/* WebSocket エラー表示 */}
          {wsError && (
            <div className="mt-2 rounded-lg bg-red-900/50 px-3 py-2 text-sm text-red-300">
              {wsError}
            </div>
          )}
        </header>

        {/* ========== 現在再生中 & コントロール ========== */}
        <section className="mt-2 rounded-xl bg-slate-800 p-4">
          {currentVideo ? (
            <div className="flex items-center gap-3">
              <img
                src={currentVideo.thumbnail}
                alt={currentVideo.title}
                className="h-12 w-16 flex-shrink-0 rounded object-cover"
              />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium text-white">
                  {currentVideo.title}
                </p>
                <p className="text-xs text-slate-400">
                  {formatTime(currentTime)}
                </p>
              </div>
            </div>
          ) : (
            <p className="text-center text-sm text-slate-500">
              再生中の動画はありません
            </p>
          )}

          {/* 再生コントロールボタン */}
          <div className="mt-3 flex items-center justify-center gap-4">
            <button
              type="button"
              onClick={handlePlayPause}
              disabled={connectionState !== 'connected'}
              className="flex h-14 w-14 items-center justify-center rounded-full bg-emerald-600 text-white transition-colors hover:bg-emerald-500 active:bg-emerald-700 disabled:bg-slate-700 disabled:text-slate-500"
              aria-label={isPlaying ? '一時停止' : '再生'}
            >
              {isPlaying ? (
                // Pause icon
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  viewBox="0 0 24 24"
                  fill="currentColor"
                  className="h-7 w-7"
                >
                  <path
                    fillRule="evenodd"
                    d="M6.75 5.25a.75.75 0 0 1 .75-.75H9a.75.75 0 0 1 .75.75v13.5a.75.75 0 0 1-.75.75H7.5a.75.75 0 0 1-.75-.75V5.25Zm7.5 0A.75.75 0 0 1 15 4.5h1.5a.75.75 0 0 1 .75.75v13.5a.75.75 0 0 1-.75.75H15a.75.75 0 0 1-.75-.75V5.25Z"
                    clipRule="evenodd"
                  />
                </svg>
              ) : (
                // Play icon
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  viewBox="0 0 24 24"
                  fill="currentColor"
                  className="h-7 w-7"
                >
                  <path
                    fillRule="evenodd"
                    d="M4.5 5.653c0-1.427 1.529-2.33 2.779-1.643l11.54 6.347c1.295.712 1.295 2.573 0 3.286L7.28 19.99c-1.25.687-2.779-.217-2.779-1.643V5.653Z"
                    clipRule="evenodd"
                  />
                </svg>
              )}
            </button>

            <button
              type="button"
              onClick={handleNextVideo}
              disabled={connectionState !== 'connected'}
              className="flex h-12 w-12 items-center justify-center rounded-full bg-slate-700 text-white transition-colors hover:bg-slate-600 active:bg-slate-800 disabled:text-slate-500"
              aria-label="次の曲"
            >
              {/* Next icon */}
              <svg
                xmlns="http://www.w3.org/2000/svg"
                viewBox="0 0 24 24"
                fill="currentColor"
                className="h-6 w-6"
              >
                <path d="M5.055 7.06C3.805 6.347 2.25 7.25 2.25 8.69v6.622c0 1.44 1.555 2.342 2.805 1.628L12 13.471v3.839c0 1.44 1.555 2.342 2.805 1.628l7.108-4.061c1.26-.72 1.26-2.536 0-3.256l-7.108-4.061C13.555 6.346 12 7.249 12 8.689v3.839L5.055 7.061Z" />
              </svg>
            </button>
          </div>
        </section>

        {/* ========== 検索フォーム ========== */}
        <section className="mt-4">
          <form onSubmit={handleSearchSubmit} className="flex gap-2">
            <input
              ref={searchInputRef}
              type="text"
              value={searchQuery}
              onChange={(e) => {
                setSearchQuery(e.target.value);
                setUrlError(null);
              }}
              placeholder="検索 / 動画URL / プレイリストURL"
              className="flex-1 rounded-lg bg-slate-800 px-4 py-3 text-sm text-white placeholder-slate-500 outline-none ring-1 ring-slate-700 transition-colors focus:ring-emerald-500"
            />
            <button
              type="submit"
              disabled={isSearching || isAddingByUrl || isFetchingPlaylist || !searchQuery.trim()}
              className="flex-shrink-0 rounded-lg bg-emerald-600 px-4 py-3 text-sm font-medium text-white transition-colors hover:bg-emerald-500 active:bg-emerald-700 disabled:bg-slate-700 disabled:text-slate-500"
            >
              {isSearching || isAddingByUrl || isFetchingPlaylist ? (
                <svg
                  className="h-5 w-5 animate-spin"
                  xmlns="http://www.w3.org/2000/svg"
                  fill="none"
                  viewBox="0 0 24 24"
                >
                  <circle
                    className="opacity-25"
                    cx="12"
                    cy="12"
                    r="10"
                    stroke="currentColor"
                    strokeWidth="4"
                  />
                  <path
                    className="opacity-75"
                    fill="currentColor"
                    d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
                  />
                </svg>
              ) : extractYouTubePlaylistId(searchQuery) ? (
                'インポート'
              ) : extractYouTubeVideoId(searchQuery) ? (
                '追加'
              ) : (
                '検索'
              )}
            </button>
          </form>

          {/* URL検出ヒント */}
          {searchQuery.trim() && extractYouTubePlaylistId(searchQuery) && (
            <p className="mt-1.5 text-xs text-emerald-400">
              プレイリストURLを検出しました - 「インポート」で一括追加します
            </p>
          )}
          {searchQuery.trim() && !extractYouTubePlaylistId(searchQuery) && extractYouTubeVideoId(searchQuery) && (
            <p className="mt-1.5 text-xs text-emerald-400">
              YouTube URLを検出しました - 「追加」で直接プレイリストに追加します
            </p>
          )}

          {/* 検索エラー */}
          {searchError && (
            <div className="mt-2 rounded-lg bg-red-900/50 px-3 py-2 text-sm text-red-300">
              {searchError}
            </div>
          )}

          {/* URL追加エラー */}
          {urlError && (
            <div className="mt-2 rounded-lg bg-red-900/50 px-3 py-2 text-sm text-red-300">
              {urlError}
            </div>
          )}

          {/* プレイリストエラー */}
          {playlistError && (
            <div className="mt-2 rounded-lg bg-red-900/50 px-3 py-2 text-sm text-red-300">
              {playlistError}
            </div>
          )}
        </section>

        {/* ========== プレイリスト インポート プレビュー ========== */}
        {playlistPreview && (
          <section className="mt-4 rounded-xl bg-slate-800 p-4">
            <div className="mb-3 flex items-center justify-between">
              <div className="min-w-0 flex-1">
                <h3 className="truncate text-sm font-semibold text-white">
                  {playlistPreview.title}
                </h3>
                <p className="text-xs text-slate-400">
                  {playlistPreview.videos.length}曲
                  {(() => {
                    const newCount = playlistPreview.videos.filter(
                      (v) => !playlist.some((pv) => pv.youtubeId === v.youtubeId),
                    ).length;
                    const dupCount = playlistPreview.videos.length - newCount;
                    return dupCount > 0 ? ` (${dupCount}曲は追加済み)` : '';
                  })()}
                </p>
              </div>
            </div>

            {/* 動画リスト（スクロール可能） */}
            <ul className="max-h-64 space-y-1.5 overflow-y-auto">
              {playlistPreview.videos.map((v, i) => {
                const alreadyAdded = playlist.some(
                  (pv) => pv.youtubeId === v.youtubeId,
                );
                return (
                  <li
                    key={v.youtubeId}
                    className={`flex items-center gap-2 rounded-lg p-2 ${
                      alreadyAdded ? 'opacity-40' : ''
                    }`}
                  >
                    <span className="w-6 flex-shrink-0 text-center text-xs text-slate-500">
                      {i + 1}
                    </span>
                    <img
                      src={v.thumbnail}
                      alt={v.title}
                      className="h-8 w-12 flex-shrink-0 rounded object-cover"
                    />
                    <p className="min-w-0 flex-1 truncate text-xs text-white">
                      {v.title}
                    </p>
                    {alreadyAdded && (
                      <span className="flex-shrink-0 text-xs text-slate-500">
                        追加済み
                      </span>
                    )}
                  </li>
                );
              })}
            </ul>

            {/* アクションボタン */}
            <div className="mt-3 flex gap-2">
              <button
                type="button"
                onClick={() => setPlaylistPreview(null)}
                className="flex-1 rounded-lg bg-slate-700 px-4 py-2.5 text-sm font-medium text-slate-300 transition-colors hover:bg-slate-600"
              >
                キャンセル
              </button>
              <button
                type="button"
                onClick={handleImportPlaylist}
                disabled={
                  isImporting ||
                  connectionState !== 'connected' ||
                  playlistPreview.videos.filter(
                    (v) => !playlist.some((pv) => pv.youtubeId === v.youtubeId),
                  ).length === 0
                }
                className="flex-1 rounded-lg bg-emerald-600 px-4 py-2.5 text-sm font-medium text-white transition-colors hover:bg-emerald-500 active:bg-emerald-700 disabled:bg-slate-700 disabled:text-slate-500"
              >
                {(() => {
                  const newCount = playlistPreview.videos.filter(
                    (v) => !playlist.some((pv) => pv.youtubeId === v.youtubeId),
                  ).length;
                  return newCount > 0
                    ? `${newCount}曲を追加`
                    : 'すべて追加済み';
                })()}
              </button>
            </div>
          </section>
        )}

        {/* ========== 検索結果 ========== */}
        {searchResults.length > 0 && (
          <section className="mt-4">
            <button
              type="button"
              onClick={() => setShowSearchResults((prev) => !prev)}
              className="flex w-full items-center justify-between rounded-lg bg-slate-800 px-4 py-2 text-sm text-slate-300 transition-colors hover:bg-slate-750"
            >
              <span>
                検索結果 ({searchResults.length}件)
              </span>
              <svg
                xmlns="http://www.w3.org/2000/svg"
                viewBox="0 0 20 20"
                fill="currentColor"
                className={`h-5 w-5 transition-transform ${showSearchResults ? 'rotate-180' : ''}`}
              >
                <path
                  fillRule="evenodd"
                  d="M5.22 8.22a.75.75 0 0 1 1.06 0L10 11.94l3.72-3.72a.75.75 0 1 1 1.06 1.06l-4.25 4.25a.75.75 0 0 1-1.06 0L5.22 9.28a.75.75 0 0 1 0-1.06Z"
                  clipRule="evenodd"
                />
              </svg>
            </button>

            {showSearchResults && (
              <ul className="mt-2 space-y-2">
                {searchResults.map((result) => {
                  const alreadyAdded = isVideoInPlaylist(result.youtubeId);
                  return (
                    <li
                      key={result.youtubeId}
                      className="flex items-center gap-3 rounded-lg bg-slate-800 p-3"
                    >
                      <img
                        src={result.thumbnail}
                        alt={result.title}
                        className="h-12 w-16 flex-shrink-0 rounded object-cover"
                      />
                      <div className="min-w-0 flex-1">
                        <p className="line-clamp-2 text-sm text-white">
                          {result.title}
                        </p>
                      </div>
                      <button
                        type="button"
                        onClick={() => handleAddVideo(result)}
                        disabled={alreadyAdded || connectionState !== 'connected'}
                        className={`flex-shrink-0 rounded-lg px-3 py-2 text-xs font-medium transition-colors ${
                          alreadyAdded
                            ? 'bg-slate-700 text-slate-500'
                            : 'bg-emerald-600 text-white hover:bg-emerald-500 active:bg-emerald-700 disabled:bg-slate-700 disabled:text-slate-500'
                        }`}
                      >
                        {alreadyAdded ? '追加済み' : '追加'}
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>
        )}

        {/* 検索実行済みで結果が空 */}
        {!isSearching &&
          searchResults.length === 0 &&
          searchQuery.trim() !== '' &&
          searchError === null && (
            <p className="mt-4 text-center text-sm text-slate-500">
              検索結果が見つかりませんでした
            </p>
          )}

        {/* ========== 再生リスト ========== */}
        <section className="mt-6">
          <h2 className="mb-3 text-sm font-semibold uppercase tracking-wider text-slate-400">
            再生リスト ({playlist.length}曲)
          </h2>

          {playlist.length === 0 ? (
            <div className="rounded-xl bg-slate-800 p-6 text-center">
              <p className="text-sm text-slate-500">
                プレイリストは空です。上の検索から動画を追加してください。
              </p>
            </div>
          ) : (
            <ul className="space-y-2">
              {playlist.map((video, index) => {
                const isCurrent = video.youtubeId === currentVideoId;
                const isOptimistic = video.id.startsWith('optimistic-');

                return (
                  <li
                    key={video.id}
                    onClick={() => {
                      if (!isOptimistic && connectionState === 'connected') {
                        handleSelectVideo(video.youtubeId);
                      }
                    }}
                    className={`flex cursor-pointer items-center gap-3 rounded-lg p-3 transition-colors active:bg-slate-700 ${
                      isCurrent
                        ? 'bg-emerald-900/40 ring-1 ring-emerald-500/50'
                        : 'bg-slate-800 hover:bg-slate-750'
                    } ${video.isPlayed && !isCurrent ? 'opacity-40' : ''} ${
                      isOptimistic ? 'animate-pulse cursor-default' : ''
                    }`}
                  >
                    {/* 番号 */}
                    <span
                      className={`flex h-6 w-6 flex-shrink-0 items-center justify-center rounded text-xs font-medium ${
                        isCurrent
                          ? 'bg-emerald-600 text-white'
                          : 'bg-slate-700 text-slate-400'
                      }`}
                    >
                      {isCurrent ? (
                        // 再生中アニメーション
                        <svg
                          xmlns="http://www.w3.org/2000/svg"
                          viewBox="0 0 24 24"
                          fill="currentColor"
                          className="h-3.5 w-3.5"
                        >
                          <path
                            fillRule="evenodd"
                            d="M4.5 5.653c0-1.427 1.529-2.33 2.779-1.643l11.54 6.347c1.295.712 1.295 2.573 0 3.286L7.28 19.99c-1.25.687-2.779-.217-2.779-1.643V5.653Z"
                            clipRule="evenodd"
                          />
                        </svg>
                      ) : (
                        index + 1
                      )}
                    </span>

                    {/* サムネイル */}
                    <img
                      src={video.thumbnail}
                      alt={video.title}
                      className="h-10 w-14 flex-shrink-0 rounded object-cover"
                    />

                    {/* タイトル */}
                    <div className="min-w-0 flex-1">
                      <p
                        className={`line-clamp-2 text-sm ${
                          isCurrent ? 'font-medium text-emerald-300' : 'text-white'
                        }`}
                      >
                        {video.title}
                      </p>
                      {isOptimistic && (
                        <p className="text-xs text-amber-400">追加中...</p>
                      )}
                    </div>

                    {/* 削除ボタン */}
                    {!isOptimistic && (
                      <button
                        type="button"
                        onClick={() => handleRemoveVideo(video.id)}
                        disabled={connectionState !== 'connected'}
                        className="flex-shrink-0 rounded-lg p-2 text-slate-500 transition-colors hover:bg-red-900/50 hover:text-red-400 active:bg-red-900 disabled:hover:bg-transparent disabled:hover:text-slate-500"
                        aria-label={`${video.title} を削除`}
                      >
                        <svg
                          xmlns="http://www.w3.org/2000/svg"
                          viewBox="0 0 20 20"
                          fill="currentColor"
                          className="h-5 w-5"
                        >
                          <path
                            fillRule="evenodd"
                            d="M8.75 1A2.75 2.75 0 0 0 6 3.75v.443c-.795.077-1.584.176-2.365.298a.75.75 0 1 0 .23 1.482l.149-.022.841 10.518A2.75 2.75 0 0 0 7.596 19h4.807a2.75 2.75 0 0 0 2.742-2.53l.841-10.52.149.023a.75.75 0 0 0 .23-1.482A41.03 41.03 0 0 0 14 4.193V3.75A2.75 2.75 0 0 0 11.25 1h-2.5ZM10 4c.84 0 1.673.025 2.5.075V3.75c0-.69-.56-1.25-1.25-1.25h-2.5c-.69 0-1.25.56-1.25 1.25v.325C8.327 4.025 9.16 4 10 4ZM8.58 7.72a.75.75 0 0 1 .7.8l-.5 5.5a.75.75 0 0 1-1.495-.137l.5-5.5a.75.75 0 0 1 .795-.662Zm2.84 0a.75.75 0 0 1 .794.663l.5 5.5a.75.75 0 0 1-1.495.136l-.5-5.5a.75.75 0 0 1 .7-.8Z"
                            clipRule="evenodd"
                          />
                        </svg>
                      </button>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      </div>
    </div>
  );
}
