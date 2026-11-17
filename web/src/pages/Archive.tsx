import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { RotateCcw, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Confirm, Empty, ErrorBox, PageHeader, Skeleton } from '../components/ui';
import { api, errorText, get, SessionRow } from '../lib/api';
import { int, relative, uiDate } from '../lib/format';
import { useI18n } from '../lib/i18n';

export default function Archive() {
  const { t } = useI18n();
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ['archive'],
    queryFn: () => get<{ total: number; sessions: SessionRow[]; keep_days: number }>('/api/sessions', { archived: 1, from: '2000-01-01', to: '2100-01-01', limit: 200 }),
  });
  const [restore, setRestore] = useState<SessionRow | null>(null);
  const [purge, setPurge] = useState<SessionRow | null>(null);
  const restoreM = useMutation({
    mutationFn: (id: number) => api('POST', `/api/sessions/${id}/restore`),
    onSuccess: () => {
      setRestore(null);
      qc.invalidateQueries({ queryKey: ['archive'] });
      qc.invalidateQueries({ queryKey: ['sessions'] });
    },
  });
  const purgeM = useMutation({
    mutationFn: (id: number) => api('DELETE', `/api/sessions/${id}?now=1`),
    onSuccess: () => {
      setPurge(null);
      qc.invalidateQueries({ queryKey: ['archive'] });
    },
  });
  const keep = q.data?.keep_days ?? 5;
  const rows = q.data?.sessions ?? [];

  return (
    <>
      <PageHeader
        title={t('آرشیو حذف‌شده', 'Deleted archive')}
        subtitle={t(
          `گفتگوهایی که با رمز سوپر پنهان شده‌اند. تا ${int(keep)} روز قابل بازیابی‌اند؛ بعد برای همیشه پاک می‌شوند. با رمز عادی دیده نمی‌شوند.`,
          `Conversations hidden with the super password. Restorable for ${int(keep)} days, then deleted for good. The admin password cannot see them.`,
        )}
      />
      {q.isLoading ? (
        <div className="card p-4 flex flex-col gap-2">
          {Array.from({ length: 6 }, (_, i) => (
            <Skeleton key={i} className="h-12" />
          ))}
        </div>
      ) : q.error ? (
        <ErrorBox error={q.error} retry={() => q.refetch()} />
      ) : !rows.length ? (
        <Empty title={t('آرشیو خالی است', 'The archive is empty')} hint={t('از صفحه گفتگو، حذف فقط با رمز سوپر انجام می‌شود.', 'Delete from a conversation page. Only the super password can do that.')} />
      ) : (
        <ul className="card m-0 p-0 list-none overflow-hidden">
          {rows.map((s) => (
            <li key={s.id} className="flex items-center gap-3 flex-wrap px-4 py-3 border-b border-line last:border-b-0">
              <div className="min-w-0 grow">
                <Link to={`/sessions/${s.id}`} className="font-bold text-ink no-underline hover:text-accent">
                  {s.title || t('(بدون عنوان)', '(Untitled)')}
                </Link>
                <div className="text-[12px] text-ink-3 mt-0.5">
                  <span className="ltr">{s.machine_user || s.user_name}</span>
                  {' · '}
                  {s.source}
                  {' · '}
                  {t('حذف', 'Deleted')} {relative(s.deleted_at ?? null)}
                  {s.purge_at && (
                    <>
                      {' · '}
                      <span className="text-warn">{t('حذف کامل', 'Permanently deleted')} {relative(s.purge_at)}</span>
                    </>
                  )}
                </div>
              </div>
              <span className="text-[12px] text-ink-3 num hidden sm:inline">{uiDate(s.last_at)}</span>
              <button className="btn btn-sm" onClick={() => setRestore(s)}>
                <RotateCcw size={13} /> {t('بازیابی', 'Restore')}
              </button>
              <button className="btn btn-ghost btn-sm text-bad" onClick={() => setPurge(s)}>
                <Trash2 size={13} /> {t('حذف همیشگی', 'Delete permanently')}
              </button>
            </li>
          ))}
        </ul>
      )}
      <Confirm
        open={!!restore}
        title={t('بازیابی گفتگو', 'Restore conversation')}
        body={t('دوباره در فهرست گفتگوها دیده می‌شود.', 'It will show up in Conversations again.')}
        confirmLabel={t('بازیابی', 'Restore')}
        onConfirm={() => restore && restoreM.mutate(restore.id)}
        onClose={() => setRestore(null)}
        busy={restoreM.isPending}
      />
      <Confirm
        open={!!purge}
        title={t('حذف همیشگی', 'Delete permanently')}
        body={t('متن گفتگو از داشبورد پاک می‌شود و برنمی‌گردد. آمار توکن می‌ماند.', 'The conversation text is erased from the dashboard and cannot be restored. Token stats stay.')}
        confirmLabel={t('حذف همیشگی', 'Delete permanently')}
        onConfirm={() => purge && purgeM.mutate(purge.id)}
        onClose={() => setPurge(null)}
        busy={purgeM.isPending}
      />
      {restoreM.error && <p className="text-bad text-[12.5px]">{errorText(restoreM.error)}</p>}
      {purgeM.error && <p className="text-bad text-[12.5px]">{errorText(purgeM.error)}</p>}
    </>
  );
}
