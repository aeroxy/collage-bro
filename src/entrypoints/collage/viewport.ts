/**
 * The pan-and-zoom preview: a world grid, the sheet with a shadow, and the
 * overlays — size label, hover tag, reorder target. The overlays are drawn
 * here only, so they never reach an export.
 */

import type { Layout } from '@/lib/layout'
import { drawSheet } from './sheet'

export interface ViewportHooks {
  /** The photo under the pointer changed; -1 for none. */
  hover(index: number): void
  /** A photo was clicked. */
  select(index: number): void
  /** A photo was shift-dragged onto another's place. */
  reorder(from: number, to: number): void
  /** The zoom changed. `byUser` is false when the viewport fitted itself. */
  zoom(zoom: number, byUser: boolean): void
}

/**
 * The preview's backing store is capped so a profile-sized sheet stays quick
 * to redraw. Exports are drawn separately at full size.
 */
const PREVIEW_MAX_SIDE = 8192
const MIN_ZOOM = 0.03
const MAX_ZOOM = 5
const MONO = '"JetBrains Mono Variable", ui-monospace, monospace'
const SANS = '"Inter Variable", -apple-system, sans-serif'

type Pointer = {
  mode: 'press' | 'pan' | 'reorder'
  hit: number
  target: number
  sx: number
  sy: number
  panX: number
  panY: number
}

