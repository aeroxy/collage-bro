use bun for package management

use bun typecheck

be concise

### Threat model

This is a **personal tool**. It runs in the user's browser, with the user's own
RedNote and Instagram sessions, against posts and profiles the user can already
see. There is no untrusted-model boundary and no multi-tenant server.

Do not flag as security issues: the `scripting` permission or the two host
permissions, functions run in the page's own JavaScript world that read
RedNote's Vue/Pinia state or call Instagram's Relay environment, or the
`new Function` that parses a RedNote note page's state. Those are the
mechanism, not a lapse.

Do flag the one real trade-off: a profile walk is automated traffic on the
user's account. RedNote goes one note page a second and Instagram one page of
posts (about ten) a second, and both stop after three failures in a row,
because the sites answer fast walkers with captchas and blocks. Keep both.

Nothing leaves the machine except requests to the two sites and their photo
CDNs. There is no third-party host.

### Where RedNote's photos come from

Verified live on 2026-11-20. The successor of the sibling
`wechat-convo-export/red-collage-export/red_collage.py`, which drove a tab with
the chrome-devtools CLI. The JS it evaluated is what `src/lib/red-page.ts` runs
through `chrome.scripting.executeScript({ world: 'MAIN' })` instead.

- **A note** — `noteDetailMap[id].note.imageList` (`urlDefault`, `width`,
  `height`) in the page's Pinia `note` store, or in `window.__INITIAL_STATE__`,
  which shares the same objects. Both stay current when a note opens as a modal
  over the feed or a profile. Poll for the list, not for page text: the note
  shell renders first.
- **A profile** — the Pinia `user` store: `notes[0]` (cards in page order,
  pinned first), `noteQueries[0].{hasMore, userId}`, and `fetchNotes()` for the
  next page. The posts API refuses an unsigned request (406) and the store's
  client signs it, so paging goes through the store. `fetchNotes()` works with
  the tab in the background.
- **A profile's notes** — a card carries only a cover, so each note's page is
  fetched from inside the tab with the card's `xsecToken` and its embedded state
  parsed. That state holds bare `undefined`, so it is not JSON; it is evaluated
  with `new Function`. RedNote's only CSP is `upgrade-insecure-requests`, which
  allows that.

Note URLs come in three shapes: `/explore/<id>`, `/discovery/item/<id>`, and
`/user/profile/<user>/<note>` for a note opened from a profile. The last is a
note, not the profile: red_collage.py's profile regex got that wrong. Loading it
directly redirects to `/explore/<id>`.

The DOM carousel is a fallback only. Its swiper loop clones carry
`data-swiper-slide-index` like the real slides, so it returns duplicates, and
`dedupe` is what makes it right.

### Where Instagram's photos come from

Verified live on 2026-11-20, in `src/lib/ig-page.ts`.

