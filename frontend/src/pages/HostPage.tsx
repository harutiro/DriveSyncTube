import { useCallback, useEffect, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import { QRCodeSVG } from 'qrcode.react';
import { useSocket } from '../hooks/useSocket';
import { useUserIdentity } from '../hooks/useUserIdentity';
import type { Video, WSServerMessage } from '../types';
import { WS_URL } from '../lib/config';

// ============================================================
// YT IFrame API グローバル型宣言
// ============================================================
declare global {
  interface Window {
    YT: typeof YT;
    onYouTubeIframeAPIReady: () => void;
  }
}

/** SYNC_TIME 定期送信間隔 (ms) */
const SYNC_INTERVAL = 2_000;

// ============================================================
// HostPage コンポーネント
// ============================================================
export default function HostPage() {
  const { roomId } = useParams<{ roomId: string }>();
  const userId = useUserIdentity();

  // ----------------------------------------------------------
  // State
  // ----------------------------------------------------------
  /** YT API スクリプトの読み込みが完了したか */
  const [ytReady, setYtReady] = useState(false);
  /** ユーザーがタップして自動再生制限を解除したか */
  const [userActivated, setUserActivated] = useState(false);
  /** 再生リスト */
  const [playlist, setPlaylist] = useState<Video[]>([]);
  /** 現在再生中の YouTube 動画 ID */
  const [currentVideoId, setCurrentVideoId] = useState<string | null>(null);
  /** 再生中かどうか（UI 表示用） */
  const [isPlaying, setIsPlaying] = useState(false);

  // ----------------------------------------------------------
  // Refs
  // ----------------------------------------------------------
  const playerRef = useRef<YT.Player | null>(null);
  const syncIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  /** SYNC_STATE の初期シーク位置を保持（Player ready 後に使う） */
  const pendingSeekRef = useRef<number | null>(null);
  /** Player 未初期化時に受け取った動画IDを保持し、ready 後に再生する */
  const pendingVideoRef = useRef<string | null>(null);
  /** プレイヤー初期化済みフラグ（loadVideoById の切り替え判定に使用） */
  const playerInitializedRef = useRef(false);
  /** 外部（サーバー）からの操作中はイベントコールバックで再送信しない */
  const externalActionRef = useRef(false);
  /**
   * send 関数の最新参照を保持する ref。
   * useSocket の返り値 send はコールバック内から参照する必要があるが、
   * handleConnect / onStateChange / setInterval 等は useSocket より前に
   * 定義する必要があるため、ref を経由してアクセスする。
   */
  const sendRef = useRef<ReturnType<typeof useSocket>['send']>(() => {
    console.warn('[HostPage] send called before useSocket initialized');
  });

  // ----------------------------------------------------------
  // YouTube IFrame API ロード
  // ----------------------------------------------------------
  useEffect(() => {
    // 既にロード済みならスキップ
    if (window.YT && window.YT.Player) {
      setYtReady(true);
      return;
    }

    // グローバルコールバック登録
    const prevCallback = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => {
      setYtReady(true);
      prevCallback?.();
    };

    // スクリプトタグが既に追加されていなければ追加
    if (!document.querySelector('script[src*="youtube.com/iframe_api"]')) {
      const tag = document.createElement('script');
      tag.src = 'https://www.youtube.com/iframe_api';
      document.head.appendChild(tag);
    }
  }, []);

  // ----------------------------------------------------------
  // YT Player 初期化（userActivated && ytReady のとき）
  // ----------------------------------------------------------
  useEffect(() => {
    if (!ytReady || !userActivated) return;
    if (playerRef.current) return; // 既に初期化済み

    const player = new window.YT.Player('yt-player', {
      height: '100%',
      width: '100%',
      // currentVideoId が null の場合は videoId を渡さない
      // (undefined を渡すと YouTube API が "Invalid video id" エラーを出す)
      ...(currentVideoId ? { videoId: currentVideoId } : {}),
      playerVars: {
        autoplay: 1,
        controls: 1,
        rel: 0,
        modestbranding: 1,
        playsinline: 1,
      },
      events: {
        onReady: (event) => {
          console.log('[HostPage] YT Player ready');
          playerRef.current = event.target;
          playerInitializedRef.current = true;

          // Player 未初期化中に受け取った動画があれば読み込んで再生
          if (pendingVideoRef.current) {
            const seekTo = pendingSeekRef.current ?? 0;
            event.target.loadVideoById(pendingVideoRef.current, seekTo);
            pendingVideoRef.current = null;
            pendingSeekRef.current = null;
          } else if (pendingSeekRef.current !== null && pendingSeekRef.current > 0) {
            // SYNC_STATE で受け取っていた初期シーク位置を反映
            event.target.seekTo(pendingSeekRef.current, true);
            event.target.playVideo();
            pendingSeekRef.current = null;
          } else {
            event.target.playVideo();
          }
        },
        onStateChange: (event) => {
          // 外部（サーバー）コマンド実行中は無視
          if (externalActionRef.current) return;

          if (event.data === window.YT.PlayerState.ENDED) {
            // 動画終了 -> 次の動画へ
            console.log('[HostPage] Video ended - requesting next');
            sendRef.current({ type: 'NEXT_VIDEO', roomId: roomId! });
          }
        },
      },
    });

    playerRef.current = player;

    return () => {
      playerRef.current?.destroy();
      playerRef.current = null;
      playerInitializedRef.current = false;
    };
    // currentVideoId は初期化時のみ使用。再レンダーで再生成しない
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ytReady, userActivated, roomId]);

  // ----------------------------------------------------------
  // SYNC_TIME 定期送信
  // ----------------------------------------------------------
  useEffect(() => {
    if (!userActivated) return;

    syncIntervalRef.current = setInterval(() => {
      const player = playerRef.current;
      if (!player || typeof player.getCurrentTime !== 'function') return;

      try {
        const currentTime = player.getCurrentTime();
        const duration = player.getDuration();
        const state = player.getPlayerState();
        const playing = state === window.YT.PlayerState.PLAYING;

        sendRef.current({
          type: 'SYNC_TIME',
          roomId: roomId!,
          currentTime,
          isPlaying: playing,
          duration,
        });
      } catch (err) {
        console.error('[HostPage] SYNC_TIME send error:', err);
      }
    }, SYNC_INTERVAL);

    return () => {
      if (syncIntervalRef.current !== null) {
        clearInterval(syncIntervalRef.current);
        syncIntervalRef.current = null;
      }
    };
  }, [userActivated, roomId]);

  // ----------------------------------------------------------
  // WebSocket メッセージハンドラ
  // ----------------------------------------------------------
  const handleMessage = useCallback((msg: WSServerMessage) => {
    switch (msg.type) {
      // ---- 初期同期 ----
      case 'SYNC_STATE': {
        console.log('[HostPage] SYNC_STATE received:', msg);
        setPlaylist(msg.playlist);
        setCurrentVideoId(msg.currentVideoId);
        setIsPlaying(msg.isPlaying);

        const player = playerRef.current;
        if (player && playerInitializedRef.current) {
          externalActionRef.current = true;
          if (msg.currentVideoId) {
            player.loadVideoById(msg.currentVideoId, msg.currentTime);
            if (!msg.isPlaying) {
              // loadVideoById は自動再生するので一時停止が必要なら少し待って止める
              setTimeout(() => {
                player.pauseVideo();
                externalActionRef.current = false;
              }, 300);
            } else {
              setTimeout(() => {
                externalActionRef.current = false;
              }, 300);
            }
          } else {
            player.stopVideo();
            externalActionRef.current = false;
          }
        } else {
          // プレイヤー未初期化 -> 初期化時に再生
          pendingVideoRef.current = msg.currentVideoId;
          pendingSeekRef.current = msg.currentTime;
        }
        break;
      }

      // ---- 再生リスト更新 ----
      case 'PLAYLIST_UPDATE': {
        console.log('[HostPage] PLAYLIST_UPDATE received');
        setPlaylist(msg.playlist);
        break;
      }

      // ---- 再生 ----
      case 'PLAY': {
        console.log('[HostPage] PLAY received, videoId:', msg.videoId);
        setIsPlaying(true);
        const player = playerRef.current;
        if (player && playerInitializedRef.current) {
          externalActionRef.current = true;
          try {
            const state = player.getPlayerState();
            console.log('[HostPage] Player state before PLAY:', state);
            if (state === window.YT.PlayerState.PAUSED) {
              // 一時停止中 → 再開
              player.playVideo();
            } else if (msg.videoId) {
              // それ以外の状態（ENDED, UNSTARTED, CUED 等）→ 動画を読み込み直して再生
              player.loadVideoById(msg.videoId, msg.currentTime);
            } else {
              player.playVideo();
            }
          } catch (err) {
            console.error('[HostPage] PLAY handler error:', err);
          }
          setTimeout(() => {
            externalActionRef.current = false;
          }, 500);
        }
        break;
      }

      // ---- 一時停止 ----
      case 'PAUSE': {
        console.log('[HostPage] PAUSE received');
        setIsPlaying(false);
        if (playerRef.current && playerInitializedRef.current) {
          externalActionRef.current = true;
          playerRef.current.pauseVideo();
          setTimeout(() => {
            externalActionRef.current = false;
          }, 300);
        }
        break;
      }

      // ---- 動画切り替え ----
      case 'PLAY_VIDEO': {
        console.log('[HostPage] PLAY_VIDEO received:', msg.videoId);
        setCurrentVideoId(msg.videoId);
        setIsPlaying(true);
        const player = playerRef.current;
        if (player && playerInitializedRef.current) {
          externalActionRef.current = true;
          if (msg.videoId) {
            player.loadVideoById(msg.videoId, 0);
            // loadVideoById が自動再生しない場合に備え、少し待ってから playVideo
            setTimeout(() => {
              try {
                player.playVideo();
              } catch { /* ignore */ }
              externalActionRef.current = false;
            }, 500);
          } else {
            player.stopVideo();
            externalActionRef.current = false;
          }
        } else {
          // プレイヤー未初期化 → ready 後に再生するよう保持
          pendingVideoRef.current = msg.videoId;
          pendingSeekRef.current = 0;
        }
        break;
      }

      // ---- シーク ----
      case 'SEEK': {
        console.log('[HostPage] SEEK received:', msg.seekTime);
        const player = playerRef.current;
        if (player && playerInitializedRef.current) {
          externalActionRef.current = true;
          player.seekTo(msg.seekTime, true);
          setTimeout(() => {
            externalActionRef.current = false;
          }, 300);
        }
        break;
      }

      // ---- PONG: useSocket が内部処理済み - 無視 ----
      case 'PONG':
        break;

      // ---- エラー ----
      case 'ERROR':
        console.error('[HostPage] Server error:', msg.message);
        break;

      // ---- SYNC_TIME: ホスト自身には不要だが型安全のため ----
      case 'SYNC_TIME':
        break;

      default: {
        // 未知のメッセージ型
        const _exhaustive: never = msg;
        console.warn('[HostPage] Unknown message:', _exhaustive);
      }
    }
  }, []);

  // ----------------------------------------------------------
  // WebSocket 接続確立時コールバック
  // ----------------------------------------------------------
  const handleConnect = useCallback(() => {
    console.log('[HostPage] WebSocket connected - sending JOIN');
    sendRef.current({
      type: 'JOIN',
      roomId: roomId!,
      userId,
      role: 'host',
    });
  }, [roomId, userId]);

  // ----------------------------------------------------------
  // WebSocket 接続
  // ----------------------------------------------------------
  const { send, connectionState } = useSocket({
    url: `${WS_URL}/ws`,
    onMessage: handleMessage,
    onConnect: handleConnect,
  });

  // send の最新参照を ref に同期
  sendRef.current = send;

  // ----------------------------------------------------------
  // 次の動画へスキップ
  // ----------------------------------------------------------
  const handleSkip = useCallback(() => {
    sendRef.current({ type: 'NEXT_VIDEO', roomId: roomId! });
  }, [roomId]);

  const handleSelectVideo = useCallback(
    (youtubeId: string) => {
      if (youtubeId === currentVideoId) return;
      // 即座にプレイヤーで再生（サーバー応答を待たない）
      setCurrentVideoId(youtubeId);
      setIsPlaying(true);
      const player = playerRef.current;
      if (player && playerInitializedRef.current) {
        externalActionRef.current = true;
        player.loadVideoById(youtubeId, 0);
        setTimeout(() => {
          try { player.playVideo(); } catch { /* ignore */ }
          externalActionRef.current = false;
        }, 500);
      }
      // サーバーに通知（他クライアントとの同期用）
      sendRef.current({ type: 'SELECT_VIDEO', roomId: roomId!, youtubeId });
    },
    [roomId, currentVideoId],
  );

  // ----------------------------------------------------------
  // ゲスト招待 URL
  // ----------------------------------------------------------
  const guestUrl = `${window.location.origin}/guest/${roomId}`;

  // ----------------------------------------------------------
  // 接続状態インジケーター
  // ----------------------------------------------------------
  const connectionIndicator = (() => {
    switch (connectionState) {
      case 'connected':
        return { color: 'bg-green-500', label: '接続中' };
      case 'connecting':
        return { color: 'bg-yellow-500', label: '再接続中...' };
      case 'disconnected':
        return { color: 'bg-red-500', label: '切断' };
    }
  })();

  // ----------------------------------------------------------
  // 初回タップオーバーレイ（自動再生制限対策）
  // ----------------------------------------------------------
  if (!userActivated) {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center bg-slate-900 px-4">
        {/* 接続状態 */}
        <div className="absolute right-4 top-4 flex items-center gap-2">
          <span
            className={`inline-block h-3 w-3 rounded-full ${connectionIndicator.color}`}
          />
          <span className="text-sm text-slate-400">
            {connectionIndicator.label}
          </span>
        </div>

        <button
          onClick={() => setUserActivated(true)}
          className="flex flex-col items-center gap-6 rounded-2xl bg-slate-800 px-12 py-10 shadow-xl transition-transform active:scale-95"
        >
          {/* 再生アイコン */}
          <svg
            xmlns="http://www.w3.org/2000/svg"
            viewBox="0 0 24 24"
            fill="currentColor"
            className="h-24 w-24 text-indigo-400"
          >
            <path d="M8 5v14l11-7z" />
          </svg>
          <span className="text-2xl font-bold text-white">
            タップして再生を開始
          </span>
          <span className="text-sm text-slate-400">
            ルーム: {roomId}
          </span>
        </button>
      </div>
    );
  }

  // ----------------------------------------------------------
  // メインレイアウト
  // ----------------------------------------------------------
  return (
    <div className="flex min-h-screen flex-col bg-slate-900 lg:flex-row">
      {/* ===== メインエリア: YouTube Player ===== */}
      <div className="flex flex-1 flex-col">
        {/* ヘッダーバー */}
        <header className="flex items-center justify-between px-4 py-3">
          <h1 className="text-lg font-bold text-white">
            DriveSync Tube
            <span className="ml-2 text-sm font-normal text-slate-400">
              ルーム: {roomId}
            </span>
          </h1>
          <div className="flex items-center gap-2">
            <span
              className={`inline-block h-3 w-3 rounded-full ${connectionIndicator.color}`}
            />
            <span className="text-sm text-slate-400">
              {connectionIndicator.label}
            </span>
          </div>
        </header>

        {/* YouTube Player（16:9 アスペクト比） */}
        <div className="relative mx-auto w-full max-w-5xl px-4">
          <div
            className="relative w-full overflow-hidden rounded-lg bg-black"
            style={{ paddingBottom: '56.25%' }}
          >
            <div
              id="yt-player"
              className="absolute inset-0 h-full w-full"
            />
            {/* 動画未選択時の案内 */}
            {!currentVideoId && (
              <div className="absolute inset-0 flex items-center justify-center bg-slate-800/80">
                <p className="text-lg text-slate-400">
                  ゲストが動画を追加するのを待っています...
                </p>
              </div>
            )}
          </div>
        </div>

        {/* 再生コントロール */}
        <div className="flex items-center justify-center gap-4 px-4 py-4">
          <span className="text-sm text-slate-400">
            {isPlaying ? '再生中' : '一時停止'}
          </span>
          <button
            onClick={handleSkip}
            disabled={playlist.filter((v) => !v.isPlayed).length <= 1}
            className="rounded-lg bg-indigo-600 px-6 py-3 text-base font-semibold text-white transition-colors hover:bg-indigo-500 disabled:cursor-not-allowed disabled:opacity-40"
          >
            次の動画へ
          </button>
        </div>
      </div>

      {/* ===== サイドバー: QRコード + 再生リスト ===== */}
      <aside className="w-full border-t border-slate-700 bg-slate-800 lg:w-80 lg:border-l lg:border-t-0">
        {/* QRコード */}
        <div className="flex flex-col items-center gap-3 border-b border-slate-700 px-4 py-6">
          <h2 className="text-base font-semibold text-white">ゲスト招待</h2>
          <div className="rounded-lg bg-white p-3">
            <QRCodeSVG value={guestUrl} size={160} />
          </div>
          <p className="max-w-full break-all text-center text-xs text-slate-400">
            {guestUrl}
          </p>
        </div>

        {/* 再生リスト */}
        <div className="flex flex-col">
          <h2 className="px-4 py-3 text-base font-semibold text-white">
            再生リスト ({playlist.length})
          </h2>
          {playlist.length === 0 ? (
            <p className="px-4 pb-4 text-sm text-slate-500">
              動画がまだ追加されていません
            </p>
          ) : (
            <ul className="max-h-[50vh] overflow-y-auto lg:max-h-[calc(100vh-320px)]">
              {playlist.map((video) => (
                <li
                  key={video.id}
                  onClick={() => handleSelectVideo(video.youtubeId)}
                  className={`flex cursor-pointer items-center gap-3 px-4 py-3 transition-colors active:bg-slate-600 ${
                    video.youtubeId === currentVideoId
                      ? 'border-l-4 border-indigo-400 bg-indigo-900/40'
                      : video.isPlayed
                        ? 'opacity-50 hover:opacity-70'
                        : 'hover:bg-slate-700/50'
                  }`}
                >
                  {/* サムネイル */}
                  <img
                    src={video.thumbnail}
                    alt={video.title}
                    className="h-12 w-16 flex-shrink-0 rounded object-cover"
                    loading="lazy"
                  />
                  {/* タイトル */}
                  <div className="min-w-0 flex-1">
                    <p
                      className={`truncate text-sm font-medium ${
                        video.youtubeId === currentVideoId
                          ? 'text-indigo-300'
                          : 'text-slate-200'
                      }`}
                    >
                      {video.youtubeId === currentVideoId && (
                        <span className="mr-1 text-indigo-400">&#9654;</span>
                      )}
                      {video.title}
                    </p>
                    {video.isPlayed && video.youtubeId !== currentVideoId && (
                      <span className="text-xs text-slate-500">再生済み</span>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      </aside>
    </div>
  );
}
