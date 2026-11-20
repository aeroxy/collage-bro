import '@fontsource-variable/inter'
import '@fontsource-variable/jetbrains-mono'
import './style.css'
import {
  collectIgPost,
  collectRedNote,
  Harvest,
  openIgProfile,
  openRedProfile,
  walkIgProfile,
  walkRedProfile,
  type Found,
  type IgPage,
  type RedPage,
  type Step,
} from '@/lib/collect'
import { igPost, igProfilePage } from '@/lib/ig-page'
import { justify, maxSheetHeight, type Layout } from '@/lib/layout'
import { fetchNote, loadMoreNotes, readCarousel, readNote, readProfile } from '@/lib/red-page'
import { classify, slug, type Site, type Source } from '@/lib/source'
import { drawSheet } from './sheet'
import { createViewport } from './viewport'

interface Photo extends Found {
  id: number
  /** Decoded from the downloaded bytes, so the canvas stays exportable; null while downloading. */
  img: HTMLImageElement | null
}

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`
const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e))

/** How each site words things. */
const WORDS: Record<Site, { site: string; name: string; post: string; pace: string }> = {
  red: { site: 'REDNOTE', name: 'RedNote', post: 'note', pace: 'One note a second, because RedNote answers faster walkers with a captcha.' },
  ig: { site: 'INSTAGRAM', name: 'Instagram', post: 'post', pace: 'A page of posts a second, to go easy on Instagram.' },
}

const state = {
  source: null as Source | null,
  /** The post's title or caption, or the profile's name: the file name comes from it. */
  title: '',
  /** In collage order. A photo that fails to download is dropped. */
  photos: [] as Photo[],
  layout: null as Layout | null,
  selectedId: -1,
  // Layout, with red_collage.py's defaults; a profile switches to the √n grid.
  width: 3600,
  auto: false,
  rowHeight: 1150,
  gap: 18,
  margin: 36,
  bg: '#FFFFFF',
  // Export
  format: 'image/webp',
  ext: 'webp',
  quality: 0.92,
}

// ---------------------------------------------------------------- the site's tab

/** Runs one of the page readers in the tab's own JavaScript world. */
function inTab(tabId: number) {
  return async function run<A extends unknown[], R>(func: (...args: A) => R, ...args: A): Promise<Awaited<R>> {
    const [res] = await chrome.scripting.executeScript({ target: { tabId }, world: 'MAIN', func, args })
    return res?.result as Awaited<R>
  }
}

function redPage(tabId: number): RedPage {
  const run = inTab(tabId)
  return {
    readNote: (id) => run(readNote, id),
    readCarousel: () => run(readCarousel),
    readProfile: () => run(readProfile),
    loadMore: () => run(loadMoreNotes),
    fetchNote: (id, token) => run(fetchNote, id, token),
  }
}

function igPage(tabId: number): IgPage {
  const run = inTab(tabId)
  return {
    post: (mediaId) => run(igPost, mediaId),
    profilePage: (username, after) => run(igProfilePage, username, after),
  }
}

let harvest: Harvest | null = null
let walking = false
let stopRequested = false

async function start() {
  const tabId = Number(new URLSearchParams(location.search).get('tab'))
  const tab = await chrome.tabs.get(tabId).catch(() => null)
  const source = classify(tab?.url)
  if (!tab || !source) {
    fail('Open a RedNote or Instagram post or profile, then click the toolbar icon.', tab ? 'That tab is no longer on a post or profile.' : 'That tab was closed.')
    return
  }
  state.source = source
  state.auto = source.kind === 'profile'
  const w = WORDS[source.site]
  const kind = source.kind === 'post' ? w.post.toUpperCase() : 'PROFILE'
  $('siteLabel').textContent = w.site
  $('kindLabel').textContent = kind
  $('sourceBadge').textContent = kind
  syncControls()
  viewport.setMessage(`Reading the ${w.name} tab…`)
  try {
    if (source.site === 'red') {
      const page = redPage(tabId)
      if (source.kind === 'post') {
        const note = await collectRedNote(page, source.id, sleep)
        collected(note.title, note.photos, 0)
      } else {
        const first = await openRedProfile(page, sleep)
        await profile(first.nickname, walkRedProfile(page, first, sleep))
      }
    } else {
      const page = igPage(tabId)
      if (source.kind === 'post') {
        const post = await collectIgPost(page, source.id)
        collected(post.title, post.photos, post.videos)
      } else {
        const first = await openIgProfile(page, source.id, sleep)
        await profile(`@${source.id}`, walkIgProfile(page, source.id, first, sleep))
      }
    }
  } catch (e) {
    fail(errorText(e))
  }
}

/** A single post's photos, all of them, in its own order. */
function collected(title: string, photos: Found[], videos: number) {
  const w = WORDS[state.source!.site]
  setTitle(title, `Untitled ${w.post}`)
  add(photos)
  const skipped = videos ? ` · ${plural(videos, 'video')} skipped` : ''
  $('progressLine').innerHTML = `<strong>${photos.length}</strong> ${photos.length === 1 ? 'photo' : 'photos'} from this ${w.post}${skipped}`
  setStatus('done', 'Collected')
}

/** A profile: its photos are walked for, up to the count. */
async function profile(title: string, steps: AsyncGenerator<Step, string>) {
  setTitle(title, 'Profile')
  $('profileControls').hidden = false
  harvest = new Harvest(steps)
  await walk()
}

function wanted(): number {
  const n = Math.round(Number($<HTMLInputElement>('wantInput').value))
  return Number.isFinite(n) ? Math.min(2000, Math.max(1, n)) : 100
}

async function walk() {
  if (!harvest || walking) return
  walking = true
  stopRequested = false
  syncWalk()
  try {
    await harvest.fill(
      wanted,
      (photos) => {
        add(photos)
        syncWalk()
      },
      () => stopRequested,
    )
  } catch (e) {
    // executeScript failed: the tab closed or left the site. The walk cannot go on.
    harvest.ended = `The ${WORDS[state.source!.site].name} tab stopped answering (${errorText(e)}).`
  } finally {
    walking = false
    syncWalk()
  }
}

function syncWalk() {
  if (!harvest) return
  const h = harvest
  const w = WORDS[state.source!.site]
  const want = wanted()
  const { posts, videos, failed, lastError } = h.tally
  const parts = [`<strong>${h.taken}</strong> of ${want} photos`, `${plural(posts, w.post)} read`]
  if (videos) parts.push(`${plural(videos, 'video')} skipped`)
  if (failed) parts.push(`${failed} failed`)
  $('progressLine').innerHTML = parts.join(' · ')

  let note = ''
  if (walking) note = stopRequested ? `Stopping after this ${w.post}…` : w.pace
  else if (h.ended === 'complete') note = h.taken < want ? 'That is every photo on the profile.' : ''
  else if (h.ended) note = failed && lastError ? `${h.ended} Last error: ${lastError}` : h.ended
  else if (h.taken < want) note = 'Stopped. Continue picks up where it left off.'
  $('progressNote').textContent = note

  const btn = $<HTMLButtonElement>('walkBtn')
  btn.textContent = walking ? 'Stop' : 'Continue'
  btn.disabled = walking ? stopRequested : !h.more || h.taken >= want
  if (walking) setStatus('live', 'Collecting')
  else if (h.ended && h.ended !== 'complete' && !h.taken) setStatus('error', 'Failed')
  else setStatus('done', h.ended === 'complete' || h.taken >= want ? 'Collected' : 'Stopped')
}

// ---------------------------------------------------------------- photos

let nextId = 1
const queue: Photo[] = []
let downloading = 0
/** At once. The CDN does not rate-limit like note pages do. */
const PARALLEL = 4

function add(found: Found[]) {
  for (const f of found) {
    const p: Photo = { ...f, id: nextId++, img: null }
    state.photos.push(p)
    queue.push(p)
  }
  pump()
  if (found.length) changed(true)
}

function pump() {
  while (downloading < PARALLEL && queue.length) {
    const p = queue.shift()!
    downloading++
    load(p).finally(() => {
      downloading--
      pump()
    })
  }
}

/**
 * Downloads a photo as bytes and decodes it from a blob: URL, which is
 * same-origin to this page, so drawing it never taints the canvas.
 *
 * Both CDNs answer with `Access-Control-Allow-Origin: *`, but RedNote's guards
 * against hotlinking: a request with no Referer, or RedNote's own, gets the
 * photo; any other Referer — this page's chrome-extension:// origin included —
 * gets a 403 without that header, which fetch reports only as a CORS failure.
 * A page cannot claim RedNote's Referer, so it sends none. Instagram's CDN does
 * not care either way.
 */
async function load(p: Photo) {
  let src = ''
  try {
    const res = await fetch(p.url, { referrerPolicy: 'no-referrer' })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    src = URL.createObjectURL(await res.blob())
    const img = new Image()
    img.src = src
    await img.decode()
    p.img = img
    p.ar = img.naturalWidth / img.naturalHeight
    if (!state.photos.includes(p)) URL.revokeObjectURL(src) // left out while it was downloading
  } catch (e) {
    if (src) URL.revokeObjectURL(src)
    const i = state.photos.indexOf(p)
    if (i >= 0) state.photos.splice(i, 1)
    failedDownloads++
    console.warn(`[collage-bro] photo ${p.key} from ${p.postId} did not download:`, e)
  }
  changed(true)
}
let failedDownloads = 0

function move(from: number, to: number) {
  const [p] = state.photos.splice(from, 1)
  if (!p) return
  state.photos.splice(to, 0, p)
  changed(true)
}

function remove(p: Photo) {
  const i = state.photos.indexOf(p)
  if (i < 0) return
  state.photos.splice(i, 1)
  if (p.img) URL.revokeObjectURL(p.img.src)
  changed(true)
}

// ---------------------------------------------------------------- layout & preview

let frame = 0
let stripStale = false
/** Fit the sheet to the screen on every change until the user pans or zooms. */
let autoFit = true

function changed(photos = false) {
  stripStale ||= photos
  if (!frame) frame = requestAnimationFrame(update)
}

function update() {
  frame = 0
  const sheetWidth = state.width + 2 * state.margin
  state.layout = justify(
    state.photos.map((p) => p.ar),
    {
      width: state.width,
      rowHeight: state.auto ? null : state.rowHeight,
      gap: state.gap,
      margin: state.margin,
      maxHeight: maxSheetHeight(state.format, sheetWidth),
    },
  )
  viewport.setSheet(
    state.layout,
    state.photos.map((p) => p.img),
    state.bg,
  )
  if (autoFit) viewport.fit()
  if (stripStale) {
    renderStrip()
    stripStale = false
  }
  syncReadouts()
}

const viewport = createViewport($('infiniteViewport'), $<HTMLCanvasElement>('viewportCanvas'), {
  hover(i) {
    const p = state.photos[i]
    const b = state.layout?.boxes[i]
    $('hudHoverInfo').innerHTML =
      p && b
        ? `<strong>#${String(i + 1).padStart(2, '0')}</strong> · ${p.img ? `${p.img.naturalWidth}×${p.img.naturalHeight} source` : 'loading'} · slot ${b.w}×${b.h}px`
        : 'Drag to pan · Scroll to zoom · Shift-drag a photo to reorder'
  },
  select(i) {
    const p = state.photos[i]
    if (!p) return
    state.selectedId = p.id
    renderStrip()
    $('photoStrip').children[i]?.scrollIntoView({ block: 'nearest' })
  },
  reorder(from, to) {
    move(from, to)
    toast(`Moved photo #${from + 1} to #${to + 1}`)
  },
  zoom(zoom, byUser) {
    if (byUser) autoFit = false
    $('zoomReadout').textContent = `${Math.round(zoom * 100)}%`
  },
})

