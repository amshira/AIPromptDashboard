import * as Dialog from '@radix-ui/react-dialog';
import * as SwitchP from '@radix-ui/react-switch';
import clsx from 'clsx';
import { AlertTriangle, Check, Inbox, Loader2, X } from 'lucide-react';
import { createContext, ReactNode, useCallback, useContext, useState } from 'react';
import { errorText } from '../lib/api';
import { useI18n } from '../lib/i18n';

export const cx = clsx;

export function Spinner({ size = 16 }: { size?: number }) {
  return <Loader2 size={size} className="spin" aria-hidden />;
}

export function Skeleton({ className }: { className?: string }) {
  return <div className={cx('skel', className)} aria-hidden />;
}

export function PageHeader({ title, subtitle, actions }: { title: string; subtitle?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-3 mb-5">
      <div className="min-w-0">
        <h1 className="m-0 text-[22px] font-extrabold leading-tight tracking-tight">{title}</h1>
        {subtitle && <p className="m-0 mt-1 text-ink-3 text-[13px]">{subtitle}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

export function Empty({ title, hint, action }: { title: string; hint?: string; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center text-center gap-2 py-14 px-6 text-ink-3">
      <div className="size-12 rounded-2xl bg-surface-2 grid place-items-center">
        <Inbox size={22} />
      </div>
      <div className="font-semibold text-ink-2">{title}</div>
      {hint && <div className="text-[13px] max-w-md">{hint}</div>}
      {action}
    </div>
  );
}

export function ErrorBox({ error, retry }: { error: unknown; retry?: () => void }) {
  const { t } = useI18n();
  return (
    <div role="alert" className="flex items-center gap-3 rounded-xl border border-bad/30 bg-bad-soft text-bad px-4 py-3 text-[13px]">
      <AlertTriangle size={18} className="shrink-0" />
      <span className="grow">{errorText(error)}</span>
      {retry && (
        <button className="btn btn-sm" onClick={retry}>
          {t('تلاش دوباره', 'Try again')}
        </button>
      )}
    </div>
  );
}

export function Switch({ checked, onChange, label, disabled }: { checked: boolean; onChange: (v: boolean) => void; label: string; disabled?: boolean }) {
  return (
    <SwitchP.Root
      checked={checked}
      onCheckedChange={onChange}
      disabled={disabled}
      aria-label={label}
      className="relative h-[22px] w-[40px] shrink-0 rounded-full border border-line-strong bg-surface-3 transition-colors data-[state=checked]:bg-accent data-[state=checked]:border-accent disabled:opacity-50 cursor-pointer"
    >
      <SwitchP.Thumb className="block size-4 rounded-full bg-white shadow transition-transform translate-x-[-3px] data-[state=checked]:translate-x-[-21px] [direction:ltr]" style={{ marginInlineStart: 0 }} />
    </SwitchP.Root>
  );
}

export function Modal({ open, onClose, title, children, width = 520 }: { open: boolean; onClose: () => void; title: string; children: ReactNode; width?: number }) {
  const { t } = useI18n();
  return (
    <Dialog.Root open={open} onOpenChange={(o) => !o && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/45 backdrop-blur-[2px]" />
        <Dialog.Content
          aria-describedby={undefined}
          style={{ maxWidth: width }}
          className="pop fixed z-50 top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[calc(100vw-24px)] max-h-[90vh] overflow-auto card p-5"
        >
          <div className="flex items-start justify-between gap-3 mb-4">
            <Dialog.Title className="m-0 text-[17px] font-bold">{title}</Dialog.Title>
            <Dialog.Close className="btn btn-ghost btn-icon btn-sm" aria-label={t('بستن', 'Close')}>
              <X size={16} />
            </Dialog.Close>
          </div>
          {children}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

export function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div>
      <label className="label">{label}</label>
      {children}
      {hint && <div className="mt-1 text-[12px] text-ink-3">{hint}</div>}
    </div>
  );
}

export function Segmented<T extends string | number>({ value, onChange, options, label }: { value: T; onChange: (v: T) => void; options: { v: T; l: string }[]; label: string }) {
  return (
    <div role="radiogroup" aria-label={label} className="inline-flex p-[3px] rounded-[11px] bg-surface-2 border border-line">
      {options.map((o) => (
        <button
          key={String(o.v)}
          role="radio"
          aria-checked={o.v === value}
          onClick={() => onChange(o.v)}
          className={cx(
            'h-[28px] px-3 rounded-lg text-[12.5px] font-medium cursor-pointer border-0 transition-colors',
            o.v === value ? 'bg-surface text-ink shadow-[0_1px_2px_rgb(0_0_0/0.12)]' : 'bg-transparent text-ink-3 hover:text-ink',
          )}
        >
          {o.l}
        </button>
      ))}
    </div>
  );
}

// ---------- toasts ----------
interface Toast {
  id: number;
  kind: 'ok' | 'err';
  text: string;
}
const ToastCtx = createContext<(kind: Toast['kind'], text: string) => void>(() => undefined);
export const useToast = () => useContext(ToastCtx);

export function ToastHost({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<Toast[]>([]);
  const push = useCallback((kind: Toast['kind'], text: string) => {
    const id = Date.now() + Math.random();
    setItems((x) => [...x, { id, kind, text }]);
    setTimeout(() => setItems((x) => x.filter((t) => t.id !== id)), 4200);
  }, []);
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="fixed bottom-4 inset-x-0 z-[60] flex flex-col items-center gap-2 pointer-events-none px-3" aria-live="polite">
        {items.map((t) => (
          <div key={t.id} className={cx('pop pointer-events-auto card flex items-center gap-2 px-4 py-2.5 text-[13px] font-medium', t.kind === 'err' ? 'text-bad' : 'text-ink')}>
            {t.kind === 'ok' ? <Check size={16} className="text-good" /> : <AlertTriangle size={16} />}
            {t.text}
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}

export function Confirm({ open, title, body, confirmLabel, onConfirm, onClose, busy }: { open: boolean; title: string; body: ReactNode; confirmLabel: string; onConfirm: () => void; onClose: () => void; busy?: boolean }) {
  const { t } = useI18n();
  return (
    <Modal open={open} onClose={onClose} title={title} width={440}>
      <div className="text-ink-2 text-[13.5px] mb-5">{body}</div>
      <div className="flex justify-start gap-2">
        <button className="btn btn-primary btn-danger" onClick={onConfirm} disabled={busy}>
          {busy && <Spinner size={14} />}
          {confirmLabel}
        </button>
        <button className="btn" onClick={onClose}>
          {t('انصراف', 'Cancel')}
        </button>
      </div>
    </Modal>
  );
}
