/// <reference types="bun" />
import { describe, expect, test } from 'bun:test'
import { collectIgPost, collectRedNote, found, Harvest, IG_PAGE_DELAY_MS, NOTE_DELAY_MS, openIgProfile, openRedProfile, walkIgProfile, walkRedProfile, type Found, type IgPage, type RedPage, type Step } from './collect'
import type { IgPost, IgProfilePage } from './ig-page'
import type { FetchedNote, ProfileState } from './red-page'
import type { RawPhoto } from './source'

const photo = (k: string, w = 1080, h = 1440): RawPhoto => ({
  url: `http://sns-webpic-qc.xhscdn.com/202611201747/sig/spectrum/${k}!nd_dft_wlteh_webp_3`,
  w,
  h,
})
const noSleep = async () => {}

function fakePage(o: Partial<RedPage>): RedPage {
  const unexpected = async (): Promise<never> => {
    throw new Error('unexpected call')
  }
  return { readNote: unexpected, readCarousel: unexpected, readProfile: unexpected, loadMore: unexpected, fetchNote: unexpected, ...o }
}

/** A profile whose notes arrive in pages, one more page per loadMore. */
function fakeProfile(pages: { id: string; type?: string }[][], notes: Record<string, FetchedNote>, userId = () => 'u1') {
  let loaded = 1
  const calls: string[] = []
  const state = (): ProfileState => ({
    userId: userId(),
    nickname: 'nick',
    hasMore: loaded < pages.length,
    notes: pages
      .slice(0, loaded)
      .flat()
      .map((n) => ({ id: n.id, token: `t-${n.id}`, type: n.type ?? 'normal' })),
  })
  const page = fakePage({
    readProfile: async () => state(),
    loadMore: async () => {
      calls.push('more')
      loaded++
    },
    fetchNote: async (id, token) => {
      calls.push(id)
      expect(token).toBe(`t-${id}`)
      return notes[id] ?? { error: 'gone' }
    },
  })
  return { page, calls, first: state() }
}

async function drain(walk: AsyncGenerator<Step, string>) {
  const steps: Step[] = []
  for (;;) {
    const r = await walk.next()
    if (r.done) return { steps, end: r.value }
    steps.push(r.value)
  }
}

const label = (s: Step) => (s.kind === 'photos' ? `${s.postId}:${s.photos.map((p) => p.key).join(',')}` : `${s.kind}:${s.postId}`)

describe('found', () => {
  test('dedupes, upgrades to https, and takes the ratio from the page', () => {
    const got = found('n1', [photo('a', 1440, 2400), photo('a'), photo('b', 0, 0)])
    expect(got).toEqual([
      { key: 'a', url: photo('a').url.replace('http:', 'https:'), ar: 0.6, postId: 'n1' },
      { key: 'b', url: photo('b').url.replace('http:', 'https:'), ar: 0.75, postId: 'n1' },
    ])
  })
})

describe('collectRedNote', () => {
  test('waits for the photo list to arrive', async () => {
    let reads = 0
    const page = fakePage({
      readNote: async (id) => (++reads < 3 ? null : { title: `t-${id}`, type: 'normal', photos: [photo('a'), photo('b')] }),
    })
    const got = await collectRedNote(page, 'n1', noSleep)
    expect(got.title).toBe('t-n1')
    expect(got.photos.map((p) => p.key)).toEqual(['a', 'b'])
  })

  test('refuses a video note', async () => {
    const page = fakePage({ readNote: async () => ({ title: 'v', type: 'video', photos: [] }) })
    await expect(collectRedNote(page, 'n1', noSleep)).rejects.toThrow('video note')
  })

  test('falls back to the carousel, without its loop clones', async () => {
    const page = fakePage({
      readNote: async () => null,
      readCarousel: async () => ({ title: 'shown', photos: [photo('c'), photo('a'), photo('b'), photo('c'), photo('a')] }),
    })
    const got = await collectRedNote(page, 'n1', noSleep, 0)
    expect(got.photos.map((p) => p.key)).toEqual(['c', 'a', 'b'])
  })

  test('says so when there is nothing at all', async () => {
    const page = fakePage({ readNote: async () => null, readCarousel: async () => ({ title: '', photos: [] }) })
    await expect(collectRedNote(page, 'n1', noSleep, 0)).rejects.toThrow('No photos found')
  })
})

