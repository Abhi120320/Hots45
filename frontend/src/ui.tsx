/** The UI kit: every control and panel section is built from these, so heights, padding, type and states match.
 *  Tokens live in index.css (@theme). Heights: controls 32px (h-8). Spacing: 8px grid only. */
import { useEffect, useId, useRef, useState, type ButtonHTMLAttributes, type ReactNode } from 'react'

const cx = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(' ')

// ---------- buttons ----------
type Variant = 'primary' | 'secondary' | 'ghost'
const VARIANT: Record<Variant, string> = {
  primary: 'bg-accent text-bg font-semibold border-accent hover:brightness-110',
  secondary: 'bg-panel text-ink border-line hover:border-dim',
  ghost: 'bg-transparent text-dim border-transparent hover:text-ink hover:bg-ink/5',
}
/** icon: a 32×32 square. Size lives here, not in `extra`, because two padding utilities on one element don't
 *  override by order in Tailwind (px-3 beat px-0 and squeezed icons to 6px). */
export const buttonCls = (v: Variant = 'secondary', extra?: string, icon = false) =>
  cx('inline-flex items-center justify-center gap-2 h-8 rounded-md border text-sm whitespace-nowrap shrink-0', icon ? 'w-8' : 'px-3',
    'disabled:opacity-40 disabled:cursor-not-allowed', VARIANT[v], extra)

export function Button({ variant = 'secondary', className, ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant }) {
  return <button type="button" className={buttonCls(variant, className)} {...rest} />
}

