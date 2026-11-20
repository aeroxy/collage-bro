import type { Layout } from '@/lib/layout'

/** A slot whose photo is still downloading. Never exported: the download waits for every photo. */
const PLACEHOLDER = '#E4E4E7'

/**
 * Draws the collage: the background, then each photo in its box, and nothing
 * else. The preview and the export both draw through here, so the download is
 * exactly the preview without its overlays — the viewport draws those on its
 * own canvas, never on a sheet.
 */
export function drawSheet(
  ctx: CanvasRenderingContext2D,
  layout: Layout,
  images: readonly (CanvasImageSource | null)[],
  background: string,
  scale = 1,
) {
  ctx.save()
  ctx.setTransform(scale, 0, 0, scale, 0, 0)
  ctx.clearRect(0, 0, layout.width, layout.height)
  if (background !== 'transparent') {
    ctx.fillStyle = background
    ctx.fillRect(0, 0, layout.width, layout.height)
  }
  ctx.imageSmoothingEnabled = true
  ctx.imageSmoothingQuality = 'high'
  for (const b of layout.boxes) {
    const img = images[b.index]
    if (img) {
      ctx.drawImage(img, b.x, b.y, b.w, b.h)
    } else {
      ctx.fillStyle = PLACEHOLDER
      ctx.fillRect(b.x, b.y, b.w, b.h)
    }
  }
  ctx.restore()
}
