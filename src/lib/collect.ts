/**
 * Collecting a post's or a profile's photos, against the readers in
 * red-page.ts and ig-page.ts as run in the site's tab — or fakes, in tests.
 */

import type { IgError, IgPost, IgProfilePage } from './ig-page'
import type { FetchedNote, NoteState, ProfileState } from './red-page'
import { dedupe, https, photoKey, shortcodeToId, type RawPhoto } from './source'

export interface RedPage {
  readNote(id: string): Promise<NoteState | null>
  readCarousel(): Promise<{ title: string; photos: RawPhoto[] }>
  readProfile(): Promise<ProfileState | null>
  loadMore(): Promise<void>
  fetchNote(id: string, token: string): Promise<FetchedNote>
}

export interface IgPage {
  post(mediaId: string): Promise<IgPost | IgError>
  profilePage(username: string, after: string | null): Promise<IgProfilePage | IgError>
}

/** A photo to lay out: where to fetch it, and its aspect ratio as the page reports it, until the image itself says. */
export interface Found {
  key: string
  url: string
  ar: number
  /** The RedNote note or Instagram post it came from. */
  postId: string
}

export type Sleep = (ms: number) => Promise<void>

/** Between RedNote note pages. RedNote answers fast walkers with a captcha. */
export const NOTE_DELAY_MS = 1000

/** Between pages of an Instagram profile's posts. A page asks for twelve and holds about ten. */
export const IG_PAGE_DELAY_MS = 1000

/** How long a freshly loaded tab gets to produce its state. */
const LOAD_TIMEOUT_MS = 20_000

/** Both sites' photos are mostly 3:4, so one the page gives no size for is laid out as that until it loads. */
const DEFAULT_AR = 3 / 4

export function found(postId: string, photos: readonly RawPhoto[]): Found[] {
  return dedupe(photos).map((p) => ({
    key: photoKey(p.url),
    url: https(p.url),
    ar: p.w > 0 && p.h > 0 ? p.w / p.h : DEFAULT_AR,
    postId,
  }))
}

async function poll<T>(read: () => Promise<T | null>, timeoutMs: number, sleep: Sleep): Promise<T | null> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const got = await read()
    if (got) return got
    if (Date.now() >= deadline) return null
    await sleep(500)
  }
}

export type Step =
  | { kind: 'photos'; postId: string; photos: Found[] }
  | { kind: 'video'; postId: string }
  | { kind: 'failed'; postId: string; error: string }

// ---------------------------------------------------------------- RedNote

/**
 * A note's photos in the note's own order. The state is polled rather than
 * on-page text, because the note shell renders before its photo list arrives.
 */
export async function collectRedNote(page: RedPage, id: string, sleep: Sleep, timeoutMs = LOAD_TIMEOUT_MS) {
  const note = await poll(() => page.readNote(id), timeoutMs, sleep)
  if (note?.type === 'video') throw new Error('This is a video note, so there are no photos to collage.')
  if (note) return { title: note.title, photos: found(id, note.photos) }
  const shown = await page.readCarousel()
  const photos = found(id, shown.photos)
  if (!photos.length) throw new Error('No photos found. Is the note showing in that tab?')
  return { title: shown.title, photos }
}

export async function openRedProfile(page: RedPage, sleep: Sleep, timeoutMs = LOAD_TIMEOUT_MS): Promise<ProfileState> {
  const state = await poll(() => page.readProfile(), timeoutMs, sleep)
  if (!state) throw new Error('No notes loaded. Is the profile showing in that tab?')
  return state
}

/**
 * Walks a RedNote profile's notes in page order — pinned, then newest — one
 * note page at a time, asking the page's store for the next page of notes when
 * the loaded ones run out. Yields once per note; returns why it ended.
 */
export async function* walkRedProfile(page: RedPage, first: ProfileState, sleep: Sleep): AsyncGenerator<Step, string> {
  let state = first
  const seen = new Set<string>()
  let fetched = 0
  let failed = 0
  let stalls = 0
  for (;;) {
    const fresh = state.notes.filter((n) => !seen.has(n.id))
    for (const n of fresh) {
      seen.add(n.id)
      if (n.type === 'video') {
        yield { kind: 'video', postId: n.id }
        continue
      }
      if (fetched++) await sleep(NOTE_DELAY_MS)
      const got = await page.fetchNote(n.id, n.token)
      if ('error' in got) {
        yield { kind: 'failed', postId: n.id, error: got.error }
        // In a row: RedNote is refusing note pages, most likely a rate limit.
        if (++failed === 3) {
          return 'Three notes in a row would not load, so RedNote may be rate-limiting. If the RedNote tab shows a captcha, solve it and click the icon again.'
        }
        continue
      }
      failed = 0
      yield { kind: 'photos', postId: n.id, photos: found(n.id, got.photos) }
    }
    if (!state.hasMore) return 'complete'
    // One empty page usually means the page was mid-fetch on its own; a few in
    // a row means it has stopped paging.
    stalls = fresh.length ? 0 : stalls + 1
    if (stalls === 3) return 'The profile stopped loading more notes.'
    await sleep(NOTE_DELAY_MS)
    await page.loadMore()
    const next = await page.readProfile()
    if (next?.userId && first.userId && next.userId !== first.userId) return 'The RedNote tab moved to another profile.'
    state = next ?? state
  }
}

