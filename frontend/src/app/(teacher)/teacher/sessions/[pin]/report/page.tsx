'use client';

import * as React from 'react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { ArrowLeft, Eye, Info, ListChecks, Search, Trophy, Users } from 'lucide-react';

import type { AttendanceStatus, RoomQuizStat, RoomReportRow } from '@/types/api';
import {
  ATTENDANCE_STATUS_LABELS,
  formatDateTime,
  formatNumber,
  SESSION_STATUS_LABELS,
} from '@/lib/format';
import { queryKeys } from '@/lib/query';
import { getRoomReport } from '@/lib/resources';
import { cn } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Progress } from '@/components/ui/progress';
import { UserAvatar } from '@/components/ui/avatar';
import { AppShell } from '@/components/shared/AppShell';
import { EmptyState, ErrorState, LoadingState } from '@/components/shared/states';

/** AUDIT.md §F — focus tracker faqat tavsiya xarakterida. */
const FOCUS_DISCLAIMER = 'Tavsiya xarakterida, bahoga ta’sir qilmaydi.';

const STATUS_BADGE: Record<AttendanceStatus, 'success' | 'accent' | 'danger'> = {
  PRESENT: 'success',
  LATE: 'accent',
  ABSENT: 'danger',
};

/** Variant indeksini harfga aylantiradi (0 → A). */
const OPTION_LETTERS = 'ABCDEF';

function optionLabel(index: number): string {
  return OPTION_LETTERS[index] ?? String(index + 1);
}

/** `135` → `2 daq 15 son`. */
function formatSeconds(totalSeconds: number): string {
  if (!Number.isFinite(totalSeconds) || totalSeconds <= 0) return '0 son';
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = Math.round(totalSeconds % 60);
  if (minutes === 0) return `${seconds} son`;
  return `${minutes} daq ${seconds} son`;
}

/** `4230` → `4.2 s`. */
function formatMs(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '—';
  return `${(ms / 1000).toFixed(1)} s`;
}

export default function SessionReportPage() {
  // CONTRACTS.md §10 (v1.1.2) — segment nomi `[pin]`: hisobotning yagona kaliti
  // `pin_code` (`GET /rooms/{pin}/report`), sessiya UUID i emas.
  const params = useParams();
  const rawPin = params.pin;
  const pinFromUrl = typeof rawPin === 'string' ? rawPin : (rawPin?.[0] ?? '');

  return (
    <AppShell
      allowRoles={['TEACHER', 'ADMIN']}
      width="wide"
      title="Dars hisoboti"
      subtitle="Davomat, quiz natijalari va diqqat statistikasi"
      actions={
        <Button asChild variant="ghost" size="sm">
          <Link href="/teacher">
            <ArrowLeft aria-hidden />
            Bosh sahifa
          </Link>
        </Button>
      }
    >
      <SessionReport pin={pinFromUrl} />
    </AppShell>
  );
}

