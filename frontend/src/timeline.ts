/**
 * Timeline selection state. One source of truth: [a, b] month indices (a === b in Month mode).
 * Previously Month mode kept its own index that was never synced with the range, so switching modes
 * jumped to the last month of the record and Play wrapped to the first.
 */
export type TLMode = 'month' | 'range'

export interface TL {
  mode: TLMode
  a: number // first month index (inclusive)
  b: number // last month index (inclusive)
  playing: boolean
  speed: number // 0.5 | 1 | 2 | 4
}

export type TLAction =
  | { type: 'mode'; mode: TLMode }
  | { type: 'range'; a: number; b: number } // drag / preset / custom range
  | { type: 'month'; i: number } // Month mode at month i (calendar click, timeline click, year jump)
  | { type: 'step'; d: number } // ← / →: month mode moves the marker; range mode shifts the band
  | { type: 'play' }
  | { type: 'pause' }
  | { type: 'tick' } // one Play step
  | { type: 'speed'; speed: number }

export interface TLContext { n: number; lastComplete: number } // number of months, index of the latest complete month

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v))

export const initTL = (ctx: TLContext): TL => ({ mode: 'range', a: 0, b: ctx.n - 1, playing: false, speed: 1 })

export function reduceTL(s: TL, act: TLAction, ctx: TLContext): TL {
  const last = ctx.n - 1
  switch (act.type) {
    case 'mode': {
      if (act.mode === s.mode) return s
      if (act.mode === 'month') {
        // last month of the current range, but never past the latest complete month
        const i = clamp(Math.min(s.b, ctx.lastComplete), 0, last)
        return { ...s, mode: 'month', a: i, b: i }
      }
      // back to Range: a small range around the current month
      return { ...s, mode: 'range', playing: false, a: clamp(s.a - 1, 0, last), b: clamp(s.a + 1, 0, last) }
    }
    case 'range': {
      const a = clamp(Math.min(act.a, act.b), 0, last), b = clamp(Math.max(act.a, act.b), 0, last)
      return s.mode === 'month' ? { ...s, a: b, b, playing: false } : { ...s, a, b, playing: false }
    }
    case 'month': {
      const i = clamp(act.i, 0, last)
      return { ...s, mode: 'month', a: i, b: i, playing: false }
    }
    case 'step': {
      if (s.mode === 'month') {
        const i = clamp(s.a + act.d, 0, last)
        return { ...s, a: i, b: i }
      }
      const len = s.b - s.a
      const a = clamp(s.a + act.d, 0, last - len)
      return { ...s, a, b: a + len }
    }
    case 'play': {
      // Play runs month by month from the current month (range start when coming from Range)
      return { ...s, mode: 'month', a: s.a, b: s.a, playing: true }
    }
    case 'pause':
      return { ...s, playing: false }
    case 'tick': {
      if (!s.playing) return s
      const i = s.a >= last ? 0 : s.a + 1 // loop at the end of the record
      return { ...s, a: i, b: i }
    }
    case 'speed':
      return { ...s, speed: act.speed }
  }
}

/** Peak month index within [a, b] for an area's monthly values (used by season presets / year jump in Month mode). */
export function peakIndex(values: number[] | undefined, a: number, b: number) {
  if (!values?.length) return b
  let best = a
  for (let i = a; i <= b; i++) if ((values[i] ?? 0) > (values[best] ?? 0)) best = i
  return best
}
