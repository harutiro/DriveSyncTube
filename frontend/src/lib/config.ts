/**
 * バックエンド接続先を動的に解決する。
 *
 * - VITE_API_URL / VITE_WS_URL が設定されていればそちらを優先。
 * - 未設定の場合、ブラウザのアクセス先ホスト名 + ポート 3000 を使う。
 *   → スマホから 192.168.x.x:5173 でアクセスすれば、
 *     自動的に 192.168.x.x:3000 に接続される。
 */
const hostname = window.location.hostname;

export const API_URL =
  import.meta.env.VITE_API_URL || `http://${hostname}:3000`;

export const WS_URL =
  import.meta.env.VITE_WS_URL || `ws://${hostname}:3000`;
