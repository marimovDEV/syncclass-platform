'use client';

import * as React from 'react';
import { useParams } from 'next/navigation';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Code2, FileUp, History } from 'lucide-react';

import type { SubmissionOut, SubmissionWithStudent } from '@/types/api';
import { isApiError } from '@/lib/api';
import { useSession } from '@/lib/auth';
import { errorText, formatDateTime } from '@/lib/format';
import { queryKeys } from '@/lib/query';
import {
  getHomework,
  getHomeworkSubmissions,
  submitHomeworkCode,
  submitHomeworkFile,
} from '@/lib/resources';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { toast } from '@/components/ui/toast';
import { AppShell } from '@/components/shared/AppShell';
import { CountdownBadge } from '@/components/shared/CountdownBadge';
import { EmptyState, ErrorState, LoadingState } from '@/components/shared/states';
import { CodeSubmitEditor } from '@/app/(student)/homeworks/[id]/CodeSubmitEditor';
import { SubmissionList } from '@/app/(student)/homeworks/[id]/SubmissionList';
import { UploadDropzone } from '@/app/(student)/homeworks/[id]/UploadDropzone';

export default function StudentHomeworkDetailPage() {
  const params = useParams<{ id: string }>();
  const homeworkId = typeof params.id === 'string' ? params.id : '';

  return (
    <AppShell allowRoles={['STUDENT']} title="Vazifa" width="wide">
      {homeworkId.length === 0 ? (
        <ErrorState title="Vazifa topilmadi" description="Manzil noto’g’ri." />
      ) : (
        <HomeworkDetail homeworkId={homeworkId} />
      )}
    </AppShell>
  );
}

