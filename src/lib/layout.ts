/**
 * Justified rows: every row spans the content width exactly, and nothing is
 * cropped or letterboxed. A port of red_collage.py's layout, plus a fallback
 * for a row nothing fits.
 *
 * Row breaks come from a DP that minimises each row's squared deviation from an
 * ideal height, which keeps row heights even; a greedy fill leaves the last row
 * stretched or stranded.
 */

export interface LayoutOptions {
  /** Content width in px, inside the margins. */
  width: number
  /** Preferred row height in px, or null to aim for √n photos a row — a square grid, 10×10 for 100. */
  rowHeight: number | null
  gap: number
  margin: number
  /** Tallest sheet allowed, margins included. Rows shrink until the sheet fits. */
  maxHeight: number
}

export interface Box {
  /** Index into the aspect ratios the layout was made from. */
  index: number
  x: number
  y: number
  w: number
  h: number
}

export interface Layout {
  /** Photos per row and each row's height, as red_collage.py logs them. */
  rows: { count: number; h: number }[]
  boxes: Box[]
  /** Sheet size, margins included. */
  width: number
  height: number
  /** The row height the DP aimed for, after any shrinking to fit `maxHeight`. */
  idealH: number
  /** Whether rows were lowered to fit `maxHeight`. */
  shrunk: boolean
}

/** A row more than this many times the ideal height (too few photos) or less than 1/this (slivers) is not considered. */
const BAND = 2.2

/** Each step lowers the ideal height by 10%; 40 steps reach 1.5% of it, far below any real need. */
const SHRINK = 0.9
const SHRINK_STEPS = 40

export function justify(ars: readonly number[], o: LayoutOptions): Layout {
  const n = ars.length
  const { width, gap, margin } = o
  if (!n) {
    return { rows: [], boxes: [], width: width + 2 * margin, height: 2 * margin, idealH: o.rowHeight ?? 0, shrunk: false }
  }

  const sum = (i: number, j: number) => {
    let s = 0
    for (let k = i; k < j; k++) s += ars[k]!
    return s
  }
  const rowHeight = (i: number, j: number) => (width - gap * (j - i - 1)) / sum(i, j)

  let ideal = o.rowHeight
  if (ideal === null) {
    const k = Math.round(Math.sqrt(n))
    ideal = (width - gap * (k - 1)) / ((k * sum(0, n)) / n)
  }

  let plan = layout(ideal)
  let shrunk = false
  for (let step = 0; plan.height + 2 * margin > o.maxHeight && step < SHRINK_STEPS; step++) {
    ideal *= SHRINK
    plan = layout(ideal)
    shrunk = true
  }

  const boxes: Box[] = []
  let y = margin
  for (const row of plan.rows) {
    let x = margin
    row.ws.forEach((w, k) => {
      boxes.push({ index: row.start + k, x, y, w, h: row.h })
      x += w + gap
    })
    y += row.h + gap
  }

  return {
    rows: plan.rows.map((r) => ({ count: r.ws.length, h: r.h })),
    boxes,
    width: width + 2 * margin,
    height: plan.height + 2 * margin,
    idealH: ideal,
    shrunk,
  }

  function layout(ideal: number) {
    const cost = new Array<number>(n + 1).fill(Infinity)
    const back = new Array<number>(n + 1).fill(0)
    cost[0] = 0
    for (let j = 1; j <= n; j++) {
      // The cheapest row ending at j regardless of the band, for when the band
      // admits none — a single photo far taller or wider than the rest.
      let fallbackI = j - 1
      let fallbackCost = Infinity
      // Widest row last: height only falls as a row gains photos, so the walk
      // stops at the first sliver instead of trying all of 0..j. `<=` keeps
      // the leftmost i on ties, as an ascending walk would.
      for (let i = j - 1; i >= 0; i--) {
        const h = rowHeight(i, j)
        if (h <= 1) break // more gutter than width
        const c = cost[i]! + (h - ideal) ** 2
        if (c <= fallbackCost) {
          fallbackCost = c
          fallbackI = i
        }
        if (h > ideal * BAND) continue // too few photos: absurdly tall
        // Too many: slivers. Only reachable at profile scale, where one row of
        // everything costs a single squared term and can undercut the sum over
        // many honest rows.
        if (h < ideal / BAND) break
        if (c <= cost[j]!) {
          cost[j] = c
          back[j] = i
        }
      }
      if (cost[j] === Infinity) {
        cost[j] = fallbackCost
        back[j] = fallbackI
      }
    }

    const spans: [number, number][] = []
    for (let j = n; j > 0; j = back[j]!) spans.unshift([back[j]!, j])

    let height = -gap
    const rows = spans.map(([start, end]) => {
      const h = Math.round(rowHeight(start, end))
      const ws: number[] = []
      for (let k = start; k < end; k++) ws.push(Math.round(ars[k]! * h))
      // The last photo absorbs the rounding, so every row stays flush.
      ws[ws.length - 1] = width - gap * (ws.length - 1) - ws.slice(0, -1).reduce((a, b) => a + b, 0)
      height += h + gap
      return { start, h, ws }
    })
    return { rows, height }
  }
}

/**
 * The longest side each export format can encode. libwebp stops at 16,383;
 * libjpeg at 65,500 (red_collage.py's JPEG_MAX). PNG has no limit that matters.
 */
export const FORMAT_MAX_SIDE: Record<string, number> = {
  'image/webp': 16383,
  'image/jpeg': 65500,
  'image/png': Infinity,
}

/** Chrome's canvas limits: 32,767 px a side and 32,768 × 8,192 px in all. */
const CANVAS_MAX_SIDE = 32767
const CANVAS_MAX_AREA = 32768 * 8192

/** The tallest sheet of this width that the canvas can hold and the format can encode. */
export function maxSheetHeight(type: string, sheetWidth: number): number {
  return Math.min(FORMAT_MAX_SIDE[type] ?? CANVAS_MAX_SIDE, CANVAS_MAX_SIDE, Math.floor(CANVAS_MAX_AREA / sheetWidth))
}
