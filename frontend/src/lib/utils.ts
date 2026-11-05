import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

/** Tailwind sinflarini xavfsiz birlashtirish (keyingi sinf oldingisini bosadi). */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}

/** `min`..`max` oralig'iga qisib qo'yadi. */
export function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/** `Promise` ni berilgan ms kutadi (reconnect backoff uchun). */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** Ism-familiyadan avatar initsiallari: "Ali Valiyev" → "AV". */
export function initials(fullName: string): string {
  const parts = fullName.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  const first = parts[0]?.[0] ?? '';
  const second = parts.length > 1 ? (parts[parts.length - 1]?.[0] ?? '') : '';
  return `${first}${second}`.toUpperCase();
}

/** Fayl kengaytmasi (nuqtasiz, kichik harflarda). Kengaytma bo'lmasa `''`. */
export function fileExtension(fileName: string): string {
  const dot = fileName.lastIndexOf('.');
  if (dot <= 0 || dot === fileName.length - 1) return '';
  return fileName.slice(dot + 1).toLowerCase();
}

/** Bir martalik, barqaror ID (React `key` va optimistik yozuvlar uchun). */
export function uid(prefix = 'id'): string {
  return `${prefix}-${Math.random().toString(36).slice(2, 10)}`;
}