- **A post** — `GET /api/v1/media/<id>/info/` from inside the tab, with
  `X-IG-App-ID: 936619743392459` (the web app's own), as the sibling
  `wechat-convo-export/ig-collage-export/ig_collage.py` does. It takes the
  numeric media id: the shortcode read as base 64, first 11 characters.
  Eleven reach 2^66, so `shortcodeToId` uses BigInt; `DewqVZpk5uw` is
  `4012893456590674864`, which the endpoint itself confirmed.
- **A profile** — the REST feeds answer 404 now: `/api/v1/users/web_profile_info/`,
  `/api/v1/feed/user/<id>/` and `/api/v1/feed/user/<name>/username/`. The web
  app pages the grid with a signed GraphQL query instead. `igProfilePage` sends
  the page's own query module, `require('PolarisProfilePostsQuery.graphql')`,
  through the page's own network layer,
  `require('PolarisRelayEnvironment').getNetwork().execute(...)`, with the
  provided variables from `PolarisProfilePostsQuery$Parameters` and the
  variables the grid sends (`data.count` 12, `first` 12, `after` the cursor).
  The answer's `xdt_api__v1__feed__user_timeline_graphql_connection` carries
  each carousel whole, so there is no request per post. The username is in the
  query, so unlike RedNote's store there is no profile-switch to guard against.
  Modules load with the profile route, so the first page is polled for.
- **Which copy** — a photo's candidates include square crops for the grid and
  the original (3072 × 4096 for the test post), next to 1080px copies. The
  original is ~0.9 MB and heavy to decode by the hundred, so both readers take
  the smallest candidate at least 1080px wide in the photo's own shape, the same
  width RedNote serves.

Post URLs: `/p/<code>/`, `/reel/<code>/`, and `/<user>/p/<code>/` when opened
from a profile, often with `?img_index=`. A profile is `/<user>/` alone; the
site's own first segments (`explore`, `direct`, `stories`, …) are not users.

Videos are dropped slide by slide (`media_type` 2, or `video_versions`); a post
that is all video counts as skipped.

### The functions in red-page.ts and ig-page.ts are sent as source

`executeScript` serializes each `func` and runs it in the page, so every
function in `src/lib/red-page.ts` and `src/lib/ig-page.ts` must be
self-contained: no imports, nothing from module scope, plain data in and out.
That is why the photo mapping and candidate picking are written out twice. A
type-only import is fine. After a build, `.output/chrome-mv3/chunks/` should
show them unchanged and without bundler helpers (`__name(` and the like).

### The CDNs

Both send `Access-Control-Allow-Origin: *`, so the collage page fetches photos
with plain CORS and needs no host permission for either.

RedNote's `sns-webpic-qc.xhscdn.com` also refuses a foreign Referer. A request
with no Referer, or RedNote's own, gets the photo; any other —
`chrome-extension://…` included — gets a 403 without the CORS header, which
`fetch` reports only as a CORS failure. red_collage.py sent RedNote's Referer
from curl; a page cannot, so `load` sends none (`referrerPolicy:
'no-referrer'`). A host permission would not lift the hotlink check. Don't add
one, or a `declarativeNetRequest` Referer rule, without evidence that
no-referrer stopped working. Instagram's `scontent-*.cdninstagram.com` does not
check the Referer.

RedNote's photos are 1080px wide (WebP). Both pages report sizes; only the ratio
is used, to lay a photo out until it arrives, and the decoded image's own ratio
after.

### Layout

`src/lib/layout.ts` is red_collage.py's DP. `layout.fixtures.json` holds photo
sizes from real notes and profiles with the rows and sheet size red_collage.py's
own `collage()` produced for them, and the tests require an exact match. If the
DP changes on purpose, regenerate them from red_collage.py rather than editing
them by hand.

Deliberate differences from red_collage.py:

- A row nothing fits in the 2.2× band falls back to the cheapest row ending
  there. red_collage.py left such a state at infinite cost.
- Height caps depend on the format: WebP stops at 16,383 px (libwebp), JPEG at
  65,500, and Chrome's canvas at 32,767 a side and 32,768 × 8,192 px in all.
  Rows shrink 10% at a time until the sheet fits.
- Widths round half up (`Math.round`), not half to even, so a photo can differ
  by 1px; rows and sheet size do not.

### Export

The preview's sheet is capped at 8,192px for speed. The export is drawn again on
its own full-size canvas through the same `drawSheet`, so the download is the
preview without its overlays, at full size. Overlays (size label, hover tag,
reorder target) belong to the viewport and must never be drawn on a sheet: the
download holds the photos and the background, nothing else.

`toBlob` hands back PNG for a type it cannot encode, so the blob's type is
checked. A transparent sheet exported as JPEG gets white, not black.

### Rejected approaches

Don't re-propose these:

- **Reimplementing RedNote's request signer** to call the posts API directly. The
  page signs every call already; letting its store page is the whole trick.
- **Building Instagram's GraphQL requests by hand** (doc ids, `fb_dtsg`, `lsd`).
  The doc id changes with their deploys; the page's own query module and network
  layer always match the page.
- **Instagram's REST feeds** for profiles. They answer 404 (see above).
- **The widest Instagram candidate.** Originals by the hundred are slow to fetch
  and can exhaust the tab when decoded for export.
- **The DOM carousel as the primary source.** Loop clones and rotation; the
  state is authoritative.
- **An always-on main-world content script talking over DOM events**, as the
  sibling ig-voice-transcriber does. `executeScript` returns values directly,
  on demand, and needs no script on every RedNote page.
- **Driving the walk from the background worker.** MV3 workers stop when idle;
  the collage tab is open for as long as the work takes.
- **A disk cache of photos**, as red_collage.py kept. It existed to rebuild with
  new options without re-downloading; here layout changes are live, in memory.

### Testing

`bun test` covers the layout (with the parity fixtures), URL classification for
both sites, shortcode decoding and naming, and the collection logic against fake
pages: pacing, video skipping, the stop rules, paging, a RedNote profile switch,
a stuck Instagram cursor, and the count, including a count raised mid-walk.

The page readers and the editor were checked against both live sites by running
the readers in logged-in tabs, then running the built collage page in a
headless Chrome with only `chrome.tabs.get` and `chrome.scripting.executeScript`
stubbed to return what they captured, photos fetched from the real CDNs.
Clicking the toolbar icon needs the unpacked extension in a logged-in browser.