let dragFrom = -1

function renderStrip() {
  const strip = $('photoStrip')
  strip.replaceChildren(
    ...state.photos.map((p, i) => {
      const el = document.createElement('div')
      el.className = `photo-thumb${p.img ? '' : ' loading'}${p.id === state.selectedId ? ' selected' : ''}`
      el.draggable = true
      el.title = `#${i + 1}, from ${WORDS[state.source?.site ?? 'red'].post} ${p.postId}. Drag to reorder.`
      if (p.img) {
        const img = document.createElement('img')
        img.src = p.img.src
        img.alt = ''
        img.decoding = 'async'
        el.append(img)
      }
      const idx = document.createElement('span')
      idx.className = 'photo-thumb-idx'
      idx.textContent = String(i + 1).padStart(2, '0')
      const del = document.createElement('button')
      del.type = 'button'
      del.className = 'photo-thumb-del'
      del.textContent = '✕'
      del.title = 'Leave this photo out'
      del.addEventListener('click', (e) => {
        e.stopPropagation()
        remove(p)
      })
      el.append(idx, del)
      el.addEventListener('dragstart', () => (dragFrom = i))
      el.addEventListener('dragover', (e) => e.preventDefault())
      el.addEventListener('drop', (e) => {
        e.preventDefault()
        if (dragFrom >= 0 && dragFrom !== i) move(dragFrom, i)
        dragFrom = -1
      })
      el.addEventListener('click', () => {
        state.selectedId = p.id
        viewport.highlight(i)
        renderStrip()
      })
      return el
    }),
  )
  const n = state.photos.length
  $('photoCountBadge').textContent = `${n} PHOTO${n === 1 ? '' : 'S'}`
}

