'use client';

/**
 * Jonli xona WebSocket ulanishi — CONTRACTS.md §5, AUDIT.md §B2/§B3/§B4/§B5.
 *
 * Oqim:
 *   `POST /rooms/{pin}/ws-ticket` (30 s, bir martalik — AUDIT.md §B3)
 *     → `wss://{host}/ws/room/{pin}?ticket=...`
 *     → server darhol `ROOM_STATE_SYNC` yuboradi (AUDIT.md §B2).
 *
 * Chidamlilik:
 * - **Auto-reconnect:** exponential backoff + jitter, maksimum 30 s.
 * - **Heartbeat:** har `WS_HEARTBEAT_SEC` (25 s) `PING`; 3 ta javobsiz `PING` → qayta ulanish
 *   (AUDIT.md §B4 — Nginx 60 s da uzadi).
 * - **`online`/`offline`:** tarmoq qaytganda backoff kutilmaydi, darhol ulanadi.
 * - **`seq` uzilishi:** `useLiveRoom` uzilishni sezsa, ulanish qayta ochiladi va server
 *   `ROOM_STATE_SYNC` ni o'zi yuboradi.
 *   ⚠️ CONTRACTS.md §5 da klient → server yo'nalishida `ROOM_STATE_SYNC` **so'rovi yo'q**,
 *   shuning uchun resync yagona kontraktga mos usul — ulanishni qayta ochish bilan qilinadi.
 * - **Ticket 4xx** (403 `NOT_IN_GROUP`, 404, 401) → qayta urinilmaydi, `connection='error'`.
 *   5xx va tarmoq xatosi → backoff bilan qayta urinish.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import type { ApiError } from '@/lib/api';
import { isApiError, wsRoomUrl } from '@/lib/api';
import { createWsTicket } from '@/lib/resources';
import type { WsClientEvent, WsClientEventType, WsConnectionState } from '@/types/api';
import { WS_HEARTBEAT_SEC, isWsServerEvent, wsClientFrame } from '@/types/api';
import { liveRoomActions, useConnectionState } from '@/store/useLiveRoom';

/** `type` bo'yicha aniq `data` tipi — noto'g'ri juftlik kompilyatsiyada tutiladi. */
export type ClientDataFor<K extends WsClientEventType> = Extract<WsClientEvent, { type: K }>['data'];

/** Tiplangan yuboruvchi. Ulanish yopiq bo'lsa `false` qaytaradi (xato tashlamaydi). */
export type SendClientEvent = <K extends WsClientEventType>(
  type: K,
  data: ClientDataFor<K>,
) => boolean;

export interface UseRoomSocketOptions {
  /** 6 xonali PIN. Bo'sh bo'lsa ulanish boshlanmaydi. */
  pin: string;
  /** Sessiya/rol tayyor bo'lmaguncha `false` — ticket behuda sarflanmasin. */
  enabled?: boolean;
}

export interface RoomSocket {
  connection: WsConnectionState;
  /** Nechanchi qayta ulanish urinishi ketmoqda (0 — ulangan). */
  attempt: number;
  /** Ticket olishdagi xato (403 `NOT_IN_GROUP` kabi) — UI shu matnni ko'rsatadi. */
  ticketError: ApiError | null;
  send: SendClientEvent;
  /** Qo'lda qayta ulanish (UI dagi "Qayta ulanish" tugmasi). */
  reconnect: () => void;
}

const MAX_BACKOFF_MS = 30_000;
const BASE_BACKOFF_MS = 500;
const MAX_MISSED_PONGS = 3;

function backoffDelay(retries: number): number {
  const base = Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * 2 ** Math.max(0, retries - 1));
  // Jitter 0..30% — 30 ta klient bir vaqtda urmasin.
  return base + Math.random() * base * 0.3;
}

