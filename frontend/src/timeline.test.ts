import { describe, expect, it } from 'vitest'
import { initTL, peakIndex, reduceTL, type TL, type TLAction } from './timeline'

// 2003-01 .. 2026-10 = 286 months; latest complete = 2026-10 (index 285)
const ctx = { n: 286, lastComplete: 285 }
const idx = (m: string) => (+m.slice(0, 4) - 2003) * 12 + +m.slice(5, 7) - 1
const run = (s: TL, ...acts: TLAction[]) => acts.reduce((x, a) => reduceTL(x, a, ctx), s)
const octNov2021 = run(initTL(ctx), { type: 'range', a: idx('2021-10'), b: idx('2021-11') })

describe('timeline state', () => {
  it('starts as the full record in Range mode', () => {
    expect(initTL(ctx)).toMatchObject({ mode: 'range', a: 0, b: 285, playing: false })
  })

  it('Month uses the last month of the current range (the bug: it jumped to the record end)', () => {
    const s = run(octNov2021, { type: 'mode', mode: 'month' })
    expect(s).toMatchObject({ mode: 'month', a: idx('2021-11'), b: idx('2021-11') })
  })

  it('Month never starts past the latest complete month', () => {
    const s = reduceTL(initTL({ n: 287, lastComplete: 285 }), { type: 'mode', mode: 'month' }, { n: 287, lastComplete: 285 })
    expect(s.a).toBe(285)
  })

  it('steps one month at a time and clamps at the ends', () => {
    let s = run(octNov2021, { type: 'mode', mode: 'month' }, { type: 'step', d: 1 })
    expect(s.a).toBe(idx('2021-12'))
    s = run(s, { type: 'step', d: -2 })
    expect([s.a, s.b]).toEqual([idx('2021-10'), idx('2021-10')])
    expect(run(s, { type: 'month', i: 285 }, { type: 'step', d: 1 }).a).toBe(285)
    expect(run(s, { type: 'month', i: 0 }, { type: 'step', d: -1 }).a).toBe(0)
  })

  it('in Range mode, step shifts the band without resizing', () => {
    const s = run(octNov2021, { type: 'step', d: 12 })
    expect([s.a, s.b]).toEqual([idx('2022-10'), idx('2022-11')])
  })

  it('Play animates from the current month, loops at the end, and Pause keeps the month', () => {
    let s = run(octNov2021, { type: 'mode', mode: 'month' }, { type: 'play' }, { type: 'tick' }, { type: 'tick' })
    expect(s).toMatchObject({ mode: 'month', playing: true, a: idx('2022-01') })
    s = run(s, { type: 'pause' }, { type: 'tick' })
    expect(s).toMatchObject({ playing: false, a: idx('2022-01') })
    s = run(s, { type: 'month', i: 285 }, { type: 'play' }, { type: 'tick' })
    expect(s.a).toBe(0)
  })

  it('Play from Range starts at the range start', () => {
    expect(run(octNov2021, { type: 'play' })).toMatchObject({ mode: 'month', a: idx('2021-10'), playing: true })
  })

  it('back to Range restores a ±1 month range around the current month', () => {
    const s = run(octNov2021, { type: 'mode', mode: 'month' }, { type: 'mode', mode: 'range' })
    expect([s.a, s.b]).toEqual([idx('2021-10'), idx('2021-12')])
  })

  it('presets work in both modes: a range in Range mode, its last month in Month mode', () => {
    const preset = { type: 'range' as const, a: idx('2017-03'), b: idx('2017-05') }
    expect(run(initTL(ctx), preset)).toMatchObject({ mode: 'range', a: idx('2017-03'), b: idx('2017-05') })
    expect(run(octNov2021, { type: 'mode', mode: 'month' }, preset)).toMatchObject({ mode: 'month', a: idx('2017-05') })
  })

  it('a calendar click switches to Month mode at that month and stops Play', () => {
    expect(run(octNov2021, { type: 'play' }, { type: 'month', i: idx('2021-11') })).toMatchObject({ mode: 'month', a: idx('2021-11'), playing: false })
  })

  it('peakIndex finds the busiest month in a window', () => {
    expect(peakIndex([1, 9, 3, 7], 0, 3)).toBe(1)
    expect(peakIndex([1, 9, 3, 7], 2, 3)).toBe(3)
    expect(peakIndex(undefined, 2, 3)).toBe(3)
  })
})
