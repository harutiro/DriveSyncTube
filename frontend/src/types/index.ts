// ============================================================
// DriveSync Tube - 共通型定義
// ============================================================

/** 再生リスト内の動画 */
export interface Video {
  id: string;
  youtubeId: string;
  title: string;
  thumbnail: string;
  addedBy: string;
  isPlayed: boolean;
  order: number;
}

/** ルームの再生状態（サーバーが正とする状態） */
export interface RoomState {
  currentVideoId: string | null;
  isPlaying: boolean;
  currentTime: number;
  playlist: Video[];
}

// ------------------------------------------------------------
// WebSocket メッセージ型 (Client → Server)
// ------------------------------------------------------------
export type WSMessage =
  | { type: 'JOIN'; roomId: string; userId: string; role: 'host' | 'guest' }
  | {
      type: 'ADD_VIDEO';
      roomId: string;
      video: { youtubeId: string; title: string; thumbnail: string };
      userId: string;
    }
  | { type: 'PLAY'; roomId: string }
  | { type: 'PAUSE'; roomId: string }
  | {
      type: 'SYNC_TIME';
      roomId: string;
      currentTime: number;
      isPlaying: boolean;
    }
  | { type: 'NEXT_VIDEO'; roomId: string }
  | { type: 'REMOVE_VIDEO'; roomId: string; videoId: string }
  | { type: 'SELECT_VIDEO'; roomId: string; youtubeId: string }
  | {
      type: 'ADD_VIDEOS';
      roomId: string;
      videos: Array<{ youtubeId: string; title: string; thumbnail: string }>;
      userId: string;
    }
  | { type: 'PING' };

// ------------------------------------------------------------
// WebSocket メッセージ型 (Server → Client)
// ------------------------------------------------------------
export type WSServerMessage =
  | { type: 'SYNC_STATE'; currentVideoId: string | null; isPlaying: boolean; currentTime: number; playlist: Video[] }
  | { type: 'PLAYLIST_UPDATE'; playlist: Video[] }
  | { type: 'PLAY'; videoId: string | null; currentTime: number }
  | { type: 'PAUSE' }
  | { type: 'SYNC_TIME'; currentTime: number; isPlaying: boolean }
  | { type: 'PLAY_VIDEO'; videoId: string | null }
  | { type: 'PONG' }
  | { type: 'ERROR'; message: string };

/** YouTube検索結果 */
export interface YouTubeSearchResult {
  youtubeId: string;
  title: string;
  thumbnail: string;
}

/** YouTubeプレイリスト情報 (REST API レスポンス) */
export interface YouTubePlaylistInfo {
  playlistId: string;
  title: string;
  videoCount: number;
  videos: Array<{ youtubeId: string; title: string; thumbnail: string }>;
}