/** Square icon-only button: always pass aria-label. */
export function IconButton({ label, className, children, ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { label: string }) {
  return (
    <button type="button" aria-label={label} title={label} className={buttonCls('ghost', cx('relative', className), true)} {...rest}>
      {children}
    </button>
  )
}

// ---------- segmented control (every toggle group) ----------
export function Segmented<T extends string>({ label, options, value, onChange, className }: {
  label: string; options: { value: T; label: ReactNode; title?: string }[]; value: T; onChange: (v: T) => void; className?: string
}) {
  return (
    <div role="group" aria-label={label} className={cx('inline-flex flex-wrap max-w-full rounded-md border border-line bg-panel p-px', className)}>
      {options.map(o => (
        <button key={o.value} type="button" aria-pressed={value === o.value} title={o.title} onClick={() => onChange(o.value)}
          className={cx('h-[30px] px-3 rounded-[5px] text-sm whitespace-nowrap inline-flex items-center gap-2',
            value === o.value ? 'bg-accent text-bg font-semibold' : 'text-dim hover:text-ink')}>
          {o.label}
        </button>
      ))}
    </div>
  )
}

// ---------- select (presets, fire type in tight rows) ----------
export function Select<T extends string | number>({ label, value, options, onChange, disabled, title, hideLabel = true, className }: {
  label: string; value: T; options: { value: T; label: string }[]; onChange: (v: T) => void
  disabled?: boolean; title?: string; hideLabel?: boolean; className?: string
}) {
  const id = useId()
  return (
    <span className="inline-flex items-center gap-2">
      <label htmlFor={id} className={hideLabel ? 'sr-only' : 'text-xs text-dim'}>{label}</label>
      <select id={id} value={value} disabled={disabled} title={title}
        onChange={e => onChange((typeof value === 'number' ? +e.target.value : e.target.value) as T)}
        className={buttonCls('secondary', className)}>
        {options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
    </span>
  )
}

// ---------- sections ----------
/** A panel section: same padding (16px), header style and spacing everywhere. */
export function Section({ title, sub, action, children, onTitle, id }: {
  title: string; sub?: ReactNode; action?: ReactNode; children: ReactNode; onTitle?: (e: React.MouseEvent) => void; id?: string
}) {
  const hid = useId()
  return (
    <section aria-labelledby={hid} id={id} className="bg-panel border border-line rounded-md p-4">
      <div className="flex items-start justify-between gap-4 mb-3">
        <div className="min-w-0">
          <h2 id={hid} className={cx('text-sm font-semibold text-ink', onTitle && 'cursor-pointer hover:underline')} onClick={onTitle}>{title}</h2>
          {sub && <p className="text-xs text-dim mt-1">{sub}</p>}
        </div>
        {action}
      </div>
      {children}
    </section>
  )
}

/** KPI card: label (12, secondary) · value (20) · sub-text (12). Use inside a 2-column grid. */
export function Kpi({ label, value, sub }: { label: ReactNode; value: ReactNode; sub?: ReactNode }) {
  return (
    <div className="bg-panel border border-line rounded-md p-4 min-w-0">
      <div className="text-xs text-dim">{label}</div>
      <div className="num text-lg text-ink mt-1 break-words">{value}</div>
      {sub && <div className="text-xs text-dim mt-1">{sub}</div>}
    </div>
  )
}
export const KpiGrid = ({ children }: { children: ReactNode }) => <div className="grid grid-cols-2 gap-2">{children}</div>

/** Small disclosure for advanced options. */
export function Disclosure({ summary, children, className }: { summary: string; children: ReactNode; className?: string }) {
  return (
    <details className={cx('text-xs text-dim group', className)}>
      <summary className="cursor-pointer select-none inline-flex items-center gap-1 h-8 hover:text-ink list-none">
        <span aria-hidden className="inline-block transition-transform group-open:rotate-90">›</span>{summary}
      </summary>
      <div className="pt-2">{children}</div>
    </details>
  )
}

// ---------- states ----------
export function Skeleton({ lines = 3, height }: { lines?: number; height?: number }) {
  return (
    <div role="status" aria-label="Loading" className="flex flex-col gap-2">
      {height ? <div className="skeleton" style={{ height }} /> : Array.from({ length: lines }, (_, i) => (
        <div key={i} className="skeleton h-4" style={{ width: `${[100, 80, 60][i % 3]}%` }} />
      ))}
    </div>
  )
}
export const Empty = ({ children }: { children: ReactNode }) => (
  <p role="status" className="text-sm text-dim border border-dashed border-line rounded-md px-4 py-3">{children}</p>
)
export const ErrorMsg = ({ children, onRetry }: { children: ReactNode; onRetry?: () => void }) => (
  <p role="alert" className="text-sm text-ink border border-accent/60 rounded-md px-4 py-3 flex items-center justify-between gap-4">
    <span><span className="text-accent font-semibold">Error · </span>{children}</span>
    {onRetry && <Button variant="ghost" onClick={onRetry}>Retry</Button>}
  </p>
)
/** loading / error / empty for a useApi result */
export function State({ l, what, lines = 3, height }: { l: { loading: boolean; error?: string; data?: unknown }; what: string; lines?: number; height?: number }) {
  if (l.error) return <ErrorMsg>Could not load {what}: {l.error}</ErrorMsg>
  if (l.loading && !l.data) return <Skeleton lines={lines} height={height} />
  return null
}

// ---------- menu ("⋯ More") ----------
export function Menu({ label, icon, children }: { label: string; icon: ReactNode; children: ReactNode }) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const close = (e: Event) => { if (!ref.current?.contains(e.target as Node)) setOpen(false) }
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('pointerdown', close)
    document.addEventListener('keydown', esc)
    return () => { document.removeEventListener('pointerdown', close); document.removeEventListener('keydown', esc) }
  }, [open])
  return (
    <div ref={ref} className="relative">
      <IconButton label={label} aria-expanded={open} aria-haspopup="menu" onClick={() => setOpen(!open)}>{icon}</IconButton>
      {open && (
        <div role="menu" className="absolute right-0 top-10 z-40 min-w-[240px] bg-panel border border-line rounded-md p-2 flex flex-col"
          onClick={() => setOpen(false)}>
          {children}
        </div>
      )}
    </div>
  )
}
export const menuItemCls = 'flex items-center h-8 px-3 rounded-md text-sm text-ink hover:bg-ink/5 text-left'
