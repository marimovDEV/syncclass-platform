'use client';

/**
 * O'qituvchi studiyasi uchun klaviatura yorliqlari — AUDIT.md §G1 (🔴 bloker).
 *
 * `→`/`Space` keyingi · `←` oldingi · `L` lazer · `C` jonli kod · `Q` quiz · `F` fullscreen.
 *
 * ⛔ **Eng muhim qoida:** `event.target` `input`/`textarea`/`select`/`[contenteditable]`
 * yoki `.monaco-editor` ichida bo'lsa handler **butunlay ishlamaydi**. Aks holda o'qituvchi
 * Monaco da jonli kod yozayotganda `Space` bosadi va slayd o'tib ketadi.
 * Yagona istisno — `Escape`: jonli kod rejimidan chiqish uchun u har qanday joydan ishlaydi.
 *
 * Modifikator (Ctrl/Cmd/Alt) bosilgan bo'lsa ham ishlamaydi — brauzer yorliqlari buzilmasin.
 */

import { useEffect, useRef } from 'react';

export type HotkeyAction = 'next' | 'prev' | 'laser' | 'code' | 'quiz' | 'fullscreen' | 'escape';

export type HotkeyHandlers = Partial<Record<HotkeyAction, () => void>>;

/** Yozish maydonlari — bu yerda hotkey O'LIK. */
const TYPING_TAGS = new Set(['INPUT', 'TEXTAREA', 'SELECT', 'OPTION']);

const TYPING_SELECTOR =
  'input, textarea, select, [contenteditable=""], [contenteditable="true"], .monaco-editor, [data-hotkeys="off"]';

/**
 * Element yozish maydoni (yoki uning ichida) ekanini aniqlaydi.
 *
 * `instanceof` ataylab ishlatilmaydi: iframe/portal dan kelgan element boshqa `window`
 * ga tegishli bo'lishi mumkin, bundan tashqari bu funksiya DOM siz ham sinovdan o'tadi.
 */
export function isTypingTarget(target: EventTarget | null): boolean {
  if (target === null || typeof target !== 'object') return false;

  const node = target as {
    tagName?: unknown;
    isContentEditable?: unknown;
    closest?: unknown;
  };

  if (typeof node.tagName === 'string' && TYPING_TAGS.has(node.tagName.toUpperCase())) return true;
  if (node.isContentEditable === true) return true;

  if (typeof node.closest === 'function') {
    const closest = node.closest as (selector: string) => unknown;
    try {
      if (closest.call(node, TYPING_SELECTOR) != null) return true;
    } catch {
      return false;
    }
  }

  return false;
}

/** `event.code` (layout dan mustaqil) → amal. `key` faqat zaxira sifatida. */
export function hotkeyActionFor(code: string, key: string): HotkeyAction | null {
  switch (code) {
    case 'ArrowRight':
    case 'Space':
      return 'next';
    case 'ArrowLeft':
      return 'prev';
    case 'KeyL':
      return 'laser';
    case 'KeyC':
      return 'code';
    case 'KeyQ':
      return 'quiz';
    case 'KeyF':
      return 'fullscreen';
    case 'Escape':
      return 'escape';
    default:
      break;
  }

  // `code` bo'sh kelsa (ba'zi mobil klaviaturalar) — `key` bo'yicha.
  switch (key) {
    case 'ArrowRight':
    case ' ':
      return 'next';
    case 'ArrowLeft':
      return 'prev';
    case 'Escape':
      return 'escape';
    default:
      return null;
  }
}

/** Hotkey hisoblanadigan event ning minimal shakli (sinov uchun ham shu). */
export interface HotkeyEventLike {
  code: string;
  key: string;
  target: EventTarget | null;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  repeat: boolean;
}

/**
 * Event hotkey sifatida qabul qilinishi kerakmi — **sof funksiya** (sinovdan o'tadi).
 * Qaytaradi: bajarilishi kerak bo'lgan amal yoki `null`.
 */
export function resolveHotkey(event: HotkeyEventLike): HotkeyAction | null {
  if (event.ctrlKey || event.metaKey || event.altKey) return null;

  const action = hotkeyActionFor(event.code, event.key);
  if (action === null) return null;

  // `Escape` — yagona istisno (AUDIT.md §G1: "jonli kod rejimida faqat Esc chiqadi").
  if (action === 'escape') return 'escape';

  if (event.repeat && (action === 'laser' || action === 'code' || action === 'quiz')) return null;

  if (isTypingTarget(event.target)) return null;

  return action;
}

export interface UseHotkeysOptions {
  /** `false` bo'lsa tinglash butunlay o'chadi (masalan o'quvchi ekranida). */
  enabled?: boolean;
}

/**
 * Yorliqlarni `window` ga biriktiradi. `handlers` har renderda yangi bo'lishi mumkin —
 * ichida ref orqali o'qiladi, shuning uchun listener qayta biriktirilmaydi.
 */
export function useHotkeys(handlers: HotkeyHandlers, { enabled = true }: UseHotkeysOptions = {}): void {
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;

  useEffect(() => {
    if (!enabled) return;

    const onKeyDown = (event: KeyboardEvent): void => {
      const action = resolveHotkey({
        code: event.code,
        key: event.key,
        target: event.target,
        ctrlKey: event.ctrlKey,
        metaKey: event.metaKey,
        altKey: event.altKey,
        repeat: event.repeat,
      });
      if (action === null) return;

      const handler = handlersRef.current[action];
      if (handler === undefined) return;

      // `Space` sahifani pastga surmasin, `→`/`←` scroll qilmasin.
      event.preventDefault();
      handler();
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [enabled]);
}
