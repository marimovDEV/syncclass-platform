'use client';

import * as React from 'react';
import {
  ArrowDown,
  ArrowUp,
  BarChart3,
  Code2,
  Copy,
  FileText,
  GripVertical,
  Image as ImageIcon,
  ListChecks,
  MessageSquareText,
  Trash2,
} from 'lucide-react';

import type { Slide, SlideType } from '@/types/api';
import { MAX_SLIDES } from '@/types/api';
import { cn } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { SimpleTooltip } from '@/components/ui/tooltip';

export const SLIDE_TYPE_ICON: Record<SlideType, typeof FileText> = {
  MARKDOWN: FileText,
  CODE: Code2,
  QUIZ: ListChecks,
  IMAGE: ImageIcon,
  POLL: BarChart3,
  OPEN: MessageSquareText,
};

export const SLIDE_TYPE_LABEL: Record<SlideType, string> = {
  MARKDOWN: 'Matn',
  CODE: 'Kod',
  QUIZ: 'Quiz',
  IMAGE: 'Rasm',
  POLL: 'So’rovnoma',
  OPEN: 'Ochiq savol',
};

/** Qo'shish menyusidagi qisqa tavsif — ayniqsa QUIZ va POLL farqi aniq ko'rinsin. */
const SLIDE_TYPE_HINT: Record<SlideType, string> = {
  MARKDOWN: 'Sarlavha, ro’yxat, jadval',
  CODE: 'Jonli tahrirlanadigan kod',
  QUIZ: 'Baholanadi, XP beriladi',
  IMAGE: 'Rasm yuklang',
  POLL: 'Baholanmaydi, XP yo’q',
  OPEN: 'So’z buluti, anonim',
};

const ADD_ORDER: SlideType[] = ['MARKDOWN', 'CODE', 'IMAGE', 'QUIZ', 'POLL', 'OPEN'];

