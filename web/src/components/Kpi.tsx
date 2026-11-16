import { ReactNode } from 'react';
import { compact, int } from '../lib/format';
import { Skeleton } from './ui';

export function KpiTile({ label, value, sub, icon, loading }: { label: string; value: number | null | undefined; sub?: ReactNode; icon?: ReactNode; loading?: boolean }) {
  return (
    <div className="card px-4 py-3.5 min-w-0">
      <div className="flex items-center gap-1.5 text-[12px] text-ink-3 font-medium">
        {icon}
        {label}
      </div>
      {loading ? (
        <Skeleton className="h-8 w-24 mt-1.5" />
      ) : (
        <div className="num text-[26px] font-bold leading-tight mt-1 tracking-tight text-start" title={int(value)}>
          {compact(value)}
        </div>
      )}
      {sub && <div className="text-[11.5px] text-ink-3 mt-0.5 truncate">{sub}</div>}
    </div>
  );
}