test('openRedProfile gives up on a profile that never loads', async () => {
  const page = fakePage({ readProfile: async () => null })
  await expect(openRedProfile(page, noSleep, 0)).rejects.toThrow('No notes loaded')
})

describe('walkRedProfile', () => {
  test('goes in page order, skips videos, and pages for more', async () => {
    const { page, calls, first } = fakeProfile([[{ id: 'a' }, { id: 'v', type: 'video' }, { id: 'b' }], [{ id: 'c' }]], {
      a: { type: 'normal', photos: [photo('a1'), photo('a2'), photo('a1')] },
      b: { type: 'normal', photos: [photo('b1')] },
      c: { type: 'normal', photos: [photo('c1')] },
    })
    const { steps, end } = await drain(walkRedProfile(page, first, noSleep))
    expect(steps.map(label)).toEqual(['a:a1,a2', 'video:v', 'b:b1', 'c:c1'])
    expect(calls).toEqual(['a', 'b', 'more', 'c'])
    expect(end).toBe('complete')
  })

  test('waits between note pages, but not before the first', async () => {
    const { page, first } = fakeProfile([[{ id: 'a' }, { id: 'b' }], [{ id: 'c' }]], {
      a: { type: 'normal', photos: [photo('a1')] },
      b: { type: 'normal', photos: [photo('b1')] },
      c: { type: 'normal', photos: [photo('c1')] },
    })
    const log: string[] = []
    const walk = walkRedProfile(page, first, async (ms) => {
      log.push(`sleep ${ms}`)
    })
    for (let r = await walk.next(); !r.done; r = await walk.next()) log.push(label(r.value))
    const wait = `sleep ${NOTE_DELAY_MS}`
    expect(log).toEqual(['a:a1', wait, 'b:b1', wait, wait, 'c:c1'])
  })

  test('stops after three failures in a row, and a success resets the count', async () => {
    const ids = ['f1', 'f2', 'ok', 'f3', 'f4', 'f5', 'never']
    const { page, calls, first } = fakeProfile([ids.map((id) => ({ id }))], { ok: { type: 'normal', photos: [photo('k')] } })
    const { steps, end } = await drain(walkRedProfile(page, first, noSleep))
    expect(steps.map((s) => s.kind)).toEqual(['failed', 'failed', 'photos', 'failed', 'failed', 'failed'])
    expect(calls).not.toContain('never')
    expect(end).toContain('rate-limiting')
  })

  test('stops when the profile stops paging', async () => {
    const { page, first } = fakeProfile([[{ id: 'a' }], [], [], [], []], { a: { type: 'normal', photos: [photo('a1')] } })
    const { end } = await drain(walkRedProfile(page, first, noSleep))
    expect(end).toBe('The profile stopped loading more notes.')
  })

  test('stops when the tab moves to another profile', async () => {
    let user = 'u1'
    const { page, first } = fakeProfile([[{ id: 'a' }], [{ id: 'b' }]], { a: { type: 'normal', photos: [photo('a1')] } }, () => user)
    const walk = walkRedProfile(page, first, noSleep)
    await walk.next()
    user = 'u2'
    const { steps, end } = await drain(walk)
    expect(steps).toEqual([])
    expect(end).toBe('The RedNote tab moved to another profile.')
  })
})

