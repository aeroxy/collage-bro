/// <reference types="bun" />
import { describe, expect, test } from 'bun:test'
import fixtures from './layout.fixtures.json'
import { justify, maxSheetHeight, type LayoutOptions } from './layout'

const opts = (o: Partial<LayoutOptions> = {}): LayoutOptions => ({
  width: 3600,
  rowHeight: 1150,
  gap: 18,
  margin: 36,
  maxHeight: Infinity,
  ...o,
})

describe('parity with red_collage.py', () => {
  // Photo sizes from real RedNote notes and profiles, with the sheet and rows
  // red_collage.py's own collage() produced for them.
  for (const f of fixtures) {
    test(f.label, () => {
      const ars = f.sizes.map(([w, h]) => w! / h!)
      const got = justify(ars, opts({ ...f.options, maxHeight: 65500 }))
      expect(got.rows.map((r) => [r.count, r.h])).toEqual(f.rows)
      expect([got.width, got.height]).toEqual(f.sheet)
    })
  }
})

describe('justify', () => {
  test('every row is flush with the content width', () => {
    for (const f of fixtures) {
      const ars = f.sizes.map(([w, h]) => w! / h!)
      const got = justify(ars, opts({ ...f.options }))
      const rowsOfBoxes = Map.groupBy(got.boxes, (b) => b.y)
      for (const row of rowsOfBoxes.values()) {
        const last = row[row.length - 1]!
        expect(row[0]!.x).toBe(36)
        expect(last.x + last.w).toBe(36 + 3600)
      }
    }
  })

  test('boxes cover every photo once, in order', () => {
    const got = justify([0.75, 1.33, 1, 0.66, 1.78, 0.75], opts())
    expect(got.boxes.map((b) => b.index)).toEqual([0, 1, 2, 3, 4, 5])
  })

  test('one photo is one full-width row', () => {
    const got = justify([0.75], opts())
    expect(got.rows).toEqual([{ count: 1, h: 4800 }])
    expect(got.boxes[0]).toEqual({ index: 0, x: 36, y: 36, w: 3600, h: 4800 })
  })

  test('a panorama nothing fits beside still gets a row', () => {
    // At 1150px ideal, 8:1 is a 450px row alone and a sliver with anything
    // else, so no row ending on it is inside the band: the fallback places it.
    const got = justify([0.75, 0.75, 8, 0.75, 0.75], opts())
    expect(got.boxes).toHaveLength(5)
    expect(got.rows.reduce((a, r) => a + r.count, 0)).toBe(5)
    for (const b of got.boxes) expect(b.w).toBeGreaterThan(0)
  })

  test('no row height aims for a square grid', () => {
    const got = justify(new Array(100).fill(0.75), opts({ rowHeight: null }))
    expect(got.rows.map((r) => r.count)).toEqual(new Array(10).fill(10))
  })

  test('rows shrink until the sheet fits the height limit', () => {
    const ars = new Array(300).fill(0.75)
    const free = justify(ars, opts({ rowHeight: 1150 }))
    expect(free.height).toBeGreaterThan(16383)
    const capped = justify(ars, opts({ rowHeight: 1150, maxHeight: 16383 }))
    expect(capped.height).toBeLessThanOrEqual(16383)
    expect(capped.shrunk).toBe(true)
    expect(capped.idealH).toBeLessThan(1150)
  })

  test('no photos is an empty sheet', () => {
    expect(justify([], opts())).toMatchObject({ rows: [], boxes: [], width: 3672, height: 72 })
  })
})

describe('maxSheetHeight', () => {
  test('WebP stops at 16,383 px', () => expect(maxSheetHeight('image/webp', 3672)).toBe(16383))
  test('JPEG is held to the canvas side limit', () => expect(maxSheetHeight('image/jpeg', 3672)).toBe(32767))
  test('a wide sheet is held to the canvas area', () => {
    expect(maxSheetHeight('image/png', 10000)).toBe(Math.floor((32768 * 8192) / 10000))
  })
})
