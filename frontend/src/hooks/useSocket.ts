import { useCallback, useEffect, useRef, useState } from 'react';
import type { WSMessage, WSServerMessage } from '../types';

// ============================================================
// 定数
// ============================================================
/** 初回再接続待ち (ms) */
const INITIAL_RETRY_DELAY = 1_000;
/** 最大再接続待ち (ms) */
const MAX_RETRY_DELAY = 30_000;
/** ハートビート送信間隔 (ms) */
const HEARTBEAT_INTERVAL = 30_000;
/** PONG 応答タイムアウト (ms) */
const PONG_TIMEOUT = 5_000;

// ============================================================
// 型
// ============================================================
export type ConnectionState = 'connecting' | 'connected' | 'disconnected';

export interface UseSocketOptions {
  /** WebSocket 接続先 URL */
  url: string;
  /** サーバーからメッセージを受信したときのコールバック */
  onMessage: (message: WSServerMessage) => void;
  /** 接続確立時のコールバック（JOIN 再送等に使用） */
  onConnect?: () => void;
  /** 切断時のコールバック */
  onDisconnect?: () => void;
  /** false を渡すと接続を行わない（デフォルト true） */
  enabled?: boolean;
}

export interface UseSocketReturn {
  /** メッセージ送信関数。接続中でなければ警告のみ */
  send: (message: WSMessage) => void;
  /** 現在の接続状態 */
  connectionState: ConnectionState;
  /** 累計再接続回数 */
  reconnectCount: number;
}