function SessionReport({ pin }: { pin: string }) {
  const router = useRouter();
  const [pinInput, setPinInput] = React.useState(pin);

  // 6 xonali bo'lmasa so'rov yuborilmaydi — zaxira sifatida PIN kiritish formasi chiqadi.
  const validPin = /^\d{6}$/.test(pin);

  const reportQuery = useQuery({
    queryKey: queryKeys.roomReport(pin),
    queryFn: () => getRoomReport(pin),
    enabled: validPin,
  });

  const openPin = (): void => {
    const next = pinInput.trim();
    if (/^\d{6}$/.test(next)) router.push(`/teacher/sessions/${next}/report`);
  };

  if (!validPin) {
    return (
      <div className="flex flex-col gap-4">
        <EmptyState
          title="Dars PIN i kerak"
          description="Hisobot dars PIN i bo’yicha ochiladi (6 xonali). PIN ni kiritib hisobotni yuklang."
          icon={<Search aria-hidden />}
        />
        <form
          className="mx-auto flex w-full max-w-sm items-end gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            openPin();
          }}
        >
          <div className="flex flex-1 flex-col gap-1.5">
            <Label htmlFor="report-pin" required>
              Dars PIN i
            </Label>
            <Input
              id="report-pin"
              inputMode="numeric"
              maxLength={6}
              value={pinInput}
              onChange={(event) => setPinInput(event.target.value.replace(/\D/g, ''))}
              placeholder="123456"
              className="font-mono tracking-widest"
            />
          </div>
          <Button type="submit" disabled={!/^\d{6}$/.test(pinInput.trim())}>
            Ochish
          </Button>
        </form>
      </div>
    );
  }

  if (reportQuery.isPending) return <LoadingState label="Hisobot yuklanmoqda…" />;
  if (reportQuery.isError) {
    return <ErrorState error={reportQuery.error} onRetry={() => void reportQuery.refetch()} />;
  }

  const report = reportQuery.data;
  const students = report.students;

  // ⚠️ Sanoqlar KLIENTDA hisoblanmaydi: `ABSENT` darsni yakunlash paytida
  // reconciliation bilan qo'yiladi (AUDIT §D3), shuning uchun yagona haqiqat
  // manbasi — serverning `present_count` / `late_count` / `absent_count` i.
  const quizTotal = students.reduce((sum, row) => sum + row.quiz_score, 0);
  const quizAverage = students.length > 0 ? Math.round(quizTotal / students.length) : 0;
  const quizBest = students.reduce((max, row) => Math.max(max, row.quiz_score), 0);

  return (
    <div className="flex flex-col gap-5">
      <section className="flex flex-wrap items-center gap-3 rounded-2xl border border-border bg-surface p-4">
        <div className="min-w-0 flex-1">
          <h2 className="flex items-center gap-2 text-lg font-semibold text-fg">
            <Users className="size-4 shrink-0 text-primary" aria-hidden />
            {report.group_name}
          </h2>
          <p className="text-sm text-muted">
            PIN <span className="font-mono font-semibold text-fg">{report.pin_code}</span> ·
            boshlandi {formatDateTime(report.started_at)}
            {report.ended_at === null ? '' : ` · tugadi ${formatDateTime(report.ended_at)}`}
          </p>
        </div>
        <Badge variant={report.status === 'ENDED' ? 'outline' : 'primary'}>
          {SESSION_STATUS_LABELS[report.status]}
        </Badge>
      </section>

      <section className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Tile label="Keldi" value={report.present_count} tone="success" />
        <Tile label="Kechikdi" value={report.late_count} tone="accent" />
        <Tile label="Kelmadi" value={report.absent_count} tone="danger" />
        <Tile
          label="O’rtacha XP"
          value={quizAverage}
          tone="primary"
          hint={`Eng yuqori: ${quizBest}`}
        />
      </section>

      {students.length === 0 ? (
        <EmptyState title="Davomat yozuvi yo’q" description="Bu darsga hech kim qo’shilmagan." />
      ) : (
        <>
          <section className="flex flex-col gap-2">
            <h3 className="flex items-center gap-2 text-sm font-semibold text-fg">
              <Trophy className="size-4 text-accent" aria-hidden />
              Davomat va quiz natijalari
            </h3>
            <AttendanceTable rows={students} quizBest={quizBest} />
          </section>

          <QuizStatsSection quizzes={report.quizzes} />

          <section className="flex flex-col gap-2">
            <h3 className="flex items-center gap-2 text-sm font-semibold text-fg">
              <Eye className="size-4 text-muted" aria-hidden />
              Diqqat statistikasi
              <Badge variant="outline">{FOCUS_DISCLAIMER}</Badge>
            </h3>

            <p className="flex items-start gap-2 rounded-xl border border-border bg-surface-2 p-3 text-xs text-muted">
              <Info className="mt-0.5 size-3.5 shrink-0" aria-hidden />
              <span>
                <span className="font-medium text-fg">{FOCUS_DISCLAIMER}</span> Tab almashinuvi
                ikkinchi monitorni, yonma-yon oynani yoki telefonga qarashni ko’rmaydi — ya’ni bu
                o’lchov to’liq emas (AUDIT §F). O’quvchilar bu ko’rsatkich o’qituvchiga
                ko’rinishini biladi; ma’lumot 30 kundan keyin o’chiriladi.
              </span>
            </p>

            <FocusTable rows={students} />
          </section>
        </>
      )}
    </div>
  );
}

