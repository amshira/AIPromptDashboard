import { useQueryClient } from '@tanstack/react-query';
import { Eye, EyeOff, LockKeyhole } from 'lucide-react';
import { FormEvent, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { cx, Spinner } from '../components/ui';
import { api, ApiError, errorText } from '../lib/api';
import { LangSwitch, useI18n } from '../lib/i18n';

export function Login() {
  const [pw, setPw] = useState('');
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [caps, setCaps] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const qc = useQueryClient();
  const nav = useNavigate();
  const [sp] = useSearchParams();
  const { t } = useI18n();

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!pw || busy) return;
    setBusy(true);
    setErr(null);
    try {
      const r = await api<{ ok: boolean; super?: boolean }>('POST', '/api/auth/login', { password: pw });
      qc.clear();
      qc.setQueryData(['me'], { authenticated: true, super: !!r.super });
      const next = sp.get('next');
      nav(next && next.startsWith('/') && !next.startsWith('//') ? next : '/', { replace: true });
    } catch (x) {
      let msg = errorText(x);
      if (x instanceof ApiError && x.code === 'bad_password') msg = t('رمز عبور نادرست است.', 'Wrong password.');
      setErr(msg);
      setPw('');
      // straight back to typing
      requestAnimationFrame(() => input.current?.focus());
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="min-h-full grid place-items-center px-4 py-10 bg-bg relative overflow-hidden">
      <div aria-hidden className="absolute inset-0 pointer-events-none opacity-60" style={{ background: 'radial-gradient(600px 300px at 80% -10%, var(--accent-soft), transparent 70%), radial-gradient(500px 300px at 10% 110%, var(--claude-soft), transparent 70%)' }} />
      <div className="absolute top-4 end-4">
        <LangSwitch />
      </div>
      <form onSubmit={submit} className="card pop relative w-full max-w-[380px] p-7">
        <div className="flex items-center gap-3 mb-6">
          <img src="/favicon.svg" alt="" className="size-10" />
          <div>
            <div className="font-extrabold text-[18px] leading-tight">{t('داشبورد پرامپت', 'Prompt Dashboard')}</div>
            <div className="text-ink-3 text-[12.5px]">{t('گفتگوها و مصرف توکن 9router', '9router conversations and token use')}</div>
          </div>
        </div>
        <label className="label" htmlFor="pw">
          {t('رمز عبور مدیر', 'Admin password')}
        </label>
        {/* one framed field: the text box and the eye button sit side by side, so they never overlap */}
        <div
          className={cx(
            'input !h-11 !p-0 flex items-center gap-1 pe-1.5 transition-shadow focus-within:border-accent focus-within:shadow-[0_0_0_3px_var(--accent-soft)] has-[input:focus-visible]:outline-2 has-[input:focus-visible]:outline-offset-2 has-[input:focus-visible]:outline-[var(--ring)]',
            err && '!border-bad',
          )}
        >
          <input
            id="pw"
            ref={input}
            className="grow min-w-0 h-full bg-transparent border-0 !outline-none ps-3 text-[14px] text-ink tracking-wide"
            type={show ? 'text' : 'password'}
            value={pw}
            onChange={(e) => (setPw(e.target.value), setErr(null))}
            onKeyUp={(e) => setCaps(e.getModifierState('CapsLock'))}
            onBlur={() => setCaps(false)}
            autoFocus
            autoComplete="current-password"
            dir="ltr"
            aria-invalid={!!err}
            aria-describedby={err ? 'pw-err' : undefined}
          />
          <button type="button" onClick={() => setShow((s) => !s)} className="btn btn-ghost btn-icon btn-sm shrink-0 text-ink-3" aria-label={show ? t('پنهان کردن رمز', 'Hide password') : t('نمایش رمز', 'Show password')} title={show ? t('پنهان کردن رمز', 'Hide password') : t('نمایش رمز', 'Show password')}>
            {show ? <EyeOff size={16} /> : <Eye size={16} />}
          </button>
        </div>
        {caps && !err && <div className="mt-2 text-warn text-[12px]">{t('Caps Lock روشن است.', 'Caps Lock is on.')}</div>}
        {err && (
          <div role="alert" id="pw-err" className="mt-2 text-bad text-[12.5px]">
            {err}
          </div>
        )}
        <button className="btn btn-primary w-full !h-11 mt-5" disabled={!pw || busy}>
          {busy ? <Spinner size={16} /> : <LockKeyhole size={16} />}
          {t('ورود', 'Sign in')}
        </button>
      </form>
    </div>
  );
}