// ---------------------------------------------------------------- Instagram

/** A post's photos in carousel order, video slides left out. */
export async function collectIgPost(page: IgPage, code: string) {
  const got = await page.post(shortcodeToId(code))
  if ('error' in got) throw new Error(`Instagram would not give this post (${got.error}). Is the tab logged in?`)
  if (!got.photos.length) {
    throw new Error(got.videos ? 'This post is all video, so there are no photos to collage.' : 'No photos found in this post.')
  }
  return { title: got.caption.replace(/\s+/g, ' ').trim(), photos: found(code, got.photos), videos: got.videos }
}

/** The profile's first page of posts, given time for a freshly loaded tab to get its modules in. */
export async function openIgProfile(page: IgPage, username: string, sleep: Sleep, timeoutMs = LOAD_TIMEOUT_MS): Promise<IgProfilePage> {
  let last = ''
  const first = await poll(
    async () => {
      const r = await page.profilePage(username, null)
      if ('error' in r) last = r.error
      return 'error' in r ? null : r
    },
    timeoutMs,
    sleep,
  )
  if (!first) throw new Error(`No posts loaded${last ? ` (${last})` : ''}. Is the profile showing in that tab, and logged in?`)
  return first
}

/**
 * Walks an Instagram profile's posts in grid order — pinned, then newest — a
 * page at a time. A page carries each carousel whole, so there is
 * no request per post. Yields once per post; returns why it ended.
 */
export async function* walkIgProfile(page: IgPage, username: string, first: IgProfilePage, sleep: Sleep): AsyncGenerator<Step, string> {
  let current = first
  for (;;) {
    for (const p of current.posts) {
      yield p.photos.length ? { kind: 'photos', postId: p.code, photos: found(p.code, p.photos) } : { kind: 'video', postId: p.code }
    }
    if (!current.hasMore || !current.cursor) return 'complete'
    let next: IgProfilePage | null = null
    for (let failed = 0; !next; ) {
      await sleep(IG_PAGE_DELAY_MS)
      const r = await page.profilePage(username, current.cursor)
      if ('error' in r) {
        yield { kind: 'failed', postId: '', error: r.error }
        if (++failed === 3) return 'Three pages in a row would not load, so Instagram may be rate-limiting. Try again later.'
      } else next = r
    }
    // The same cursor again would page forever.
    if (next.cursor === current.cursor) return 'The profile stopped loading more posts.'
    current = next
  }
}

// ---------------------------------------------------------------- either

/**
 * Takes photos from a profile walk until a count is reached. Photos past the
 * count — the rest of the last post — wait here, so raising the count later
 * continues exactly where this stopped.
 */
export class Harvest {
  readonly tally = { posts: 0, videos: 0, failed: 0, lastError: '' }
  /** Photos handed out so far. */
  taken = 0
  /** Why the walk ended, once it has: `complete`, or a message. */
  ended: string | null = null
  private spill: Found[] = []

  constructor(private readonly walk: AsyncGenerator<Step, string>) {}

  /**
   * Pulls until `want()` photos have been passed to `take`, the walk ends, or
   * `stopped()` says so. `want` is asked again after every post, so a count
   * raised while this runs carries it further. `take` runs after every post,
   * with an empty list for a post that gave nothing, so progress can be shown
   * as it happens.
   */
  async fill(want: () => number, take: (photos: Found[]) => void, stopped: () => boolean = () => false): Promise<void> {
    while (this.taken < want() && !stopped()) {
      if (this.spill.length) {
        const batch = this.spill.splice(0, want() - this.taken)
        this.taken += batch.length
        take(batch)
        continue
      }
      if (this.ended !== null) return
      const r = await this.walk.next()
      if (r.done) {
        this.ended = r.value
        return
      }
      const step = r.value
      if (step.kind === 'video') this.tally.videos++
      else if (step.kind === 'failed') {
        this.tally.failed++
        this.tally.lastError = step.error
      } else {
        this.tally.posts++
        this.spill.push(...step.photos)
      }
      if (!this.spill.length) take([])
    }
  }

  /** Whether more photos could come: some are waiting, or the walk has not ended. */
  get more(): boolean {
    return this.spill.length > 0 || this.ended === null
  }
}
