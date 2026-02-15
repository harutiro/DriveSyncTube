/**
 * バックエンド接続先を動的に解決する。
 *
 * 優先順位:
 *   1. VITE_API_URL / VITE_WS_URL が設定されていればそちらを使用。
 *   2. ポートなし or 80/443 → 本番 (同一オリジン、Nginx リバースプロキシ経由)
 *   3. ポートあり (5173 等) → 開発モード → hostname:3000 にフォールバック
 */
const { protocol, hostname, port } = window.location;

const isProduction = !port || port === "80" || port === "443";

const httpBase = isProduction
  ? `${protocol}//${hostname}`
  : `http://${hostname}:3000`;

const wsProtocol = protocol === "https:" ? "wss:" : "ws:";
const wsBase = isProduction
  ? `${wsProtocol}//${hostname}`
  : `ws://${hostname}:3000`;

export const API_URL =
  import.meta.env.VITE_API_URL || httpBase;

export const WS_URL =
  import.meta.env.VITE_WS_URL || wsBase;