describe('Harvest', () => {
  const threeEach = (ids: string[]) =>
    fakeProfile(
      [ids.map((id) => ({ id }))],
      Object.fromEntries(ids.map((id) => [id, { type: 'normal', photos: [1, 2, 3].map((k) => photo(`${id}${k}`)) }])),
    )

  test('takes exactly the count, and keeps the rest of the last note for later', async () => {
    const { page, calls, first } = threeEach(['a', 'b', 'c'])
    const h = new Harvest(walkRedProfile(page, first, noSleep))
    const got: Found[] = []
    await h.fill(() => 4, (p) => got.push(...p))
    expect(got.map((p) => p.key)).toEqual(['a1', 'a2', 'a3', 'b1'])
    expect(calls).toEqual(['a', 'b'])

    await h.fill(() => 6, (p) => got.push(...p))
    expect(got.map((p) => p.key)).toEqual(['a1', 'a2', 'a3', 'b1', 'b2', 'b3'])
    expect(calls).toEqual(['a', 'b']) // from what was waiting, without another note page
    expect(h.more).toBe(true)
  })

  test('ends with the walk and says why', async () => {
    const { page, first } = threeEach(['a'])
    const h = new Harvest(walkRedProfile(page, first, noSleep))
    const got: Found[] = []
    await h.fill(() => 100, (p) => got.push(...p))
    expect(got).toHaveLength(3)
    expect(h.ended).toBe('complete')
    expect(h.more).toBe(false)
  })

  test('stops between notes when asked, and continues afterwards', async () => {
    const { page, first } = threeEach(['a', 'b', 'c'])
    const h = new Harvest(walkRedProfile(page, first, noSleep))
    const got: Found[] = []
    let stop = false
    await h.fill(
      () => 100,
      (p) => {
        got.push(...p)
        stop = true
      },
      () => stop,
    )
    expect(got).toHaveLength(3)
    await h.fill(() => 100, (p) => got.push(...p))
    expect(got).toHaveLength(9)
  })

  test('a count raised while it runs carries it further', async () => {
    const { page, first } = threeEach(['a', 'b', 'c', 'd'])
    const h = new Harvest(walkRedProfile(page, first, noSleep))
    const got: Found[] = []
    let want = 3
    await h.fill(
      () => want,
      (p) => {
        got.push(...p)
        want = 7 // raised once the first note is in
      },
    )
    expect(got.map((p) => p.key)).toEqual(['a1', 'a2', 'a3', 'b1', 'b2', 'b3', 'c1'])
  })

  test('reports every note, including one with nothing to give', async () => {
    const { page, first } = fakeProfile([[{ id: 'v', type: 'video' }, { id: 'x' }, { id: 'a' }]], {
      a: { type: 'normal', photos: [photo('a1')] },
    })
    const h = new Harvest(walkRedProfile(page, first, noSleep))
    const batches: number[] = []
    await h.fill(() => 100, (p) => batches.push(p.length))
    expect(batches).toEqual([0, 0, 1])
    expect(h.tally).toEqual({ posts: 1, videos: 1, failed: 1, lastError: 'gone' })
  })
})

// ---------------------------------------------------------------- Instagram

const igPhoto = (k: string, w = 1080, h = 1440): RawPhoto => ({
  url: `https://scontent-sin2-1.cdninstagram.com/v/t51.82787-15/${k}_n.jpg?stp=dst-jpg_e35&oh=00_x&oe=6B05`,
  w,
  h,
})
const post = (code: string, photos: number, videos = 0): IgPost => ({
  code,
  caption: `caption of ${code}`,
  photos: Array.from({ length: photos }, (_, i) => igPhoto(`${code}${i + 1}`)),
  videos,
})

function fakeIg(o: Partial<IgPage>): IgPage {
  const unexpected = async (): Promise<never> => {
    throw new Error('unexpected call')
  }
  return { post: unexpected, profilePage: unexpected, ...o }
}

/** A profile whose posts come a page at a time, with cursors c1, c2, … */
function fakeIgProfile(pages: IgPost[][], fail: (after: string | null) => boolean = () => false) {
  const calls: (string | null)[] = []
  const page = fakeIg({
    profilePage: async (username, after) => {
      expect(username).toBe('emily')
      calls.push(after)
      if (fail(after)) return { error: 'rate limited' }
      const i = after ? Number(after.slice(1)) : 0
      return { posts: pages[i] ?? [], cursor: `c${i + 1}`, hasMore: i + 1 < pages.length }
    },
  })
  return { page, calls }
}

const firstPage = async (page: IgPage) => (await page.profilePage('emily', null)) as IgProfilePage

describe('collectIgPost', () => {
  test('asks for the media id the shortcode stands for', async () => {
    const page = fakeIg({
      post: async (id) => {
        expect(id).toBe('4012893456590674864')
        return { ...post('DewqVZpk5uw', 2, 1), caption: '💪🏻\n#maisonKEEPSactive \n#maisonKEEPSfriends' }
      },
    })
    const got = await collectIgPost(page, 'DewqVZpk5uw')
    expect(got.title).toBe('💪🏻 #maisonKEEPSactive #maisonKEEPSfriends')
    expect(got.photos.map((p) => p.key)).toEqual(['DewqVZpk5uw1_n.jpg', 'DewqVZpk5uw2_n.jpg'])
    expect(got.videos).toBe(1)
  })

  test('refuses a post that is all video', async () => {
    const page = fakeIg({ post: async () => post('DIdeKbgTflo', 0, 1) })
    await expect(collectIgPost(page, 'DIdeKbgTflo')).rejects.toThrow('all video')
  })

  test('says when Instagram refuses', async () => {
    const page = fakeIg({ post: async () => ({ error: 'media info answered HTTP 401' }) })
    await expect(collectIgPost(page, 'DewqVZpk5uw')).rejects.toThrow('HTTP 401')
  })
})

