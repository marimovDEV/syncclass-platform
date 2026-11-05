'use client';

/**
 * Lobби ekrani (`session_status = LOBBY`) — katta QR + 6 xonali PIN.
 * O'quvchi qo'shilganda "pop" animatsiya va qisqa ovoz (WebAudio bilan generatsiya
 * qilinadi — qo'shimcha audio fayl kerak emas).
 */

import * as React from 'react';
import Link from 'next/link';
import { AnimatePresence, motion } from 'framer-motion';
import { QRCodeSVG } from 'qrcode.react';
import { ArrowLeft, Play, Users } from 'lucide-react';

import type { Participant } from '@/types/api';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { UserAvatar } from '@/components/ui/avatar';

/** Qisqa "pop" ovozi. Brauzer ruxsat bermasa — jim o'tadi. */
function usePopSound(): () => void {
  const ctxRef = React.useRef<AudioContext | null>(null);

  React.useEffect(
    () => () => {
      void ctxRef.current?.close();
      ctxRef.current = null;
    },
    [],
  );

  return React.useCallback(() => {
    try {
      type AudioContextCtor = new () => AudioContext;
      const win = window as unknown as {
        AudioContext?: AudioContextCtor;
        webkitAudioContext?: AudioContextCtor;
      };
      const Ctor = win.AudioContext ?? win.webkitAudioContext;
      if (Ctor === undefined) return;

      const ctx = ctxRef.current ?? new Ctor();
      ctxRef.current = ctx;
      if (ctx.state === 'suspended') void ctx.resume();

      const now = ctx.currentTime;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(660, now);
      osc.frequency.exponentialRampToValueAtTime(1180, now + 0.09);
      gain.gain.setValueAtTime(0.0001, now);
      gain.gain.exponentialRampToValueAtTime(0.09, now + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.22);
      osc.connect(gain).connect(ctx.destination);
      osc.start(now);
      osc.stop(now + 0.24);
    } catch {
      // Ovoz — ikkinchi darajali; xato UI ni buzmasligi kerak.
    }
  }, []);
}

export interface LobbyScreenProps {
  pinCode: string;
  joinUrl: string;
  participants: Participant[];
  presentationTitle: string;
  slidesCount: number;
  /** O'qituvchi darsni boshlaydi (`SLIDE_CHANGE{slide_index:0}`). */
  onStart?: () => void;
  canStart?: boolean;
  /** O'quvchi ekranida boshqaruv tugmasi ko'rsatilmaydi. */
  role: 'TEACHER' | 'STUDENT';
  /** "Orqaga" havolasi — dars boshlanmasdan xonadan chiqish yo'li. */
  exitHref?: string;
  className?: string;
}

