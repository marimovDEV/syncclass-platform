'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { AnimatePresence, motion } from 'framer-motion';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, ArrowRight, Check, KeyRound, Users } from 'lucide-react';

import type { GroupBrief, OnboardingIn, UserOut } from '@/types/api';
import { apiFetch, isApiError } from '@/lib/api';
import { homePathForRole } from '@/lib/auth';
import { errorText } from '@/lib/format';
import { queryKeys } from '@/lib/query';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { ErrorState } from '@/components/shared/states';
import { toast } from '@/components/ui/toast';

/** `GET /groups/open` — onboarding dropdown uchun ochiq guruhlar. */
function fetchOpenGroups(): Promise<GroupBrief[]> {
  return apiFetch<GroupBrief[]>('/groups/open');
}

/** `POST /auth/onboarding` → `UserOut`. ⚠️ `role` YUBORILMAYDI (§4). */
function submitOnboarding(body: OnboardingIn): Promise<UserOut> {
  return apiFetch<UserOut>('/auth/onboarding', { method: 'POST', body });
}

type JoinMode = 'group' | 'invite';

const STEP_TRANSITION = { duration: 0.2, ease: 'easeOut' } as const;

export interface OnboardingModalProps {
  /** Google dan kelgan ism (tahrirlanadi). */
  user: UserOut;
}

/**
 * Ikki qadamli onboarding:
 *   1-qadam — Ism / Familiya (Google'dan avto to'ldiriladi).
 *   2-qadam — guruh tanlash (`GET /groups/open`) YOKI invite-kod.
 */