describe('openIgProfile', () => {
  test('waits for a freshly loaded tab', async () => {
    let tries = 0
    const page = fakeIg({
      profilePage: async () => (++tries < 3 ? { error: 'Requiring unknown module' } : { posts: [post('a', 1)], cursor: 'c1', hasMore: false }),
    })
    expect((await openIgProfile(page, 'emily', noSleep)).posts).toHaveLength(1)
  })

  test('gives up, saying why', async () => {
    const page = fakeIg({ profilePage: async () => ({ error: 'Requiring unknown module' }) })
    await expect(openIgProfile(page, 'emily', noSleep, 0)).rejects.toThrow('Requiring unknown module')
  })
})

describe('walkIgProfile', () => {
  test('goes in grid order, page by page, skipping video posts', async () => {
    const { page, calls } = fakeIgProfile([[post('a', 2), post('v', 0, 1)], [post('b', 1)]])
    const { steps, end } = await drain(walkIgProfile(page, 'emily', await firstPage(page), noSleep))
    expect(steps.map(label)).toEqual(['a:a1_n.jpg,a2_n.jpg', 'video:v', 'b:b1_n.jpg'])
    expect(calls).toEqual([null, 'c1'])
    expect(end).toBe('complete')
  })

  test('waits between pages only', async () => {
    const { page } = fakeIgProfile([[post('a', 1), post('b', 1)], [post('c', 1)]])
    const log: string[] = []
    const walk = walkIgProfile(page, 'emily', await firstPage(page), async (ms) => {
      log.push(`sleep ${ms}`)
    })
    for (let r = await walk.next(); !r.done; r = await walk.next()) log.push(label(r.value))
    expect(log).toEqual(['a:a1_n.jpg', 'b:b1_n.jpg', `sleep ${IG_PAGE_DELAY_MS}`, 'c:c1_n.jpg'])
  })

  test('retries a page, and stops after three failures in a row', async () => {
    let failures = 0
    const { page, calls } = fakeIgProfile([[post('a', 1)], [post('b', 1)]], (after) => after === 'c1' && failures++ < 5)
    const { steps, end } = await drain(walkIgProfile(page, 'emily', await firstPage(page), noSleep))
    expect(steps.map((s) => s.kind)).toEqual(['photos', 'failed', 'failed', 'failed'])
    expect(calls).toEqual([null, 'c1', 'c1', 'c1'])
    expect(end).toContain('rate-limiting')
  })

  test('a page that answers on retry carries on', async () => {
    let failures = 0
    const { page } = fakeIgProfile([[post('a', 1)], [post('b', 1)]], (after) => after === 'c1' && failures++ < 1)
    const { steps, end } = await drain(walkIgProfile(page, 'emily', await firstPage(page), noSleep))
    expect(steps.map((s) => s.kind)).toEqual(['photos', 'failed', 'photos'])
    expect(end).toBe('complete')
  })

  test('stops when the cursor stops moving', async () => {
    const page = fakeIg({ profilePage: async () => ({ posts: [post('a', 1)], cursor: 'same', hasMore: true }) })
    const { end } = await drain(walkIgProfile(page, 'emily', await firstPage(page), noSleep))
    expect(end).toBe('The profile stopped loading more posts.')
  })

  test('Harvest takes an exact count from it', async () => {
    const { page } = fakeIgProfile([[post('a', 10), post('b', 10)], [post('c', 10)]])
    const h = new Harvest(walkIgProfile(page, 'emily', await firstPage(page), noSleep))
    const got: Found[] = []
    await h.fill(
      () => 15,
      (p) => got.push(...p),
    )
    expect(got.map((p) => p.key).slice(9, 12)).toEqual(['a10_n.jpg', 'b1_n.jpg', 'b2_n.jpg'])
    expect(got).toHaveLength(15)
    expect(h.tally.posts).toBe(2)
  })
})
