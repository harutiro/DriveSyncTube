import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { API_URL } from '../lib/config';

/**
 * トップページ
 * - 新しいルームを作成してホストとして遷移
 * - 既存のルームコードを入力してゲストとして参加
 */
export default function TopPage() {
  const navigate = useNavigate();
  const [roomCode, setRoomCode] = useState('');
  const [isCreating, setIsCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // ----------------------------------------------------------
  // ルーム作成
  // ----------------------------------------------------------
  const handleCreateRoom = async () => {
    setError(null);
    setIsCreating(true);
    try {
      const res = await fetch(`${API_URL}/api/rooms`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });

      if (!res.ok) {
        throw new Error(`サーバーエラー (${res.status})`);
      }

      const data = (await res.json()) as { room: { code: string } };
      navigate(`/host/${data.room.code}`);
    } catch (err) {
      console.error('[TopPage] Failed to create room:', err);
      setError(
        err instanceof Error
          ? err.message
          : 'ルームの作成に失敗しました。ネットワーク接続を確認してください。',
      );
    } finally {
      setIsCreating(false);
    }
  };

  // ----------------------------------------------------------
  // ルーム参加
  // ----------------------------------------------------------
  const handleJoinRoom = () => {
    setError(null);
    const code = roomCode.trim();
    if (!code) {
      setError('ルームコードを入力してください。');
      return;
    }
    navigate(`/guest/${code}`);
  };

  // ----------------------------------------------------------
  // UI
  // ----------------------------------------------------------
  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-900 px-4">
      <div className="w-full max-w-md space-y-8">
        {/* ヘッダー */}
        <div className="text-center">
          <h1 className="text-4xl font-bold tracking-tight text-white">
            DriveSync Tube
          </h1>
          <p className="mt-2 text-sm text-slate-400">
            車内でYouTubeをみんなで楽しもう
          </p>
        </div>

        {/* エラー表示 */}
        {error && (
          <div className="rounded-lg border border-red-700 bg-red-900/40 px-4 py-3 text-sm text-red-300">
            {error}
          </div>
        )}

        {/* ルーム作成 */}
        <div className="rounded-2xl bg-slate-800 p-6 shadow-lg">
          <h2 className="mb-4 text-lg font-semibold text-white">
            ルームを作成
          </h2>
          <p className="mb-4 text-sm text-slate-400">
            新しいルームを作成して、車載モニターで再生します。
          </p>
          <button
            onClick={handleCreateRoom}
            disabled={isCreating}
            className="w-full rounded-lg bg-indigo-600 px-4 py-3 text-sm font-semibold text-white
                       transition-colors hover:bg-indigo-500 focus:outline-none focus:ring-2
                       focus:ring-indigo-400 focus:ring-offset-2 focus:ring-offset-slate-800
                       disabled:cursor-not-allowed disabled:opacity-50"
          >
            {isCreating ? '作成中...' : '新しいルームを作成'}
          </button>
        </div>

        {/* ルーム参加 */}
        <div className="rounded-2xl bg-slate-800 p-6 shadow-lg">
          <h2 className="mb-4 text-lg font-semibold text-white">
            ルームに参加
          </h2>
          <p className="mb-4 text-sm text-slate-400">
            ホストから共有されたルームコードを入力してください。
          </p>
          <div className="flex gap-3">
            <input
              type="text"
              value={roomCode}
              onChange={(e) => setRoomCode(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleJoinRoom();
              }}
              placeholder="ルームコード"
              className="flex-1 rounded-lg border border-slate-600 bg-slate-700 px-4 py-3 text-sm
                         text-white placeholder-slate-400 focus:border-indigo-500 focus:outline-none
                         focus:ring-1 focus:ring-indigo-500"
            />
            <button
              onClick={handleJoinRoom}
              className="rounded-lg bg-emerald-600 px-5 py-3 text-sm font-semibold text-white
                         transition-colors hover:bg-emerald-500 focus:outline-none focus:ring-2
                         focus:ring-emerald-400 focus:ring-offset-2 focus:ring-offset-slate-800"
            >
              参加
            </button>
          </div>
        </div>

        {/* フッター */}
        <p className="text-center text-xs text-slate-500">
          通信が不安定な環境でも安心して使えるよう設計されています。
        </p>
      </div>
    </div>
  );
}
