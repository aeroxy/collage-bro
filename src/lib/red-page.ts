/**
 * Readers that run inside the RedNote tab, in the page's own JavaScript world
 * (`chrome.scripting.executeScript` with `world: 'MAIN'`), where the page keeps
 * each note's photo list and a profile's note list in its Vue/Pinia state.
 *
 * executeScript sends each function as source text and runs it there, so every
 * function in this file must be self-contained: no imports, no references to
 * anything outside its own body, and only plain data in and out. That is also
 * why the photo mapping is written out twice rather than shared. (A type-only
 * import is fine: it is gone from the built code.)
 */

import type { RawPhoto } from './source'

export interface NoteState {
  title: string
  /** `normal` for a photo note, `video` for a video note. */
  type: string
  photos: RawPhoto[]
}

export interface ProfileCard {
  id: string
  /** The xsec_token a note's page asks for, which the profile hands out with each card. */
  token: string
  type: string
}

export interface ProfileState {
  /** The profile the page's store is paging, to notice the tab moving to another one. */
  userId: string
  nickname: string
  hasMore: boolean
  /** In page order: pinned notes first, then newest. */
  notes: ProfileCard[]
}

export type FetchedNote = { type: string; photos: RawPhoto[] } | { error: string }

/**
 * The open note, from the page's note store, or from the SSR state it was
 * hydrated from. Both stay current when a note opens over the feed or a
 * profile. Null until the note's photo list has arrived: the note shell
 * renders first.
 */
export function readNote(id: string): NoteState | null {
  const store = (document.querySelector('#app') as any)?.__vue_app__?.config?.globalProperties?.$pinia?._s?.get('note')
  const note = store?.noteDetailMap?.[id]?.note ?? (window as any).__INITIAL_STATE__?.note?.noteDetailMap?.[id]?.note
  if (!note) return null
  const list: any[] = note.imageList ?? []
  if (note.type !== 'video' && !list.length) return null
  return {
    title: String(note.title || ''),
    type: String(note.type || ''),
    photos: list.map((i) => ({ url: String(i.urlDefault || i.urlPre || i.url || ''), w: Number(i.width) || 0, h: Number(i.height) || 0 })),
  }
}

/**
 * Fallback for when the state's shape changes: what the carousel shows. Its
 * loop clones carry `data-swiper-slide-index` too, so the result holds
 * duplicates for the caller to drop.
 */
export function readCarousel(): { title: string; photos: RawPhoto[] } {
  const slides = Array.from(document.querySelectorAll<HTMLElement>('.swiper-slide[data-swiper-slide-index]'))
  const photos = slides
    .map((s) => ({ i: Number(s.dataset.swiperSlideIndex), img: s.querySelector('img') }))
    .filter((s) => s.img?.src)
    .sort((a, b) => a.i - b.i)
    .map((s) => ({ url: s.img!.src, w: s.img!.naturalWidth, h: s.img!.naturalHeight }))
  return { title: document.title, photos }
}

/**
 * The profile's posted notes as far as the page has loaded them, from its
 * `user` store. Null while the first page is still loading.
 */
export function readProfile(): ProfileState | null {
  try {
    const s = (document.querySelector('#app') as any).__vue_app__.config.globalProperties.$pinia._s.get('user')
    const notes: any[] = s.notes[0] ?? []
    const query = s.noteQueries[0]
    // Nothing yet but more to come is a page still loading; nothing and no
    // more is a profile with no notes.
    if (!notes.length && query.hasMore) return null
    return {
      userId: String(query.userId || ''),
      nickname: String(s.userPageData?.basicInfo?.nickname || ''),
      hasMore: Boolean(query.hasMore),
      notes: notes.map((n) => ({
        id: String(n.noteCard?.noteId || n.id || ''),
        token: String(n.xsecToken || n.noteCard?.xsecToken || ''),
        type: String(n.noteCard?.type || ''),
      })),
    }
  } catch {
    return null
  }
}

/**
 * Asks the page's store for the next page of notes. The posts API refuses an
 * unsigned request, and the store's own client signs it, so paging is left to
 * the page rather than reimplementing the signer.
 */
export async function loadMoreNotes(): Promise<void> {
  try {
    await (document.querySelector('#app') as any).__vue_app__.config.globalProperties.$pinia._s.get('user').fetchNotes()
  } catch {
    // An empty page reads the same, and three of those end the walk.
  }
}

/**
 * One note's photos, by fetching its page from inside the tab — same origin,
 * riding the session — and reading the SSR state embedded in it. A page, unlike
 * the API, needs no signature. A profile card carries only a cover, so this is
 * how a profile walk gets each note's full photo list.
 */
export async function fetchNote(id: string, token: string): Promise<FetchedNote> {
  try {
    const r = await fetch(`/explore/${id}?xsec_token=${encodeURIComponent(token)}&xsec_source=pc_user`, { credentials: 'include' })
    const m = (await r.text()).match(/window\.__INITIAL_STATE__=(\{.*?\})<\/script>/s)
    if (!m) return { error: `no note data in its page (HTTP ${r.status}, ${r.url})` }
    // Not JSON: it holds bare `undefined`. So it is evaluated, as the page
    // evaluates its own; RedNote sets no CSP that forbids that.
    const note = new Function(`return ${m[1]}`)().note?.noteDetailMap?.[id]?.note
    if (!note) return { error: 'the note is missing from its page' }
    const list: any[] = note.imageList ?? []
    return {
      type: String(note.type || ''),
      photos: list.map((i) => ({ url: String(i.urlDefault || i.urlPre || i.url || ''), w: Number(i.width) || 0, h: Number(i.height) || 0 })),
    }
  } catch (e) {
    return { error: String(e) }
  }
}