function syncReadouts() {
  const L = state.layout
  const n = state.photos.length
  const loading = state.photos.filter((p) => !p.img).length
  const rows = L?.rows.map((r) => `${r.count}×${r.h}px`).join(', ') ?? ''

  $('readoutCanvasSize').textContent = n && L ? `${L.width} × ${L.height} px` : '—'
  $('hudWorldCoords').textContent = n && L ? `Canvas: ${L.width} × ${L.height} px` : 'Canvas: —'
  $('readoutRowPlan').textContent = rows || '—'
  let ideal = '—'
  if (n && L) {
    ideal = state.auto ? `~${Math.round(L.idealH)} px (Auto √${n})` : `${Math.round(L.idealH)} px`
    if (L.shrunk) ideal = `~${Math.round(L.idealH)} px (lowered: ${state.ext.toUpperCase()} stops at ${maxSheetHeight(state.format, L.width).toLocaleString('en')} px)`
  }
  $('readoutIdealH').textContent = ideal
  $('hudPlanSummary').innerHTML = n && L ? `<span><strong>${n}</strong> photos</span><span>·</span><span><strong>${L.rows.length}</strong> rows</span>` : '<span><strong>0</strong> photos</span>'

  if (state.auto && L && n) {
    $<HTMLInputElement>('rowHeightInput').value = String(Math.round(L.idealH))
    $<HTMLInputElement>('rowHeightSlider').value = String(Math.min(2400, Math.max(200, Math.round(L.idealH))))
  }

  const btn = $<HTMLButtonElement>('downloadBtn')
  if (!exporting) {
    btn.disabled = !n || loading > 0
    $('downloadBtnText').textContent = loading ? `Loading photos… ${n - loading}/${n}` : `Download Collage (.${state.ext})`
  }
  const failNote = failedDownloads ? ` ${plural(failedDownloads, 'photo')} would not download and ${failedDownloads === 1 ? 'is' : 'are'} left out.` : ''
  if (failNote && state.source?.kind === 'post') $('progressNote').textContent = failNote.trim()
}