// ============================================================
// フック本体
// ============================================================
export function useSocket(options: UseSocketOptions): UseSocketReturn {
  const { url, onMessage, onConnect, onDisconnect, enabled = true } = options;

  // ----------------------------------------------------------
  // State
  // ----------------------------------------------------------
  const [connectionState, setConnectionState] =
    useState<ConnectionState>('disconnected');
  const [reconnectCount, setReconnectCount] = useState(0);

  // ----------------------------------------------------------
  // Refs – レンダー間で生き続ける値
  // ----------------------------------------------------------
  const wsRef = useRef<WebSocket | null>(null);
  const retryCountRef = useRef(0);
  const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const heartbeatTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pongTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** クリーンアップ済みかどうか（意図的切断を区別するフラグ） */
  const unmountedRef = useRef(false);

  // コールバックを最新値で参照できるよう ref 化
  const onMessageRef = useRef(onMessage);
  onMessageRef.current = onMessage;
  const onConnectRef = useRef(onConnect);
  onConnectRef.current = onConnect;
  const onDisconnectRef = useRef(onDisconnect);
  onDisconnectRef.current = onDisconnect;

  // ----------------------------------------------------------
  // タイマークリアユーティリティ
  // ----------------------------------------------------------
  const clearRetryTimer = useCallback(() => {
    if (retryTimerRef.current !== null) {
      clearTimeout(retryTimerRef.current);
      retryTimerRef.current = null;
    }
  }, []);

  const clearHeartbeat = useCallback(() => {
    if (heartbeatTimerRef.current !== null) {
      clearTimeout(heartbeatTimerRef.current);
      heartbeatTimerRef.current = null;
    }
    if (pongTimerRef.current !== null) {
      clearTimeout(pongTimerRef.current);
      pongTimerRef.current = null;
    }
  }, []);

  // ----------------------------------------------------------
  // ハートビート開始
  // ----------------------------------------------------------
  const startHeartbeat = useCallback(() => {
    clearHeartbeat();

    heartbeatTimerRef.current = setInterval(() => {
      const ws = wsRef.current;
      if (!ws || ws.readyState !== WebSocket.OPEN) return;

      // PING 送信
      try {
        ws.send(JSON.stringify({ type: 'PING' }));
      } catch (err) {
        console.error('[useSocket] Failed to send PING:', err);
        return;
      }

      // PONG タイムアウト監視
      pongTimerRef.current = setTimeout(() => {
        console.warn(
          '[useSocket] PONG timeout – closing connection for reconnect',
        );
        ws.close();
      }, PONG_TIMEOUT);
    }, HEARTBEAT_INTERVAL) as unknown as ReturnType<typeof setTimeout>;
  }, [clearHeartbeat]);

  // ----------------------------------------------------------
  // 接続関数
  // ----------------------------------------------------------
  const connect = useCallback(() => {
    // 既存の接続をクリーンアップ
    if (wsRef.current) {
      wsRef.current.onopen = null;
      wsRef.current.onclose = null;
      wsRef.current.onerror = null;
      wsRef.current.onmessage = null;
      if (
        wsRef.current.readyState === WebSocket.OPEN ||
        wsRef.current.readyState === WebSocket.CONNECTING
      ) {
        wsRef.current.close();
      }
      wsRef.current = null;
    }

    setConnectionState('connecting');
    console.log('[useSocket] Connecting to', url);

    let ws: WebSocket;
    try {
      ws = new WebSocket(url);
    } catch (err) {
      console.error('[useSocket] Failed to create WebSocket:', err);
      setConnectionState('disconnected');
      scheduleRetry();
      return;
    }
    wsRef.current = ws;

    // --- onopen ---
    ws.onopen = () => {
      console.log('[useSocket] Connected');
      retryCountRef.current = 0;
      setConnectionState('connected');
      startHeartbeat();
      onConnectRef.current?.();
    };

    // --- onclose ---
    ws.onclose = (event) => {
      console.log(
        `[useSocket] Closed (code=${event.code}, reason=${event.reason})`,
      );
      clearHeartbeat();
      setConnectionState('disconnected');
      onDisconnectRef.current?.();

      // 意図的なアンマウントでなければ再接続
      if (!unmountedRef.current) {
        scheduleRetry();
      }
    };

    // --- onerror ---
    ws.onerror = (event) => {
      console.error('[useSocket] Error:', event);
      // onerror の後に必ず onclose が呼ばれるため、ここでは何もしない
    };

    // --- onmessage ---
    ws.onmessage = (event) => {
      let parsed: WSServerMessage;
      try {
        parsed = JSON.parse(event.data as string) as WSServerMessage;
      } catch (err) {
        console.error('[useSocket] Failed to parse message:', err);
        return;
      }

      // PONG を受け取ったらタイムアウトタイマーをクリア
      if (parsed.type === 'PONG') {
        if (pongTimerRef.current !== null) {
          clearTimeout(pongTimerRef.current);
          pongTimerRef.current = null;
        }
      }

      onMessageRef.current(parsed);
    };

    // eslint-disable-next-line @typescript-eslint/no-use-before-define -- 相互参照
    function scheduleRetry() {
      clearRetryTimer();
      const delay = Math.min(
        INITIAL_RETRY_DELAY * 2 ** retryCountRef.current,
        MAX_RETRY_DELAY,
      );
      console.log(
        `[useSocket] Reconnecting in ${delay}ms (attempt ${retryCountRef.current + 1})`,
      );
      retryTimerRef.current = setTimeout(() => {
        retryCountRef.current += 1;
        setReconnectCount((c) => c + 1);
        connect();
      }, delay);
    }
  }, [url, startHeartbeat, clearHeartbeat, clearRetryTimer]);

  // ----------------------------------------------------------
  // Effect: 接続ライフサイクル
  // ----------------------------------------------------------
  useEffect(() => {
    if (!enabled) {
      return;
    }

    unmountedRef.current = false;
    connect();

    return () => {
      unmountedRef.current = true;
      clearRetryTimer();
      clearHeartbeat();

      if (wsRef.current) {
        wsRef.current.onopen = null;
        wsRef.current.onclose = null;
        wsRef.current.onerror = null;
        wsRef.current.onmessage = null;
        wsRef.current.close();
        wsRef.current = null;
      }

      setConnectionState('disconnected');
    };
  }, [enabled, connect, clearRetryTimer, clearHeartbeat]);

  // ----------------------------------------------------------
  // send 関数
  // ----------------------------------------------------------
  const send = useCallback((message: WSMessage) => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      console.warn(
        '[useSocket] Cannot send – WebSocket is not open. Message:',
        message,
      );
      return;
    }
    try {
      ws.send(JSON.stringify(message));
    } catch (err) {
      console.error('[useSocket] Failed to send message:', err);
    }
  }, []);

  return { send, connectionState, reconnectCount };
}