function HomeworkDetail({ homeworkId }: { homeworkId: string }) {
  const queryClient = useQueryClient();
  const { user } = useSession();
  const [uploadProgress, setUploadProgress] = React.useState<number | null>(null);

  const homeworkQuery = useQuery({
    queryKey: queryKeys.homework(homeworkId),
    queryFn: () => getHomework(homeworkId),
  });

  /**
   * Yuborilgan ishlar TARIXI — shuning uchun `only_latest: false`
   * (default `true` bo'lsa faqat oxirgi urinish qaytadi, `attempt_no` tarixi ko'rinmaydi).
   *
   * Kalitga `{only_latest:false}` qo'shilgan: `queryKeys.homeworkSubmissions(id)` bilan
   * prefiks bo'yicha invalidatsiya baribir ishlaydi, lekin kesh o'qituvchi
   * ro'yxati bilan aralashmaydi.
   */
  const submissionsQuery = useQuery({
    queryKey: [...queryKeys.homeworkSubmissions(homeworkId), { only_latest: false }],
    queryFn: () => getHomeworkSubmissions(homeworkId, { only_latest: false }),
    retry: false,
  });

  const mySubmissions: SubmissionWithStudent[] = React.useMemo(() => {
    const rows = submissionsQuery.data ?? [];
    if (!user) return [];
    return rows.filter((row) => row.student_id === user.id);
  }, [submissionsQuery.data, user]);

  const onSubmitted = React.useCallback(
    (submission: SubmissionOut) => {
      setUploadProgress(null);
      queryClient.setQueryData(queryKeys.submission(submission.id), submission);
      void queryClient.invalidateQueries({
        queryKey: queryKeys.homeworkSubmissions(homeworkId),
      });
      toast.success('Vazifa topshirildi', {
        description: 'AI tekshiruvi tugagach natija shu sahifada ko’rinadi.',
      });
    },
    [queryClient, homeworkId],
  );

  const onSubmitError = React.useCallback((error: unknown) => {
    setUploadProgress(null);
    toast.error('Topshirilmadi', {
      description: isApiError(error) ? errorText(error.code, error.message) : 'Qayta urinib ko’ring.',
    });
  }, []);

  const fileMutation = useMutation({
    mutationFn: (file: File) =>
      submitHomeworkFile(homeworkId, file, { onProgress: setUploadProgress }),
    onSuccess: onSubmitted,
    onError: onSubmitError,
  });

  const codeMutation = useMutation({
    mutationFn: (payload: { code: string; file_name: string }) =>
      submitHomeworkCode(homeworkId, payload),
    onSuccess: onSubmitted,
    onError: onSubmitError,
  });

  if (homeworkQuery.isPending) return <LoadingState variant="skeleton" rows={3} />;
  if (homeworkQuery.isError) {
    return <ErrorState error={homeworkQuery.error} onRetry={() => void homeworkQuery.refetch()} />;
  }

  const homework = homeworkQuery.data;
  const expired = new Date(homework.deadline).getTime() <= Date.now();
  const hasSubmission = mySubmissions.length > 0;
  const latest = mySubmissions.find((submission) => submission.is_latest) ?? mySubmissions[0];
  const resubmitBlocked =
    hasSubmission && !homework.allow_resubmit && latest?.status !== 'RESUBMIT_REQUIRED';
  const submitDisabled = expired || resubmitBlocked;

  const fileError = fileMutation.error;
  const codeError = codeMutation.error;

  return (
    <div className="flex flex-col gap-6">
      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div className="min-w-0">
              <CardTitle className="text-lg">{homework.title}</CardTitle>
              <CardDescription>
                Muddat: {formatDateTime(homework.deadline)} · {homework.max_score} ball
              </CardDescription>
            </div>
            <CountdownBadge deadline={homework.deadline} tickMs={1000} />
          </div>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <p className="whitespace-pre-line text-sm text-fg">{homework.description}</p>
          <div className="flex flex-wrap gap-1.5">
            {homework.allow_resubmit ? (
              <Badge variant="primary">Qayta topshirish mumkin</Badge>
            ) : (
              <Badge variant="outline">Bir marta topshiriladi</Badge>
            )}
            {homework.ai_penalty_points > 0 ? (
              <Badge variant="accent">AI jarimasi: −{homework.ai_penalty_points} (o’qituvchi qaroriga ko’ra)</Badge>
            ) : null}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Topshirish</CardTitle>
          <CardDescription>
            Fayl yuklang yoki kodni shu yerda yozib yuboring.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {expired ? (
            <EmptyState
              title="Topshirish muddati o’tdi"
              description="Yangi urinish qabul qilinmaydi. O’qituvchi bilan bog’laning."
            />
          ) : resubmitBlocked ? (
            <EmptyState
              title="Vazifa topshirilgan"
              description="Bu vazifa qayta topshirishga ruxsat bermaydi."
            />
          ) : (
            <Tabs defaultValue="file">
              <TabsList>
                <TabsTrigger value="file">
                  <FileUp aria-hidden />
                  Fayl
                </TabsTrigger>
                <TabsTrigger value="code">
                  <Code2 aria-hidden />
                  Kod muharriri
                </TabsTrigger>
              </TabsList>

              <TabsContent value="file">
                <UploadDropzone
                  onSubmit={(file) => {
                    setUploadProgress(0);
                    fileMutation.mutate(file);
                  }}
                  progress={fileMutation.isPending ? (uploadProgress ?? 0) : null}
                  disabled={submitDisabled}
                  error={
                    fileError
                      ? isApiError(fileError)
                        ? errorText(fileError.code, fileError.message)
                        : 'Yuklash amalga oshmadi.'
                      : null
                  }
                />
              </TabsContent>

              <TabsContent value="code">
                <CodeSubmitEditor
                  onSubmit={(payload) => codeMutation.mutate(payload)}
                  pending={codeMutation.isPending}
                  disabled={submitDisabled}
                  error={
                    codeError
                      ? isApiError(codeError)
                        ? errorText(codeError.code, codeError.message)
                        : 'Yuborilmadi.'
                      : null
                  }
                />
              </TabsContent>
            </Tabs>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <History className="size-4 text-muted" aria-hidden />
            Yuborilgan ishlar
          </CardTitle>
          <CardDescription>Baho, o’qituvchi izohi va AI xulosasi</CardDescription>
        </CardHeader>
        <CardContent>
          {submissionsQuery.isPending ? (
            <LoadingState variant="skeleton" rows={2} />
          ) : submissionsQuery.isError ? (
            <EmptyState
              title="Tarixni ko’rsatib bo’lmadi"
              description={
                isApiError(submissionsQuery.error) && submissionsQuery.error.status === 403
                  ? 'Server bu ro’yxatni o’quvchiga bermayapti. Natija tayyor bo’lgach o’qituvchi xabar beradi.'
                  : isApiError(submissionsQuery.error)
                    ? errorText(submissionsQuery.error.code, submissionsQuery.error.message)
                    : 'Noma’lum xato.'
              }
            />
          ) : mySubmissions.length === 0 ? (
            <EmptyState
              title="Hali topshirmagansiz"
              description="Yuqoridagi maydon orqali ishingizni yuboring."
            />
          ) : (
            <SubmissionList submissions={mySubmissions} maxScore={homework.max_score} />
          )}
        </CardContent>
      </Card>
    </div>
  );
}