// ---------------------------------------------------------------- controls

function syncControls() {
  $('modeAutoSqrtBtn').classList.toggle('active', state.auto)
  $('modeFixedRowBtn').classList.toggle('active', !state.auto)
  $('dpModeBadge').textContent = state.auto ? 'AUTO √N' : 'TARGET H'
  $('rowHeightControlWrap').style.opacity = state.auto ? '0.55' : '1'
  if (!state.auto) {
    $<HTMLInputElement>('rowHeightInput').value = String(state.rowHeight)
    $<HTMLInputElement>('rowHeightSlider').value = String(state.rowHeight)
  }
  const png = state.format === 'image/png'
  $('exportExtBadge').textContent = state.ext.toUpperCase()
  $('qualityWrap').style.opacity = png ? '0.45' : '1'
  $<HTMLInputElement>('qualitySlider').disabled = png
  $('qualityValLabel').textContent = png ? 'Lossless' : `${Math.round(state.quality * 100)}%`
}

function bind(sliderId: string, numId: string, set: (v: number) => void) {
  const slider = $<HTMLInputElement>(sliderId)
  const num = $<HTMLInputElement>(numId)
  slider.addEventListener('input', () => {
    num.value = slider.value
    set(Number(slider.value))
    changed()
  })
  num.addEventListener('change', () => {
    const v = Number(num.value)
    if (!Number.isFinite(v)) return
    slider.value = String(v)
    set(v)
    changed()
  })
}

bind('widthSlider', 'widthInput', (v) => (state.width = Math.max(400, v)))
bind('rowHeightSlider', 'rowHeightInput', (v) => {
  state.auto = false
  state.rowHeight = Math.max(100, v)
  syncControls()
})
bind('gapSlider', 'gapInput', (v) => (state.gap = Math.max(0, v)))
bind('marginSlider', 'marginInput', (v) => (state.margin = Math.max(0, v)))

for (const [id, auto] of [
  ['modeAutoSqrtBtn', true],
  ['modeFixedRowBtn', false],
] as const) {
  $(id).addEventListener('click', () => {
    state.auto = auto
    autoFit = true
    syncControls()
    changed()
  })
}

for (const sw of document.querySelectorAll<HTMLElement>('#bgSwatches .swatch')) {
  sw.addEventListener('click', () => {
    for (const s of document.querySelectorAll('#bgSwatches .swatch')) s.classList.remove('active')
    sw.classList.add('active')
    state.bg = sw.dataset.bg ?? '#FFFFFF'
    changed()
  })
}