export function OnboardingModal({ user }: OnboardingModalProps) {
  const router = useRouter();
  const queryClient = useQueryClient();

  const [step, setStep] = React.useState<1 | 2>(1);
  const [fullName, setFullName] = React.useState(user.full_name);
  const [mode, setMode] = React.useState<JoinMode>('group');
  const [groupId, setGroupId] = React.useState<string>('');
  const [inviteCode, setInviteCode] = React.useState('');
  const [nameError, setNameError] = React.useState<string | null>(null);

  const groupsQuery = useQuery({
    queryKey: queryKeys.openGroups,
    queryFn: fetchOpenGroups,
    enabled: step === 2 && mode === 'group',
  });

  const mutation = useMutation({
    mutationFn: submitOnboarding,
    onSuccess: (updated) => {
      queryClient.setQueryData(queryKeys.me, updated);
      toast.success('Xush kelibsiz!', { description: 'Profil to’ldirildi.' });
      router.replace(homePathForRole(updated.role));
    },
  });

  const trimmedName = fullName.trim();

  const goToStepTwo = (): void => {
    if (trimmedName.length < 3) {
      setNameError('Ism va familiyani to’liq kiriting (kamida 3 belgi).');
      return;
    }
    if (!trimmedName.includes(' ')) {
      setNameError('Ism va familiyani bo’sh joy bilan ajratib yozing.');
      return;
    }
    setNameError(null);
    setStep(2);
  };

  const canSubmit =
    mode === 'group' ? groupId.length > 0 : inviteCode.trim().length >= 4;

  const submit = (): void => {
    if (!canSubmit || mutation.isPending) return;
    const payload: OnboardingIn =
      mode === 'group'
        ? { full_name: trimmedName, group_id: Number(groupId) }
        : { full_name: trimmedName, invite_code: inviteCode.trim().toUpperCase() };
    mutation.mutate(payload);
  };

  const mutationError = mutation.error;

  return (
    <Dialog open>
      <DialogContent hideClose className="max-w-md" onInteractOutside={(e) => e.preventDefault()}>
        <DialogHeader>
          <div className="mb-1 flex items-center gap-1.5" aria-hidden>
            {([1, 2] as const).map((value) => (
              <span
                key={value}
                className={cn(
                  'h-1.5 flex-1 rounded-full transition-colors duration-200',
                  step >= value ? 'bg-primary' : 'bg-surface-2',
                )}
              />
            ))}
          </div>
          <DialogTitle>{step === 1 ? 'Ismingizni tasdiqlang' : 'Guruhga qo’shiling'}</DialogTitle>
          <DialogDescription>
            {step === 1
              ? 'Bu ism davomat va baholar ro’yxatida ko’rinadi.'
              : 'Ro’yxatdan guruhni tanlang yoki o’qituvchi bergan taklif kodini kiriting.'}
          </DialogDescription>
        </DialogHeader>

        <AnimatePresence mode="wait" initial={false}>
          {step === 1 ? (
            <motion.div
              key="step-1"
              initial={{ opacity: 0, x: 16 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: -16 }}
              transition={STEP_TRANSITION}
              className="flex flex-col gap-4"
            >
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="onboarding-full-name" required>
                  Ism va familiya
                </Label>
                <Input
                  id="onboarding-full-name"
                  value={fullName}
                  autoComplete="name"
                  autoFocus
                  invalid={nameError !== null}
                  placeholder="Ali Valiyev"
                  onChange={(event) => {
                    setFullName(event.target.value);
                    setNameError(null);
                  }}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') goToStepTwo();
                  }}
                />
                {nameError ? (
                  <p role="alert" className="text-xs text-danger">
                    {nameError}
                  </p>
                ) : (
                  <p className="text-xs text-muted">
                    Google akkauntingizdan olingan — kerak bo’lsa tahrirlang.
                  </p>
                )}
              </div>

              <Button block size="lg" onClick={goToStepTwo}>
                Davom etish
                <ArrowRight aria-hidden />
              </Button>
            </motion.div>
          ) : (
            <motion.div
              key="step-2"
              initial={{ opacity: 0, x: 16 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: -16 }}
              transition={STEP_TRANSITION}
              className="flex flex-col gap-4"
            >
              <div className="grid grid-cols-2 gap-2" role="tablist" aria-label="Qo’shilish usuli">
                <Button
                  role="tab"
                  aria-selected={mode === 'group'}
                  variant={mode === 'group' ? 'primary' : 'outline'}
                  onClick={() => setMode('group')}
                >
                  <Users aria-hidden />
                  Guruh ro’yxati
                </Button>
                <Button
                  role="tab"
                  aria-selected={mode === 'invite'}
                  variant={mode === 'invite' ? 'primary' : 'outline'}
                  onClick={() => setMode('invite')}
                >
                  <KeyRound aria-hidden />
                  Taklif kodi
                </Button>
              </div>

              {mode === 'group' ? (
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="onboarding-group" required>
                    Guruh
                  </Label>
                  {groupsQuery.isPending ? (
                    <Skeleton className="h-10 w-full" />
                  ) : groupsQuery.isError ? (
                    <ErrorState
                      className="px-4 py-6"
                      error={groupsQuery.error}
                      onRetry={() => void groupsQuery.refetch()}
                    />
                  ) : (groupsQuery.data ?? []).length === 0 ? (
                    <p className="rounded-xl border border-dashed border-border px-3 py-4 text-sm text-muted">
                      Hozircha ochiq guruh yo’q. O’qituvchidan taklif kodini so’rang.
                    </p>
                  ) : (
                    <Select value={groupId} onValueChange={setGroupId}>
                      <SelectTrigger id="onboarding-group">
                        <SelectValue placeholder="Guruhni tanlang" />
                      </SelectTrigger>
                      <SelectContent>
                        {(groupsQuery.data ?? []).map((group) => (
                          <SelectItem key={group.id} value={String(group.id)}>
                            {group.name} — {group.course_title}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  )}
                </div>
              ) : (
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="onboarding-invite" required>
                    Taklif kodi
                  </Label>
                  <Input
                    id="onboarding-invite"
                    value={inviteCode}
                    autoFocus
                    autoCapitalize="characters"
                    placeholder="P30-AB12"
                    className="font-mono uppercase tracking-wider"
                    onChange={(event) => setInviteCode(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') submit();
                    }}
                  />
                  <p className="text-xs text-muted">O’qituvchi bergan kodni kiriting.</p>
                </div>
              )}

              {mutationError ? (
                <p role="alert" className="text-sm text-danger">
                  {isApiError(mutationError)
                    ? errorText(mutationError.code, mutationError.message)
                    : 'Saqlanmadi. Qayta urinib ko’ring.'}
                </p>
              ) : null}

              <div className="flex gap-2">
                <Button variant="outline" onClick={() => setStep(1)} disabled={mutation.isPending}>
                  <ArrowLeft aria-hidden />
                  Orqaga
                </Button>
                <Button
                  className="flex-1"
                  disabled={!canSubmit}
                  loading={mutation.isPending}
                  onClick={submit}
                >
                  <Check aria-hidden />
                  Boshlash
                </Button>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </DialogContent>
    </Dialog>
  );
}