export function LobbyScreen({
  pinCode,
  joinUrl,
  participants,
  presentationTitle,
  slidesCount,
  onStart,
  canStart = false,
  role,
  exitHref,
  className,
}: LobbyScreenProps) {
  const playPop = usePopSound();
  const knownRef = React.useRef<Set<string>>(new Set());
  const [justJoined, setJustJoined] = React.useState<string | null>(null);

  React.useEffect(() => {
    const known = knownRef.current;
    const fresh = participants.filter((p) => !known.has(p.student_id));
    participants.forEach((p) => known.add(p.student_id));
    if (fresh.length === 0) return;

    const last = fresh[fresh.length - 1];
    if (last === undefined) return;
    setJustJoined(last.student_id);
    playPop();
    const id = setTimeout(() => setJustJoined(null), 1_400);
    return () => clearTimeout(id);
  }, [participants, playPop]);

  const digits = pinCode.padEnd(6, '•').slice(0, 6).split('');

  return (
    <div
      className={cn(
        'flex min-h-0 flex-1 flex-col items-center justify-center gap-6 overflow-auto p-5 scrollbar-thin',
        className,
      )}
    >
      <div className="text-center">
        <p className="text-sm font-medium uppercase tracking-wider text-primary">Dars boshlanmoqda</p>
        <h1 className="mt-1 text-2xl font-semibold tracking-tight text-fg studio:text-3xl">
          {presentationTitle}
        </h1>
        <p className="mt-1 text-sm text-muted">{slidesCount} slayd</p>
      </div>

      <div className="flex flex-col items-center gap-6 split:flex-row studio:flex-row studio:gap-10">
        {/*
          QR ranglari (#ffffff / #111118) ATAYLAB qattiq — skaner uchun kontrast (DESIGN_GLOW
          istisnosi). Oq "tinch zona" endi QR ning O'ZIDA (`marginSize={4}` — standart 4 modul):
          avval uni `bg-white` konteyner berardi, shuning uchun konteyner tokenga o'tganda
          qorong'i rejimda zona yo'qolib, skanerlash buzilardi. Endi konteyner — oddiy yuza.
        */}
        <div className="overflow-hidden rounded-2xl border border-border bg-surface p-2 shadow-soft">
          <QRCodeSVG
            value={joinUrl}
            size={216}
            level="M"
            marginSize={4}
            bgColor="#ffffff"
            fgColor="#111118"
            title={`Qo'shilish havolasi: ${joinUrl}`}
            className="block rounded-xl"
          />
        </div>

        <div className="flex flex-col items-center gap-3">
          <p className="text-sm text-muted">Qo&apos;shilish uchun PIN:</p>
          <div className="flex gap-2" aria-label={`PIN kod: ${pinCode}`}>
            {digits.map((digit, index) => (
              <span
                key={index}
                className="flex size-12 items-center justify-center rounded-xl border border-border bg-surface text-2xl font-semibold tabular-nums text-fg shadow-soft studio:size-16 studio:text-4xl"
              >
                {digit}
              </span>
            ))}
          </div>
          <p className="max-w-xs break-all text-center text-xs text-muted">{joinUrl}</p>
        </div>
      </div>

      <div className="w-full max-w-2xl">
        <p className="mb-2 flex items-center justify-center gap-1.5 text-sm font-medium text-fg">
          <Users className="size-4 text-muted" aria-hidden />
          Qo&apos;shilganlar
          <span className="tabular-nums text-muted">({participants.length})</span>
        </p>

        {participants.length === 0 ? (
          <p className="rounded-xl border border-dashed border-border p-4 text-center text-sm text-muted">
            Hali hech kim qo&apos;shilmadi.
          </p>
        ) : (
          <ul className="flex flex-wrap justify-center gap-2">
            <AnimatePresence initial={false}>
              {participants.map((participant) => (
                <motion.li
                  key={participant.student_id}
                  layout
                  initial={{ opacity: 0, scale: 0.6 }}
                  animate={{ opacity: 1, scale: 1 }}
                  exit={{ opacity: 0, scale: 0.8 }}
                  transition={{ type: 'spring', stiffness: 420, damping: 24 }}
                  className={cn(
                    'flex items-center gap-2 rounded-full border px-2.5 py-1.5',
                    justJoined === participant.student_id
                      ? 'border-primary bg-primary/10'
                      : 'border-border bg-surface',
                  )}
                >
                  <UserAvatar
                    fullName={participant.full_name}
                    avatarUrl={participant.avatar_url}
                    className="size-7"
                  />
                  <span className="max-w-40 truncate text-sm text-fg">{participant.full_name}</span>
                </motion.li>
              ))}
            </AnimatePresence>
          </ul>
        )}
      </div>

      <div className="flex flex-col items-center gap-2">
        {role === 'TEACHER' ? (
          <Button size="xl" disabled={!canStart} onClick={onStart}>
            <Play aria-hidden />
            Darsni boshlash
          </Button>
        ) : (
          <p className="text-sm text-muted">O&apos;qituvchi darsni boshlashini kutmoqdamiz…</p>
        )}
        {exitHref !== undefined ? (
          <Button asChild variant="ghost" size="sm">
            <Link href={exitHref}>
              <ArrowLeft aria-hidden />
              {role === 'TEACHER' ? 'Orqaga (dars boshlanmaydi)' : 'Chiqish'}
            </Link>
          </Button>
        ) : null}
      </div>
    </div>
  );
}
