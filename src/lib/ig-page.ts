/**
 * Readers that run inside the Instagram tab, in the page's own JavaScript world
 * (`chrome.scripting.executeScript` with `world: 'MAIN'`), riding the user's
 * session.
 *
 * Same rule as red-page.ts: executeScript sends each function as source text,
 * so each must be self-contained — no imports, nothing from outside its body,
 * plain data in and out. That is why the photo picking is written out twice.
 * (A type-only import is fine: it is gone from the built code.)
 */

import type { RawPhoto } from './source'

export interface IgPost {
  /** The post's shortcode. */
  code: string
  caption: string
  photos: RawPhoto[]
  /** Video slides left out; a video post is all video. */
  videos: number
}

export interface IgProfilePage {
  /** In grid order: pinned posts first, then newest. */
  posts: IgPost[]
  cursor: string | null
  hasMore: boolean
}

export type IgError = { error: string }

/**
 * One post, from the media endpoint the web app itself calls. It takes the
 * numeric media id, not the shortcode, and wants Instagram's own web app id.
 */
export async function igPost(mediaId: string): Promise<IgPost | IgError> {
  // The smallest copy in the photo's own shape that is at least 1080px wide.
  // The candidates include square crops for the grid, and 3072px originals that
  // are heavy to fetch and to decode by the hundred.
  const pick = (m: any) => {
    const all: any[] = (m.image_versions2?.candidates ?? []).filter((c: any) => c.width > 0 && c.height > 0)
    if (!all.length) return null
    const widest = all.reduce((a, b) => (b.width > a.width ? b : a))
    const ratio = m.original_width > 0 && m.original_height > 0 ? m.original_width / m.original_height : widest.width / widest.height
    const same = all.filter((c) => Math.abs(c.width / c.height - ratio) <= ratio * 0.01)
    const pool = same.length ? same : all
    const big = pool.filter((c) => c.width >= 1080).sort((a, b) => a.width - b.width)
    return big[0] ?? pool.reduce((a, b) => (b.width > a.width ? b : a))
  }
  try {
    const r = await fetch(`/api/v1/media/${mediaId}/info/`, { credentials: 'include', headers: { 'X-IG-App-ID': '936619743392459' } })
    if (!r.ok) return { error: `media info answered HTTP ${r.status}` }
    const m = (await r.json())?.items?.[0]
    if (!m) return { error: 'media info held no post' }
    const photos: RawPhoto[] = []
    let videos = 0
    for (const s of m.carousel_media?.length ? m.carousel_media : [m]) {
      if (s.media_type === 2 || s.video_versions?.length) {
        videos++
        continue
      }
      const c = pick(s)
      if (c) photos.push({ url: String(c.url), w: Number(c.width), h: Number(c.height) })
    }
    return { code: String(m.code || ''), caption: String(m.caption?.text || ''), photos, videos }
  } catch (e) {
    return { error: String(e) }
  }
}

/**
 * One page of a profile's posts, carousels whole. Instagram's REST feeds for
 * this answer 404 now; the web app pages the grid with a signed GraphQL query.
 * So the query is sent through the page's own Relay network layer, with the
 * page's own query module, which signs it — nothing here builds a request.
 */
export async function igProfilePage(username: string, after: string | null): Promise<IgProfilePage | IgError> {
  const pick = (m: any) => {
    const all: any[] = (m.image_versions2?.candidates ?? []).filter((c: any) => c.width > 0 && c.height > 0)
    if (!all.length) return null
    const widest = all.reduce((a, b) => (b.width > a.width ? b : a))
    const ratio = m.original_width > 0 && m.original_height > 0 ? m.original_width / m.original_height : widest.width / widest.height
    const same = all.filter((c) => Math.abs(c.width / c.height - ratio) <= ratio * 0.01)
    const pool = same.length ? same : all
    const big = pool.filter((c) => c.width >= 1080).sort((a, b) => a.width - b.width)
    return big[0] ?? pool.reduce((a, b) => (b.width > a.width ? b : a))
  }
  try {
    const req = (window as any).require
    const env = req('PolarisRelayEnvironment')
    const query = req('PolarisProfilePostsQuery.graphql')
    const provided: Record<string, unknown> = {}
    for (const [k, v] of Object.entries<any>(req('PolarisProfilePostsQuery$Parameters').params.providedVariables ?? {})) provided[k] = v.get()
    // The variables the grid itself sends.
    const data = { count: 12, include_reel_media_seen_timestamp: true, include_relationship_info: true, latest_besties_reel_media: true, latest_reel_media: true }
    const res = await env.getNetwork().execute(query.params, { after, before: null, data, first: 12, last: null, username, ...provided }, { force: true }).toPromise()
    const body = Array.isArray(res) ? res[0] : res
    const conn = body?.data?.xdt_api__v1__feed__user_timeline_graphql_connection
    if (!conn) return { error: String(body?.errors?.[0]?.message || 'no posts in the answer') }
    const posts: IgPost[] = (conn.edges ?? []).map(({ node: m }: any) => {
      const photos: RawPhoto[] = []
      let videos = 0
      for (const s of m.carousel_media?.length ? m.carousel_media : [m]) {
        if (s.media_type === 2 || s.video_versions?.length) {
          videos++
          continue
        }
        const c = pick(s)
        if (c) photos.push({ url: String(c.url), w: Number(c.width), h: Number(c.height) })
      }
      return { code: String(m.code || ''), caption: String(m.caption?.text || ''), photos, videos }
    })
    return { posts, cursor: conn.page_info?.end_cursor ?? null, hasMore: Boolean(conn.page_info?.has_next_page) }
  } catch (e) {
    return { error: String(e) }
  }
}