function Tile({
  label,
  value,
  tone,
  hint,
}: {
  label: string;
  value: number;
  tone: 'success' | 'accent' | 'danger' | 'primary';
  hint?: string;
}) {
  const toneClass: Record<'success' | 'accent' | 'danger' | 'primary', string> = {
    success: 'text-success',
    accent: 'text-accent',
    danger: 'text-danger',
    primary: 'text-primary',
  };
  return (
    <div className="flex flex-col gap-0.5 rounded-2xl border border-border bg-surface p-3">
      <p className="text-xs text-muted">{label}</p>
      <p className={cn('text-2xl font-bold tabular-nums', toneClass[tone])}>{value}</p>
      {hint ? <p className="text-[11px] text-muted">{hint}</p> : null}
    </div>
  );
}

/* --------------------------- davomat + quiz ball -------------------------- */

function AttendanceTable({ rows, quizBest }: { rows: RoomReportRow[]; quizBest: number }) {
  const sorted = [...rows].sort((a, b) => b.quiz_score - a.quiz_score);

  return (
    <div className="overflow-x-auto rounded-2xl border border-border bg-surface scrollbar-thin">
      <table className="w-full min-w-[38rem] border-collapse text-sm">
        <caption className="sr-only">Davomat va quiz natijalari</caption>
        <thead>
          <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-muted">
            <th scope="col" className="px-3 py-2 font-semibold">
              O’quvchi
            </th>
            <th scope="col" className="px-3 py-2 font-semibold">
              Davomat
            </th>
            <th scope="col" className="px-3 py-2 font-semibold">
              Qo’shildi
            </th>
            <th scope="col" className="px-3 py-2 font-semibold">
              To’g’ri javob
            </th>
            <th scope="col" className="px-3 py-2 font-semibold">
              Quiz XP
            </th>
          </tr>
        </thead>
        <tbody>
          {sorted.map((row) => (
            <tr key={row.student_id} className="border-b border-border last:border-b-0">
              <td className="px-3 py-2">
                <span className="flex items-center gap-2">
                  {/* Hisobotda `avatar_url` yo'q — initsiallar ko'rsatiladi. */}
                  <UserAvatar fullName={row.full_name} className="size-7 shrink-0" />
                  <span className="truncate font-medium text-fg">{row.full_name}</span>
                </span>
              </td>
              <td className="px-3 py-2">
                <Badge variant={STATUS_BADGE[row.status]}>
                  {ATTENDANCE_STATUS_LABELS[row.status]}
                </Badge>
              </td>
              <td className="px-3 py-2 text-muted">
                {row.joined_at === null ? '—' : formatDateTime(row.joined_at)}
              </td>
              <td className="px-3 py-2">
                {row.answers_count === 0 ? (
                  <span className="text-muted">javob bermadi</span>
                ) : (
                  <span className="flex items-center gap-1.5">
                    <span className="font-semibold tabular-nums text-fg">
                      {row.correct_count}/{row.answers_count}
                    </span>
                    <span className="text-xs text-muted">
                      {Math.round((row.correct_count / row.answers_count) * 100)}%
                    </span>
                  </span>
                )}
              </td>
              <td className="px-3 py-2">
                <span className="flex items-center gap-2">
                  <Progress
                    value={quizBest > 0 ? (row.quiz_score / quizBest) * 100 : 0}
                    tone="accent"
                    className="h-1.5 w-20"
                    aria-label={`${row.full_name} quiz natijasi`}
                  />
                  <span className="w-12 text-right font-semibold tabular-nums text-fg">
                    {formatNumber(row.quiz_score)}
                  </span>
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/* ---------------------------- quiz statistikasi --------------------------- */

/**
 * `report.quizzes` — `quiz_answers` jadvalidan hisoblangan HAQIQIY ma'lumot
 * (CONTRACTS.md §12.2: confused tarixi saqlanmaydi, quiz javoblari saqlanadi).
 * `distribution` indekslari slaydning `options` tartibiga mos.
 */
function QuizStatsSection({ quizzes }: { quizzes: RoomQuizStat[] }) {
  if (quizzes.length === 0) {
    return (
      <section className="flex flex-col gap-2">
        <h3 className="flex items-center gap-2 text-sm font-semibold text-fg">
          <ListChecks className="size-4 text-success" aria-hidden />
          Quiz statistikasi
        </h3>
        <p className="rounded-xl border border-dashed border-border bg-surface/60 p-3 text-sm text-muted">
          Bu darsda quiz o’tkazilmagan.
        </p>
      </section>
    );
  }

  const sorted = [...quizzes].sort((a, b) => a.slide_index - b.slide_index);

  return (
    <section className="flex flex-col gap-2">
      <h3 className="flex items-center gap-2 text-sm font-semibold text-fg">
        <ListChecks className="size-4 text-success" aria-hidden />
        Quiz statistikasi · {quizzes.length} ta savol
      </h3>

      <ul className="grid gap-3 md:grid-cols-2">
        {sorted.map((quiz) => {
          const accuracy = quiz.answered > 0 ? Math.round((quiz.correct / quiz.answered) * 100) : 0;
          const maxCount = quiz.distribution.reduce((max, count) => Math.max(max, count), 0);
          const weak = quiz.answered > 0 && accuracy < 50;

          return (
            <li
              key={quiz.slide_index}
              className="flex flex-col gap-2 rounded-2xl border border-border bg-surface p-3"
            >
              <div className="flex flex-wrap items-center gap-2">
                <Badge variant="outline">{quiz.slide_index + 1}-slayd</Badge>
                <Badge variant={weak ? 'danger' : accuracy >= 80 ? 'success' : 'accent'}>
                  {accuracy}% to’g’ri
                </Badge>
                <span className="text-xs text-muted">
                  {quiz.correct}/{quiz.answered} javob · o’rtacha {formatMs(quiz.avg_answer_ms)}
                </span>
              </div>

              {quiz.answered === 0 ? (
                <p className="text-xs text-muted">Bu savolga hech kim javob bermagan.</p>
              ) : (
                <ul className="flex flex-col gap-1">
                  {quiz.distribution.map((count, index) => (
                    <li key={`option-${index}`} className="flex items-center gap-2">
                      <span className="w-4 shrink-0 text-xs font-semibold text-muted">
                        {optionLabel(index)}
                      </span>
                      <Progress
                        value={maxCount > 0 ? (count / maxCount) * 100 : 0}
                        tone="primary"
                        className="h-1.5 flex-1"
                        aria-label={`${optionLabel(index)} variant: ${count} javob`}
                      />
                      <span className="w-8 shrink-0 text-right text-xs tabular-nums text-fg">
                        {count}
                      </span>
                    </li>
                  ))}
                </ul>
              )}

              {weak ? (
                <p className="text-xs text-danger">
                  Yarmidan ko’pi xato javob berdi — bu mavzuni qayta tushuntirish tavsiya etiladi.
                </p>
              ) : null}
            </li>
          );
        })}
      </ul>

      <p className="text-xs text-muted">
        Variantlar harflar bilan belgilangan (A, B, C…) — matnlari prezentatsiyaning o’sha
        slaydida. XP serverda hisoblanadi (CONTRACTS §6).
      </p>
    </section>
  );
}

/* --------------------------- diqqat statistikasi -------------------------- */

function FocusTable({ rows }: { rows: RoomReportRow[] }) {
  const sorted = [...rows]
    .filter((row) => row.status !== 'ABSENT')
    .sort((a, b) => b.tab_switches_count - a.tab_switches_count);

  if (sorted.length === 0) {
    return <p className="text-sm text-muted">Diqqat ma’lumoti yo’q.</p>;
  }

  return (
    <div className="overflow-x-auto rounded-2xl border border-border bg-surface scrollbar-thin">
      <table className="w-full min-w-[28rem] border-collapse text-sm">
        <caption className="sr-only">Diqqat statistikasi — tavsiya xarakterida</caption>
        <thead>
          <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-muted">
            <th scope="col" className="px-3 py-2 font-semibold">
              O’quvchi
            </th>
            <th scope="col" className="px-3 py-2 font-semibold">
              Tab almashinuvi
            </th>
            <th scope="col" className="px-3 py-2 font-semibold">
              Chalg’igan vaqt
            </th>
          </tr>
        </thead>
        <tbody>
          {sorted.map((row) => (
            <tr key={row.student_id} className="border-b border-border last:border-b-0">
              <td className="truncate px-3 py-2 font-medium text-fg">{row.full_name}</td>
              <td className="px-3 py-2 tabular-nums text-fg">{row.tab_switches_count}</td>
              <td className="px-3 py-2 text-muted">{formatSeconds(row.focus_lost_seconds)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="border-t border-border px-3 py-2 text-xs text-muted">
        {FOCUS_DISCLAIMER} Bu ustunlar baho hisobiga kirmaydi.
      </p>
    </div>
  );
}
