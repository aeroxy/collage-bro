/// <reference types="bun" />
import { describe, expect, test } from 'bun:test'
import { classify, dedupe, https, photoKey, shortcodeToId, slug } from './source'

const NOTE = '6afd2437000000002b02adbb'
const USER = '5993d2cb50c4b460d8a4fd30'
const red = (kind: 'post' | 'profile', id: string) => ({ site: 'red', kind, id }) as const
const ig = (kind: 'post' | 'profile', id: string) => ({ site: 'ig', kind, id }) as const

describe('classify RedNote', () => {
  const cases: [string | undefined, ReturnType<typeof classify>][] = [
    // A note opened from the feed, as a modal or a page.
    [`https://www.xiaohongshu.com/explore/${NOTE}?xsec_token=AB49uo=&xsec_source=pc_feed`, red('post', NOTE)],
    // A share link's target.
    [`https://www.xiaohongshu.com/discovery/item/${NOTE}?xsec_token=x`, red('post', NOTE)],
    // A note opened from a profile: the profile stays in the path, but the tab shows the note.
    [`https://www.xiaohongshu.com/user/profile/${USER}/${NOTE}?xsec_token=AB&xsec_source=pc_user`, red('post', NOTE)],
    [`https://www.xiaohongshu.com/user/profile/${USER}?channel_type=web_note_detail_r10&xsec_token=AB&xsec_source=`, red('profile', USER)],
    // A profile opened from a WeChat share.
    [`https://www.xiaohongshu.com/user/profile/${USER}?xsec_token=YB7L%3D&xsec_source=app_share&xhsshare=WeixinSession`, red('profile', USER)],
    [`https://www.xiaohongshu.com/user/profile/${USER}/`, red('profile', USER)],
    // Pages that are neither, including ones that carry a user id elsewhere.
    ['https://www.xiaohongshu.com/explore', null],
    [`https://www.xiaohongshu.com/chat?openUid=${USER}`, null],
    [`https://www.xiaohongshu.com/chat/${USER}`, null],
    [`https://creator.xiaohongshu.com/explore/${NOTE}`, null],
    [`https://evil.example/explore/${NOTE}`, null],
    ['not a url', null],
    [undefined, null],
  ]
  for (const [url, want] of cases) test(String(url), () => expect(classify(url)).toEqual(want))
})

describe('classify Instagram', () => {
  const cases: [string, ReturnType<typeof classify>][] = [
    ['https://www.instagram.com/p/DewqVZpk5uw/', ig('post', 'DewqVZpk5uw')],
    // Paging through a carousel adds img_index.
    ['https://www.instagram.com/p/DewqVZpk5uw/?img_index=1', ig('post', 'DewqVZpk5uw')],
    // A post opened from a profile keeps the username in front.
    ['https://www.instagram.com/eemilypettersen/p/DewqVZpk5uw/', ig('post', 'DewqVZpk5uw')],
    ['https://www.instagram.com/reel/DIdeKbgTflo/', ig('post', 'DIdeKbgTflo')],
    ['https://www.instagram.com/eemilypettersen/', ig('profile', 'eemilypettersen')],
    ['https://www.instagram.com/eemilypettersen', ig('profile', 'eemilypettersen')],
    ['https://www.instagram.com/some.user_99/?hl=en', ig('profile', 'some.user_99')],
    // Instagram's own pages are not usernames.
    ['https://www.instagram.com/', null],
    ['https://www.instagram.com/explore/', null],
    ['https://www.instagram.com/direct/inbox/', null],
    ['https://www.instagram.com/reels/', null],
    ['https://www.instagram.com/stories/eemilypettersen/3712345678901234567/', null],
    ['https://www.instagram.com/eemilypettersen/tagged/', null],
  ]
  for (const [url, want] of cases) test(url, () => expect(classify(url)).toEqual(want))
})

describe('shortcodeToId', () => {
  test('reads the shortcode as base 64, past 2^53', () => {
    // As the media endpoint itself named this post.
    expect(shortcodeToId('DewqVZpk5uw')).toBe('4012893456590674864')
  })
  test('ignores the suffix of a longer code', () => {
    expect(shortcodeToId('DewqVZpk5uwAAAAAAAAAAAA')).toBe(shortcodeToId('DewqVZpk5uw'))
  })
  test('refuses what is not a shortcode', () => {
    expect(() => shortcodeToId('bad!code')).toThrow('not a shortcode')
  })
})

describe('photoKey', () => {
  const a = 'http://sns-webpic-qc.xhscdn.com/202611201747/a2e7d348/spectrum/1040g0k0327oo601k6e0040o1t4r6s2p9bdta4h8!nd_dft_wlteh_webp_3'
  const b = 'https://sns-webpic-qc.xhscdn.com/202611201748/288248e0/spectrum/1040g0k0327oo601k6e0040o1t4r6s2p9bdta4h8!nd_prv_wlteh_webp_3'
  test('ignores the signed segments and the style', () => {
    expect(photoKey(a)).toBe('1040g0k0327oo601k6e0040o1t4r6s2p9bdta4h8')
    expect(photoKey(b)).toBe(photoKey(a))
  })
  test('keeps photos apart', () => {
    expect(photoKey(a.replace('bdta4h8', 'bdta4h9'))).not.toBe(photoKey(a))
  })
  test("takes an Instagram photo's file name, not its signed query", () => {
    const c = 'https://scontent-sin2-1.cdninstagram.com/v/t51.82787-15/858088200_18371127745244491_744016_n.jpg?stp=dst-jpg_e35&oh=00_AQ&oe=6B05'
    expect(photoKey(c)).toBe('858088200_18371127745244491_744016_n.jpg')
  })
})

test('dedupe keeps the first of each photo, in order', () => {
  const u = (k: string, v = 'x') => ({ url: `https://cdn/2026/${v}/spectrum/${k}!style`, k })
  expect(dedupe([u('a'), u('b'), u('a', 'y'), { url: '', k: 'empty' }, u('c'), u('b')]).map((p) => p.k)).toEqual(['a', 'b', 'c'])
})

test('https upgrades only http', () => {
  expect(https('http://sns-webpic-qc.xhscdn.com/x')).toBe('https://sns-webpic-qc.xhscdn.com/x')
  expect(https('https://a/http://b')).toBe('https://a/http://b')
})

describe('slug', () => {
  test('keeps CJK and words, collapses the rest', () => {
    expect(slug('AKB振袖女仆🎀选哪张当封面呀', 'id')).toBe('akb振袖女仆-选哪张当封面呀')
  })
  test('drops the site suffix of a page title', () => {
    expect(slug('Days in Singapore - 小红书', 'id')).toBe('days-in-singapore')
    expect(slug('Emily on Instagram', 'id')).toBe('emily')
  })
  test('makes a name of a caption', () => {
    expect(slug('💪🏻 #maisonKEEPSactive #maisonKEEPSfriends', 'id')).toBe('maisonkeepsactive-maisonkeepsfriends')
  })
  test('falls back when nothing is left', () => {
    expect(slug('🎀✨!!', NOTE)).toBe(NOTE)
  })
  test('stops at 60 characters without a trailing hyphen', () => {
    const s = slug(`${'a'.repeat(59)} b`, 'id')
    expect(s).toBe('a'.repeat(59))
  })
})
