/** What a RedNote or Instagram tab shows, and the naming helpers around the two sites' URLs. */

export type Site = 'red' | 'ig'

/**
 * A post — a RedNote note or an Instagram post — or a profile: the two things
 * a collage is made from. `id` is a RedNote note or user id, an Instagram
 * shortcode, or an Instagram username.
 */
export interface Source {
  site: Site
  kind: 'post' | 'profile'
  id: string
}

/** A photo as a page reports it, before it is downloaded. */
export interface RawPhoto {
  url: string
  /** The size the page reports, 0 when it reports none. Only the ratio is relied on. */
  w: number
  h: number
}

// RedNote ids are 24 hex characters; 16 or more is accepted, as red_collage.py does.
const RED_ID = '([0-9a-f]{16,})'
const RED_PROFILE = new RegExp(`^/user/profile/${RED_ID}(?:/${RED_ID})?/?$`, 'i')
const RED_NOTE = new RegExp(`^/(?:explore|discovery/item)/${RED_ID}/?$`, 'i')

const IG_USER = '[A-Za-z0-9._]{1,30}'
// A post opened from a profile keeps the username in front: /<user>/p/<code>/.
const IG_POST = new RegExp(`^/(?:${IG_USER}/)?(?:p|reel|reels|tv)/([A-Za-z0-9_-]{5,})/?$`)
const IG_PROFILE = new RegExp(`^/(${IG_USER})/?$`)
/** First path segments that are Instagram's own pages, not usernames. */
const IG_RESERVED = new Set([
  'about', 'accounts', 'ajax', 'api', 'challenge', 'developer', 'direct', 'directory', 'emails',
  'explore', 'graphql', 'legal', 'oauth', 'p', 'privacy', 'reel', 'reels', 'session', 'static',
  'stories', 'terms', 'topics', 'tv', 'web',
])

export function classify(url: string | undefined): Source | null {
  if (!url) return null
  let u: URL
  try {
    u = new URL(url)
  } catch {
    return null
  }
  const path = u.pathname
  if (u.hostname === 'www.xiaohongshu.com') {
    const p = path.match(RED_PROFILE)
    // A note opened from a profile keeps the profile in its path,
    // /user/profile/<user>/<note>: the tab is showing that note, not the profile.
    if (p) return p[2] ? { site: 'red', kind: 'post', id: p[2] } : { site: 'red', kind: 'profile', id: p[1]! }
    const n = path.match(RED_NOTE)
    return n ? { site: 'red', kind: 'post', id: n[1]! } : null
  }
  if (u.hostname === 'www.instagram.com') {
    const post = path.match(IG_POST)
    if (post) return { site: 'ig', kind: 'post', id: post[1]! }
    const user = path.match(IG_PROFILE)?.[1]
    return user && !IG_RESERVED.has(user.toLowerCase()) ? { site: 'ig', kind: 'profile', id: user } : null
  }
  return null
}

const SHORTCODE = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'

/**
 * An Instagram post's numeric media id: its shortcode read as a base-64
 * number. Longer codes carry a suffix that is not part of the id, so only the
 * first 11 characters count. Eleven of them reach 2^66, past what a Number
 * holds exactly, hence BigInt.
 */
export function shortcodeToId(code: string): string {
  let n = 0n
  for (const ch of code.slice(0, 11)) {
    const digit = SHORTCODE.indexOf(ch)
    if (digit < 0) throw new Error(`not a shortcode: ${code}`)
    n = n * 64n + BigInt(digit)
  }
  return n.toString()
}

/**
 * A CDN's name for a photo: the last path segment without RedNote's `!style`
 * suffix. Two URLs for one photo differ in their signed segments or query, and
 * on RedNote in the style (`!nd_dft_wlteh_webp_3`), but never in this.
 */
export function photoKey(url: string): string {
  const path = url.split(/[?#]/)[0]!
  return path.slice(path.lastIndexOf('/') + 1).split('!')[0] || url
}

/** First of each photo, in order. RedNote's carousel fallback sees loop clones of the first and last slides. */
export function dedupe<T extends { url: string }>(photos: readonly T[]): T[] {
  const seen = new Set<string>()
  return photos.filter((p) => {
    if (!p.url) return false
    const k = photoKey(p.url)
    if (seen.has(k)) return false
    seen.add(k)
    return true
  })
}

/** RedNote's state lists http:// URLs; its CDN serves the same photos over https, which an extension page needs. */
export const https = (url: string) => url.replace(/^http:\/\//i, 'https://')

/**
 * A file name from a title, caption or name, like red_collage.py's: words and
 * CJK kept, everything else a single hyphen, lowercased, 60 characters at most.
 * Text that is all emoji or punctuation falls back.
 */
export function slug(text: string, fallback: string): string {
  const s = text
    .replace(/[^\p{L}\p{N}_]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase()
    .replace(/-?(小红书|on-instagram)$/, '')
  return Array.from(s).slice(0, 60).join('').replace(/-+$/, '') || fallback
}
