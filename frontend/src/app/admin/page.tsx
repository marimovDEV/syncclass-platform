'use client';

/**
 * Adminka — foydalanuvchilar va rollar (faqat ADMIN).
 *
 * Google orqali kirgan har bir yangi hisob — STUDENT (AUDIT.md §C1).
 * O'qituvchi huquqini shu sahifadan ADMIN beradi. Rol o'zgarganda backend
 * `token_version` ni oshiradi — foydalanuvchi qayta kirishi kerak bo'ladi
 * (bu yerda ogohlantirib qo'yamiz).
 */

import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Dices, Eye, EyeOff, KeyRound, Search, ShieldCheck } from 'lucide-react';

import type { AdminUser, UserRole } from '@/types/api';
import { isApiError } from '@/lib/api';
import { useSession } from '@/lib/auth';
import { errorText, formatDateTime } from '@/lib/format';
import { queryKeys } from '@/lib/query';
import { listUsers, setUserPassword, setUserRole } from '@/lib/resources';
import { Button } from '@/components/ui/button';
import { AppShell } from '@/components/shared/AppShell';
import { EmptyState, ErrorState, LoadingState } from '@/components/shared/states';
import { UserAvatar } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { toast } from '@/components/ui/toast';

const ROLE_LABEL: Record<UserRole, string> = {
  STUDENT: "O'quvchi",
  TEACHER: "O'qituvchi",
  ADMIN: 'Administrator',
};

const ROLE_BADGE: Record<UserRole, 'neutral' | 'solid' | 'outline'> = {
  STUDENT: 'neutral',
  TEACHER: 'solid',
  ADMIN: 'outline',
};

export default function AdminPage() {
  return (
    <AppShell
      requireAuth
      allowRoles={['ADMIN']}
      title="Adminka"
      subtitle="Foydalanuvchilar va rollar"
    >
      <UsersPanel />
    </AppShell>
  );
}