/** Ro'yxatda ko'rinadigan qisqa sarlavha (tur bo'yicha toraytirilgan). */
function slideCaption(slide: Slide): string {
  if (slide.title !== null && slide.title.trim().length > 0) return slide.title;
  switch (slide.type) {
    case 'MARKDOWN': {
      const firstLine = slide.content.split('\n').find((line) => line.trim().length > 0);
      return firstLine?.replace(/^#+\s*/, '').slice(0, 60) ?? 'Bo’sh matn';
    }
    case 'CODE':
      return `${slide.code_lang} kodi`;
    case 'IMAGE':
      return slide.alt.trim().length > 0 ? slide.alt.slice(0, 60) : 'Rasm (alt matn yo’q)';
    case 'QUIZ':
    case 'POLL':
    case 'OPEN':
      return slide.question.trim().length > 0 ? slide.question.slice(0, 60) : 'Savol kiritilmagan';
  }
}

export interface SlideListPanelProps {
  slides: Slide[];
  activeIndex: number;
  onSelect: (index: number) => void;
  /** `IMAGE` uchun sahifa avval rasm tanlash oynasini ochadi (URLsiz IMAGE yaroqsiz). */
  onAdd: (type: SlideType) => void;
  onDuplicate: (index: number) => void;
  onDelete: (index: number) => void;
  onMove: (from: number, to: number) => void;
  /** Rasm yuklanayotgan payt — "Rasm" tugmasi spinner ko'rsatadi. */
  addingImage?: boolean;
  /** Slayd indeksi → xatolar soni (qizil belgi uchun). */
  issueCountByIndex?: Readonly<Record<number, number>>;
  className?: string;
}

/**
 * Chap panel: slaydlar ro'yxati.
 * Tartibni sichqoncha bilan (HTML5 drag-and-drop) ham, klaviatura bilan
 * (yuqori/past tugmalari) ham o'zgartirish mumkin — a11y uchun ikkisi ham kerak.
 * Slayd turini O'ZGARTIRISH yo'q (ma'lumot yo'qolishi mumkin, FUTURE.md #8) — faqat yangi qo'shish.
 */
export function SlideListPanel({
  slides,
  activeIndex,
  onSelect,
  onAdd,
  onDuplicate,
  onDelete,
  onMove,
  addingImage = false,
  issueCountByIndex,
  className,
}: SlideListPanelProps) {
  const [dragIndex, setDragIndex] = React.useState<number | null>(null);
  const [overIndex, setOverIndex] = React.useState<number | null>(null);

  const atLimit = slides.length >= MAX_SLIDES;

  const finishDrag = (): void => {
    setDragIndex(null);
    setOverIndex(null);
  };

  return (
    <div className={cn('flex min-h-0 flex-col rounded-2xl border border-border bg-surface', className)}>
      <div className="flex items-center justify-between gap-2 border-b border-border px-3 py-2">
        <p className="text-xs font-semibold uppercase tracking-wide text-muted">
          Slaydlar · {slides.length}/{MAX_SLIDES}
        </p>
      </div>

      {/* Native overflow: panel `max-h` bilan cheklanganda ham ro'yxat scroll qiladi
          (60 sahifali PDF importidan keyin 60 qator bo'ladi). */}
      <div className="min-h-0 flex-1 overflow-y-auto scrollbar-thin">
        <ul className="flex flex-col gap-1 p-2" aria-label="Slaydlar ro’yxati">
          {slides.map((slide, index) => {
            const Icon = SLIDE_TYPE_ICON[slide.type];
            const active = index === activeIndex;
            const issues = issueCountByIndex?.[index] ?? 0;
            return (
              <li
                key={`slide-${index}`}
                draggable
                onDragStart={(event) => {
                  setDragIndex(index);
                  event.dataTransfer.effectAllowed = 'move';
                  event.dataTransfer.setData('text/plain', String(index));
                }}
                onDragOver={(event) => {
                  event.preventDefault();
                  event.dataTransfer.dropEffect = 'move';
                  setOverIndex(index);
                }}
                onDragLeave={() => setOverIndex((current) => (current === index ? null : current))}
                onDrop={(event) => {
                  event.preventDefault();
                  const raw = event.dataTransfer.getData('text/plain');
                  const from = Number.parseInt(raw, 10);
                  if (Number.isFinite(from) && from !== index) onMove(from, index);
                  finishDrag();
                }}
                onDragEnd={finishDrag}
                className={cn(
                  'rounded-xl border transition-colors duration-150',
                  active ? 'border-primary bg-primary/[0.07]' : 'border-transparent hover:bg-fg/[0.03]',
                  overIndex === index && dragIndex !== null && dragIndex !== index
                    ? 'border-primary/60 bg-primary/[0.04]'
                    : '',
                  dragIndex === index ? 'opacity-50' : '',
                )}
              >
                <div className="flex items-center gap-1 px-1.5 py-1.5">
                  <GripVertical className="size-3.5 shrink-0 cursor-grab text-muted" aria-hidden />
                  <button
                    type="button"
                    onClick={() => onSelect(index)}
                    className="flex min-w-0 flex-1 items-center gap-2 text-left"
                    aria-current={active ? 'true' : undefined}
                    aria-label={`${index + 1}-slayd, ${SLIDE_TYPE_LABEL[slide.type]}: ${slideCaption(slide)}`}
                  >
                    <span className="w-5 shrink-0 text-right text-[11px] tabular-nums text-muted">
                      {index + 1}
                    </span>
                    <Icon
                      className={cn('size-3.5 shrink-0', active ? 'text-primary' : 'text-muted')}
                      aria-hidden
                    />
                    <span className="min-w-0 flex-1 truncate text-xs text-fg">
                      {slideCaption(slide)}
                    </span>
                    {issues > 0 ? (
                      <SimpleTooltip content={`${issues} ta xato — saqlanmaydi`}>
                        <span className="inline-flex">
                          <Badge variant="danger">{issues}</Badge>
                        </span>
                      </SimpleTooltip>
                    ) : null}
                  </button>

                  <div className="flex shrink-0 items-center">
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      aria-label="Yuqoriga ko’chirish"
                      disabled={index === 0}
                      onClick={() => onMove(index, index - 1)}
                    >
                      <ArrowUp aria-hidden />
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      aria-label="Pastga ko’chirish"
                      disabled={index === slides.length - 1}
                      onClick={() => onMove(index, index + 1)}
                    >
                      <ArrowDown aria-hidden />
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      aria-label={atLimit ? `Nusxa olib bo’lmaydi: ${MAX_SLIDES} ta chegara` : 'Nusxa olish'}
                      disabled={atLimit}
                      onClick={() => onDuplicate(index)}
                    >
                      <Copy aria-hidden />
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      aria-label="O’chirish"
                      onClick={() => onDelete(index)}
                    >
                      <Trash2 aria-hidden />
                    </Button>
                  </div>
                </div>
              </li>
            );
          })}

          {slides.length === 0 ? (
            <li className="px-2 py-6 text-center text-xs text-muted">
              Slayd yo’q — pastdagi tugmalardan birini bosing.
            </li>
          ) : null}
        </ul>
      </div>

      <div className="flex flex-col gap-1.5 border-t border-border p-2">
        <p className="text-[11px] font-semibold uppercase tracking-wide text-muted">Slayd qo’shish</p>
        <div className="grid grid-cols-2 gap-1.5">
          {ADD_ORDER.map((type) => {
            const Icon = SLIDE_TYPE_ICON[type];
            const busy = type === 'IMAGE' && addingImage;
            return (
              <Button
                key={type}
                type="button"
                variant="outline"
                size="sm"
                disabled={atLimit || addingImage}
                loading={busy}
                onClick={() => onAdd(type)}
                className="h-auto flex-col items-start gap-0 px-2 py-1.5 text-left"
                aria-label={`${SLIDE_TYPE_LABEL[type]} slayd qo’shish — ${SLIDE_TYPE_HINT[type]}`}
              >
                <span className="flex items-center gap-1.5 text-xs font-medium">
                  {busy ? null : <Icon aria-hidden />}
                  {SLIDE_TYPE_LABEL[type]}
                </span>
                <span className="text-[10px] font-normal text-muted">{SLIDE_TYPE_HINT[type]}</span>
              </Button>
            );
          })}
        </div>
        {atLimit ? (
          <p role="status" className="text-xs text-danger">
            Taqdimotda ko’pi bilan {MAX_SLIDES} ta slayd bo’ladi — yangi qo’shish uchun birini
            o’chiring.
          </p>
        ) : null}
      </div>
    </div>
  );
}