export function createViewport(el: HTMLElement, canvas: HTMLCanvasElement, hooks: ViewportHooks) {
  const ctx = canvas.getContext('2d')!
  const sheet = document.createElement('canvas')
  const sheetCtx = sheet.getContext('2d')!
  const cam = { panX: 60, panY: 60, zoom: 0.2 }
  let layout: Layout | null = null
  let background = '#FFFFFF'
  let message = ''
  let hovered = -1
  let pointer: Pointer | null = null
  let frame = 0

  const local = (e: MouseEvent) => {
    const r = el.getBoundingClientRect()
    return { sx: e.clientX - r.left, sy: e.clientY - r.top }
  }
  const toWorld = (sx: number, sy: number) => ({ wx: (sx - cam.panX) / cam.zoom, wy: (sy - cam.panY) / cam.zoom })

  function hit(sx: number, sy: number): number {
    const { wx, wy } = toWorld(sx, sy)
    const b = layout?.boxes.find((b) => wx >= b.x && wx <= b.x + b.w && wy >= b.y && wy <= b.y + b.h)
    return b ? b.index : -1
  }

  function request() {
    if (!frame) {
      frame = requestAnimationFrame(() => {
        frame = 0
        render()
      })
    }
  }

  function resize() {
    const r = el.getBoundingClientRect()
    const dpr = devicePixelRatio || 1
    canvas.width = Math.max(1, Math.round(r.width * dpr))
    canvas.height = Math.max(1, Math.round(r.height * dpr))
    request()
  }

  function zoomAround(sx: number, sy: number, zoom: number) {
    const { wx, wy } = toWorld(sx, sy)
    cam.zoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, zoom))
    cam.panX = sx - wx * cam.zoom
    cam.panY = sy - wy * cam.zoom
    hooks.zoom(cam.zoom, true)
    request()
  }

  function render() {
    const r = el.getBoundingClientRect()
    const dpr = devicePixelRatio || 1
    const W = r.width
    const H = r.height
    const { panX, panY, zoom } = cam

    ctx.save()
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.fillStyle = '#F4F4F5'
    ctx.fillRect(0, 0, W, H)

    // A world grid that pans and scales with the camera.
    const step = (zoom > 0.6 ? 100 : zoom < 0.18 ? 500 : 200) * zoom
    if (step >= 14) {
      const ox = ((panX % step) + step) % step
      const oy = ((panY % step) + step) % step
      ctx.strokeStyle = 'rgba(11, 11, 11, 0.055)'
      ctx.lineWidth = 1
      ctx.beginPath()
      for (let x = ox; x < W; x += step) {
        ctx.moveTo(x, 0)
        ctx.lineTo(x, H)
      }
      for (let y = oy; y < H; y += step) {
        ctx.moveTo(0, y)
        ctx.lineTo(W, y)
      }
      ctx.stroke()
    }

    if (!layout || !layout.boxes.length) {
      ctx.fillStyle = '#71717A'
      ctx.font = `600 15px ${SANS}`
      ctx.textAlign = 'center'
      ctx.fillText(message, W / 2, H / 2)
      ctx.restore()
      return
    }

    ctx.translate(panX, panY)
    ctx.scale(zoom, zoom)
    const L = layout

    // The sheet's shadow; shadow sizes are in screen pixels whatever the zoom.
    ctx.save()
    ctx.shadowColor = 'rgba(11, 11, 11, 0.16)'
    ctx.shadowBlur = 32
    ctx.shadowOffsetY = 12
    ctx.fillStyle = background === 'transparent' ? '#FFFFFF' : background
    ctx.fillRect(0, 0, L.width, L.height)
    ctx.restore()

    if (background === 'transparent') {
      const size = 40
      ctx.fillStyle = '#E4E4E7'
      for (let y = 0; y < L.height; y += size) {
        for (let x = 0; x < L.width; x += size) {
          if ((x / size + y / size) % 2 === 0) ctx.fillRect(x, y, Math.min(size, L.width - x), Math.min(size, L.height - y))
        }
      }
    }

    ctx.drawImage(sheet, 0, 0, L.width, L.height)

    ctx.strokeStyle = 'rgba(11, 11, 11, 0.15)'
    ctx.lineWidth = 1.5 / zoom
    ctx.strokeRect(0, 0, L.width, L.height)

    ctx.font = `600 ${Math.max(11, Math.round(12 / zoom))}px ${MONO}`
    ctx.fillStyle = '#52525B'
    ctx.textAlign = 'left'
    const rows = L.rows.length
    ctx.fillText(`${L.width} × ${L.height} px  (${rows} row${rows === 1 ? '' : 's'}, ideal_h ≈ ${Math.round(L.idealH)}px)`, 0, -10 / zoom)

    const box = (i: number) => L.boxes[i]
    const hb = box(hovered)
    if (hb && !pointer) {
      ctx.strokeStyle = '#D85A30'
      ctx.lineWidth = 3 / zoom
      ctx.strokeRect(hb.x, hb.y, hb.w, hb.h)
      const tag = `#${String(hb.index + 1).padStart(2, '0')} · ${hb.w}×${hb.h}px`
      const padX = 8 / zoom
      const padY = 5 / zoom
      const th = 20 / zoom
      ctx.font = `600 ${Math.round(11 / zoom)}px ${MONO}`
      const tw = ctx.measureText(tag).width
      ctx.fillStyle = 'rgba(11, 11, 11, 0.85)'
      ctx.fillRect(hb.x + 8 / zoom, hb.y + 8 / zoom, tw + padX * 2, th)
      ctx.fillStyle = '#FFFFFF'
      ctx.fillText(tag, hb.x + 8 / zoom + padX, hb.y + 8 / zoom + th - padY)
    }

    const tb = pointer?.mode === 'reorder' && pointer.target !== pointer.hit ? box(pointer.target) : undefined
    if (tb) {
      ctx.fillStyle = 'rgba(216, 90, 48, 0.22)'
      ctx.fillRect(tb.x, tb.y, tb.w, tb.h)
      ctx.strokeStyle = '#D85A30'
      ctx.lineWidth = 4 / zoom
      ctx.strokeRect(tb.x, tb.y, tb.w, tb.h)
    }
    ctx.restore()
  }

  el.addEventListener(
    'wheel',
    (e) => {
      e.preventDefault()
      const { sx, sy } = local(e)
      // A trackpad's two-finger scroll pans; a wheel, or a pinch (ctrlKey), zooms.
      const sideways = Math.abs(e.deltaX) > Math.abs(e.deltaY)
      const trackpadPan = e.deltaMode === 0 && Math.abs(e.deltaY) < 18 && e.deltaX !== 0
      if (!e.ctrlKey && !e.metaKey && (sideways || trackpadPan)) {
        cam.panX -= e.deltaX
        cam.panY -= e.deltaY
        hooks.zoom(cam.zoom, true)
        request()
        return
      }
      zoomAround(sx, sy, cam.zoom * Math.exp(-e.deltaY * 0.0018))
    },
    { passive: false },
  )

  el.addEventListener('pointerdown', (e) => {
    if ((e.target as Element).closest('.hud-top, .hud-bottom')) return
    const { sx, sy } = local(e)
    const h = hit(sx, sy)
    el.setPointerCapture(e.pointerId)
    pointer = { mode: 'press', hit: h, target: h, sx, sy, panX: cam.panX, panY: cam.panY }
  })

  el.addEventListener('pointermove', (e) => {
    const { sx, sy } = local(e)
    if (!pointer) {
      const h = hit(sx, sy)
      if (h !== hovered) {
        hovered = h
        hooks.hover(h)
        request()
      }
      return
    }
    const dx = sx - pointer.sx
    const dy = sy - pointer.sy
    if (pointer.mode === 'press' && Math.hypot(dx, dy) > 5) {
      if (e.shiftKey && pointer.hit >= 0) pointer.mode = 'reorder'
      else {
        pointer.mode = 'pan'
        el.classList.add('panning')
      }
    }
    if (pointer.mode === 'pan') {
      cam.panX = pointer.panX + dx
      cam.panY = pointer.panY + dy
      hooks.zoom(cam.zoom, true)
      request()
    } else if (pointer.mode === 'reorder') {
      pointer.target = hit(sx, sy)
      request()
    }
  })

  function release() {
    const p = pointer
    if (!p) return
    pointer = null
    el.classList.remove('panning')
    if (p.mode === 'press' && p.hit >= 0) hooks.select(p.hit)
    else if (p.mode === 'reorder' && p.hit >= 0 && p.target >= 0 && p.hit !== p.target) hooks.reorder(p.hit, p.target)
    request()
  }
  el.addEventListener('pointerup', release)
  el.addEventListener('pointercancel', release)
  addEventListener('resize', resize)
  resize()

  return {
    /** Redraws the preview sheet: after a layout change, a photo arriving, or a new background. */
    setSheet(l: Layout, images: readonly (CanvasImageSource | null)[], bg: string) {
      layout = l
      background = bg
      const scale = Math.min(1, PREVIEW_MAX_SIDE / Math.max(l.width, l.height))
      sheet.width = Math.max(1, Math.round(l.width * scale))
      sheet.height = Math.max(1, Math.round(l.height * scale))
      drawSheet(sheetCtx, l, images, bg, scale)
      if (hovered >= l.boxes.length) hovered = -1
      request()
    },
    /** What an empty viewport says: progress, or what went wrong. */
    setMessage(text: string) {
      message = text
      request()
    },
    highlight(index: number) {
      hovered = index
      request()
    },
    fit() {
      if (!layout) return
      const r = el.getBoundingClientRect()
      const pad = 72
      const zoom = Math.min(Math.max(200, r.width - pad * 2) / layout.width, Math.max(200, r.height - pad * 2) / layout.height, 1.5)
      cam.zoom = zoom
      cam.panX = (r.width - layout.width * zoom) / 2
      cam.panY = (r.height - layout.height * zoom) / 2
      hooks.zoom(zoom, false)
      request()
    },
    zoomBy(factor: number) {
      const r = el.getBoundingClientRect()
      zoomAround(r.width / 2, r.height / 2, cam.zoom * factor)
    },
    actualPixels() {
      if (!layout) return
      const r = el.getBoundingClientRect()
      cam.zoom = 1
      cam.panX = (r.width - layout.width) / 2
      cam.panY = 48
      hooks.zoom(1, true)
      request()
    },
  }
}