for (const tab of document.querySelectorAll<HTMLElement>('#formatTabs .format-tab')) {
  tab.addEventListener('click', () => {
    for (const t of document.querySelectorAll('#formatTabs .format-tab')) t.classList.remove('active')
    tab.classList.add('active')
    state.format = tab.dataset.format ?? 'image/webp'
    state.ext = tab.dataset.ext ?? 'webp'
    syncControls()
    changed() // each format has its own height limit
  })
}

$<HTMLInputElement>('qualitySlider').addEventListener('input', (e) => {
  state.quality = Number((e.target as HTMLInputElement).value) / 100
  syncControls()
})

$('wantInput').addEventListener('change', () => {
  if (harvest && !walking && harvest.more && harvest.taken < wanted()) void walk()
  else syncWalk()
})

$('walkBtn').addEventListener('click', () => {
  if (walking) stopRequested = true
  else void walk()
  syncWalk()
})

$('zoomInBtn').addEventListener('click', () => viewport.zoomBy(1.25))
$('zoomOutBtn').addEventListener('click', () => viewport.zoomBy(1 / 1.25))
$('actualPixelsBtn').addEventListener('click', () => viewport.actualPixels())
for (const id of ['zoomReadout', 'fitScreenBtn']) {
  $(id).addEventListener('click', () => {
    autoFit = true
    viewport.fit()
  })
}

// ---------------------------------------------------------------- export

let exporting = false

/**
 * Draws the sheet again at full size on its own canvas — not the preview's,
 * which is capped — and saves it. The file holds the photos and the
 * background, nothing else.
 */
async function download() {
  const L = state.layout
  if (!L || !state.photos.length || !state.source || exporting) return
  if (state.photos.some((p) => !p.img)) return toast('Some photos are still loading.')
  exporting = true
  $<HTMLButtonElement>('downloadBtn').disabled = true
  $('downloadBtnText').textContent = 'Encoding…'
  const canvas = document.createElement('canvas')
  try {
    canvas.width = L.width
    canvas.height = L.height
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error(`The browser would not make a ${L.width}×${L.height} canvas.`)
    // JPEG has no alpha: a transparent sheet would come out black, so it gets white.
    const bg = state.bg === 'transparent' && state.format === 'image/jpeg' ? '#FFFFFF' : state.bg
    drawSheet(
      ctx,
      L,
      state.photos.map((p) => p.img),
      bg,
    )
    const quality = state.format === 'image/png' ? undefined : state.quality
    const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, state.format, quality))
    // Chrome hands back PNG for a type it cannot encode, so check what came out.
    if (!blob || blob.type !== state.format) {
      throw new Error(`The browser could not encode a ${L.width}×${L.height} sheet as ${state.ext.toUpperCase()}.`)
    }
    const name = `${slug(state.title, state.source.id)}-collage.${state.ext}`
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = name
    a.click()
    setTimeout(() => URL.revokeObjectURL(a.href), 10_000)
    toast(`Saved ${name} · ${L.width}×${L.height} · ${(blob.size / 1e6).toFixed(1)} MB`)
  } catch (e) {
    toast(errorText(e))
  } finally {
    canvas.width = canvas.height = 0 // release the full-size backing store now, not at GC
    exporting = false
    syncReadouts()
  }
}
$('downloadBtn').addEventListener('click', () => void download())

// ---------------------------------------------------------------- status

function setTitle(text: string, fallback: string) {
  state.title = text
  $('title').textContent = text || fallback
  document.title = `${text || fallback} — Collage`
}

function setStatus(kind: 'live' | 'done' | 'error', text: string) {
  $('statusChip').className = `chip status-${kind}`
  $('statusText').textContent = text
}

function fail(message: string, detail = '') {
  setStatus('error', 'Failed')
  $('title').textContent = 'Nothing to collage'
  $('progressLine').textContent = message
  $('progressNote').textContent = detail
  if (!state.photos.length) viewport.setMessage(message)
}

let toastTimer = 0
function toast(message: string) {
  const el = $('toast')
  el.textContent = message
  el.classList.add('visible')
  clearTimeout(toastTimer)
  toastTimer = window.setTimeout(() => el.classList.remove('visible'), 3500)
}

document.querySelector('.eyebrow')?.setAttribute('title', `Collage Bro v${__VERSION__} · built ${__BUILD_TIME__.slice(0, 10)}`)
syncControls()
void start()