function UsersPanel() {
  const { user: me } = useSession();
  const queryClient = useQueryClient();
  const [search, setSearch] = React.useState('');
  // Har bosishda so'rov ketmasin — 300 ms sukunatdan keyin qidiramiz.
  const [query, setQuery] = React.useState('');
  React.useEffect(() => {
    const id = setTimeout(() => setQuery(search), 300);
    return () => clearTimeout(id);
  }, [search]);

  const usersQuery = useQuery({
    queryKey: queryKeys.adminUsers(query),
    queryFn: () => listUsers(query),
    placeholderData: (previous) => previous,
  });

  const changePassword = useMutation({
    mutationFn: ({ id, password }: { id: string; password: string }) =>
      setUserPassword(id, password),
    onSuccess: (updated) => {
      void queryClient.invalidateQueries({ queryKey: ['admin', 'users'] });
      toast.success(`${updated.full_name} uchun yangi parol saqlandi`, {
        description: `Parol: ${updated.password_plain ?? ''} — o'quvchiga ayting.`,
      });
    },
    onError: (caught) => {
      toast.error("Parolni saqlab bo'lmadi", {
        description: isApiError(caught)
          ? errorText(caught.code, caught.message)
          : "Qayta urinib ko'ring.",
      });
    },
  });

  const changeRole = useMutation({
    mutationFn: ({ id, role }: { id: string; role: UserRole }) => setUserRole(id, role),
    onSuccess: (updated) => {
      void queryClient.invalidateQueries({ queryKey: ['admin', 'users'] });
      toast.success(`${updated.full_name} endi: ${ROLE_LABEL[updated.role]}`, {
        description: 'Eski tokenlari bekor qilindi — u qayta kirishi kerak.',
      });
    },
    onError: (caught) => {
      toast.error("Rolni o'zgartirib bo'lmadi", {
        description: isApiError(caught)
          ? errorText(caught.code, caught.message)
          : "Qayta urinib ko'ring.",
      });
    },
  });

  return (
    <div className="flex flex-col gap-4">
      <div className="relative max-w-sm">
        <Search
          className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted"
          aria-hidden
        />
        <Input
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder="Email yoki ism bo'yicha qidirish…"
          className="pl-9"
          aria-label="Foydalanuvchi qidirish"
        />
      </div>

      {usersQuery.isPending ? (
        <LoadingState variant="skeleton" rows={5} />
      ) : usersQuery.isError ? (
        <ErrorState error={usersQuery.error} onRetry={() => void usersQuery.refetch()} />
      ) : usersQuery.data.length === 0 ? (
        <EmptyState
          title="Hech kim topilmadi"
          description="Qidiruvni o'zgartirib ko'ring. Yangi foydalanuvchilar Google orqali kirganda shu yerda chiqadi."
          icon={<ShieldCheck aria-hidden />}
        />
      ) : (
        <ul className="flex flex-col gap-2">
          {usersQuery.data.map((user) => (
            <li key={user.id}>
              <UserRow
                user={user}
                isSelf={me?.id === user.id}
                saving={changeRole.isPending && changeRole.variables?.id === user.id}
                passwordSaving={
                  changePassword.isPending && changePassword.variables?.id === user.id
                }
                onRoleChange={(role) => changeRole.mutate({ id: user.id, role })}
                onPasswordSave={(password) => changePassword.mutate({ id: user.id, password })}
              />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Esda qoladigan tasodifiy parol: so'z + 2 xona raqam + so'z (masalan, "olma-42-kitob"). */
const PW_WORDS = [
  'olma', 'anor', 'uzum', 'kitob', 'daftar', 'qalam', 'quyosh', 'yulduz',
  'daryo', 'togʻ', 'bahor', 'lola', 'asal', 'chinor', 'kamalak', 'bulut',
];

function generatePassword(): string {
  const pick = () => PW_WORDS[Math.floor(Math.random() * PW_WORDS.length)];
  return `${pick()}-${10 + Math.floor(Math.random() * 90)}-${pick()}`;
}

function UserRow({
  user,
  isSelf,
  saving,
  passwordSaving,
  onRoleChange,
  onPasswordSave,
}: {
  user: AdminUser;
  isSelf: boolean;
  saving: boolean;
  passwordSaving: boolean;
  onRoleChange: (role: UserRole) => void;
  onPasswordSave: (password: string) => void;
}) {
  const [showPassword, setShowPassword] = React.useState(false);
  const [editing, setEditing] = React.useState(false);
  const [draft, setDraft] = React.useState('');

  const savePassword = () => {
    const value = draft.trim();
    if (value.length < 4) return;
    onPasswordSave(value);
    setEditing(false);
    setShowPassword(true);
  };

  return (
    <div className="flex flex-wrap items-center gap-3 rounded-xl border border-border bg-surface p-3">
      <UserAvatar fullName={user.full_name} avatarUrl={user.avatar_url} className="size-9" />

      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium text-fg">
          {user.full_name}
          {isSelf ? <span className="ml-1.5 text-xs text-muted">(siz)</span> : null}
        </p>
        <p className="truncate text-xs text-muted">{user.email}</p>
        <p className="mt-0.5 flex items-center gap-1.5 text-xs text-muted">
          <KeyRound className="size-3 shrink-0" aria-hidden />
          {user.password_plain ? (
            <>
              <span className="font-mono text-fg">
                {showPassword ? user.password_plain : '••••••••'}
              </span>
              <button
                type="button"
                className="text-muted hover:text-fg"
                onClick={() => setShowPassword((v) => !v)}
                aria-label={showPassword ? 'Parolni yashirish' : "Parolni ko'rsatish"}
              >
                {showPassword ? (
                  <EyeOff className="size-3.5" aria-hidden />
                ) : (
                  <Eye className="size-3.5" aria-hidden />
                )}
              </button>
            </>
          ) : (
            <span>parol qo’yilmagan (Google orqali kiradi)</span>
          )}
          <button
            type="button"
            className="text-primary hover:underline"
            onClick={() => {
              setEditing((v) => !v);
              setDraft('');
            }}
          >
            {user.password_plain ? 'almashtirish' : 'parol berish'}
          </button>
        </p>
        {editing ? (
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <Input
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              placeholder="Yangi parol (kamida 4 belgi)"
              className="h-8 w-56 text-sm"
              aria-label={`${user.full_name} uchun yangi parol`}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  savePassword();
                }
              }}
            />
            <Button
              size="sm"
              variant="outline"
              type="button"
              onClick={() => setDraft(generatePassword())}
            >
              <Dices className="size-3.5" aria-hidden />
              Tasodifiy
            </Button>
            <Button
              size="sm"
              type="button"
              loading={passwordSaving}
              disabled={draft.trim().length < 4}
              onClick={savePassword}
            >
              Saqlash
            </Button>
          </div>
        ) : null}
      </div>

      <Badge variant={ROLE_BADGE[user.role]} className="shrink-0">
        {ROLE_LABEL[user.role]}
      </Badge>

      <p className="hidden shrink-0 text-xs text-muted sm:block">
        {formatDateTime(user.created_at)}
      </p>

      {/* O'z rolini o'zgartirish backendda ham taqiqlangan (CANNOT_CHANGE_OWN_ROLE). */}
      <Select
        value={user.role}
        onValueChange={(value) => onRoleChange(value as UserRole)}
        disabled={isSelf || saving}
      >
        <SelectTrigger className="w-40 shrink-0" aria-label={`${user.full_name} roli`}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="STUDENT">{ROLE_LABEL.STUDENT}</SelectItem>
          <SelectItem value="TEACHER">{ROLE_LABEL.TEACHER}</SelectItem>
          <SelectItem value="ADMIN">{ROLE_LABEL.ADMIN}</SelectItem>
        </SelectContent>
      </Select>
    </div>
  );
}