export function useRoomSocket({ pin, enabled = true }: UseRoomSocketOptions): RoomSocket {
  const connection = useConnectionState();
  const [attempt, setAttempt] = useState(0);
  const [ticketError, setTicketError] = useState<ApiError | null>(null);

  const socketRef = useRef<WebSocket | null>(null);
  const forceReconnectRef = useRef<(reason: string) => void>(() => undefined);

  useEffect(() => {
    if (!enabled || pin.length === 0) return;

    let disposed = false;
    let ended = false;
    let generation = 0;
    let socket: WebSocket | null = null;
    let retries = 0;
    let missedPongs = 0;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let heartbeat: ReturnType<typeof setInterval> | null = null;

    const stopHeartbeat = (): void => {
      if (heartbeat !== null) {
        clearInterval(heartbeat);
        heartbeat = null;
      }
    };

    const clearRetry = (): void => {
      if (retryTimer !== null) {
        clearTimeout(retryTimer);
        retryTimer = null;
      }
    };

    /** Eski socket ning callbacklarini uzib, jim yopadi. */
    const detach = (ws: WebSocket | null, reason: string): void => {
      if (ws === null) return;
      ws.onopen = null;
      ws.onmessage = null;
      ws.onerror = null;
      ws.onclose = null;
      try {
        if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
          ws.close(1000, reason);
        }
      } catch {
        // Yopilish xatosi ahamiyatsiz.
      }
    };

    const scheduleReconnect = (): void => {
      if (disposed || ended) return;
      clearRetry();
      retries += 1;
      setAttempt(retries);
      liveRoomActions.setConnection('reconnecting');
      retryTimer = setTimeout(() => {
        retryTimer = null;
        void open();
      }, backoffDelay(retries));
    };

    const startHeartbeat = (): void => {
      stopHeartbeat();
      heartbeat = setInterval(() => {
        if (socket === null || socket.readyState !== WebSocket.OPEN) return;
        if (missedPongs >= MAX_MISSED_PONGS) {
          forceReconnect('heartbeat-timeout');
          return;
        }
        missedPongs += 1;
        socket.send(JSON.stringify(wsClientFrame('PING', {})));
      }, WS_HEARTBEAT_SEC * 1000);
    };

    /** Backoff kutmasdan darhol qayta ulanadi (resync, tarmoq qaytishi, heartbeat). */
    const forceReconnect = (reason: string): void => {
      if (disposed || ended) return;
      generation += 1; // eski socket callbacklari endi e'tiborga olinmaydi
      stopHeartbeat();
      clearRetry();
      const old = socket;
      socket = null;
      socketRef.current = null;
      detach(old, reason);
      retries = 0;
      setAttempt(0);
      liveRoomActions.setConnection('reconnecting');
      void open();
    };

    forceReconnectRef.current = forceReconnect;

    const handleMessage = (raw: MessageEvent<unknown>): void => {
      if (typeof raw.data !== 'string') return;
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw.data);
      } catch {
        return; // buzuq frame — jim tashlab ketiladi
      }
      if (!isWsServerEvent(parsed)) return;

      if (parsed.type === 'PONG') {
        missedPongs = 0;
        return;
      }

      const result = liveRoomActions.applyServerEvent(parsed);

      if (parsed.type === 'SESSION_ENDED') {
        ended = true;
        stopHeartbeat();
        clearRetry();
        const old = socket;
        socket = null;
        socketRef.current = null;
        detach(old, 'session-ended');
        liveRoomActions.setConnection('closed');
        return;
      }

      if (result === 'gap') {
        // `seq` uzilgan → serverdan to'liq holat kerak (AUDIT.md §B2).
        liveRoomActions.clearSeqGap();
        forceReconnect('seq-gap');
      }
    };

    const open = async (): Promise<void> => {
      if (disposed || ended) return;

      // Brauzer offline — `online` listener qayta uradi, ticket behuda sarflanmasin.
      if (typeof navigator !== 'undefined' && navigator.onLine === false) {
        liveRoomActions.setConnection('reconnecting');
        return;
      }

      generation += 1;
      const myGeneration = generation;
      liveRoomActions.setConnection(retries === 0 ? 'connecting' : 'reconnecting');

      let ticket: string;
      try {
        const out = await createWsTicket(pin);
        ticket = out.ticket;
      } catch (error) {
        if (disposed || ended || myGeneration !== generation) return;
        if (isApiError(error)) {
          setTicketError(error);
          const fatal = !error.isNetworkError && error.status >= 400 && error.status < 500;
          if (fatal) {
            liveRoomActions.setConnection('error');
            return;
          }
        }
        scheduleReconnect();
        return;
      }

      if (disposed || ended || myGeneration !== generation) return;
      setTicketError(null);

      let ws: WebSocket;
      try {
        ws = new WebSocket(wsRoomUrl(pin, ticket));
      } catch {
        scheduleReconnect();
        return;
      }

      socket = ws;
      socketRef.current = ws;

      ws.onopen = () => {
        if (myGeneration !== generation) {
          detach(ws, 'stale-generation');
          return;
        }
        retries = 0;
        missedPongs = 0;
        setAttempt(0);
        liveRoomActions.setConnection('open');
        startHeartbeat();
      };

      ws.onmessage = handleMessage;

      ws.onerror = () => {
        // `onclose` baribir keladi — qayta ulanish faqat o'sha yerda boshlanadi.
      };

      ws.onclose = () => {
        if (disposed || ended || myGeneration !== generation) return;
        stopHeartbeat();
        socket = null;
        socketRef.current = null;
        scheduleReconnect();
      };
    };

    const handleOnline = (): void => {
      retries = 0;
      setAttempt(0);
      forceReconnect('network-online');
    };

    const handleOffline = (): void => {
      if (disposed || ended) return;
      liveRoomActions.setConnection('reconnecting');
    };

    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);

    void open();

    return () => {
      disposed = true;
      generation += 1;
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
      stopHeartbeat();
      clearRetry();
      detach(socket, 'unmount');
      socket = null;
      socketRef.current = null;
      liveRoomActions.setConnection('closed');
    };
  }, [pin, enabled]);

  const send = useCallback<SendClientEvent>((type, data) => {
    const ws = socketRef.current;
    if (ws === null || ws.readyState !== WebSocket.OPEN) return false;
    try {
      // `wsClientFrame` ni butun union bilan chaqiramiz: `K` bo'yicha aniqlik
      // `SendClientEvent` imzosida allaqachon ta'minlangan (chaqiruv joyida tekshiriladi).
      ws.send(JSON.stringify(wsClientFrame<WsClientEvent>(type, data)));
      return true;
    } catch {
      return false;
    }
  }, []);

  const reconnect = useCallback(() => {
    forceReconnectRef.current('manual');
  }, []);

  return { connection, attempt, ticketError, send, reconnect };
}
