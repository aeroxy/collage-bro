<p align="center">
  <img src="public/assets/icon-128.png" width="96" height="96" alt="">
</p>

<h1 align="center">Collage Bro</h1>

<p align="center">
  Turns a RedNote (小红书) or Instagram post's photos, or a whole profile's,
  into one justified collage: every row flush, nothing cropped, and nothing in
  the file but the photos.
</p>

<p align="center">
  <em>One click from the page you're on. Everything happens in your browser.</em>
</p>

## Using it

Open a post or a profile on `www.xiaohongshu.com` or `www.instagram.com`, logged
in, and click the toolbar icon. A collage tab opens next to it.

- **A post** — a RedNote note or an Instagram post — gives all its photos, in
  its own order, in rows aiming for 1150px. Video slides are left out.
- **A profile** gives its newest photos — every photo of every post, pinned
  posts first, video posts skipped — 100 unless you change the count, in a
  square grid: 10×10 for 100. **Stop** finishes the post it is on; raising the
  count (or **Continue**) picks up where it stopped.
  - On RedNote it reads one note a second, so 100 photos take about half a
    minute.
  - On Instagram it reads a page of about ten posts a second, carousels whole,
    so 100 photos usually take a few seconds.

Photos appear as they arrive. Drag thumbnails to reorder, ✕ to leave one out;
Shift-drag on the sheet works too. The layout controls are red_collage.py's:
content width, row height or the √n grid, gutter, margin, and background.

**Download** saves `<title>-collage.webp` (or `.jpg`, `.png`) at full size to
your downloads folder, named from the note title, the post's caption or the
profile's name. WebP is the default; JPG is the one every site accepts. The file
holds the photos and the background, nothing else: no title, caption, avatar,
or labels.

## How it works

**Reading the page.** The collage tab runs small readers inside the site's tab,
in the page's own JavaScript world, with `chrome.scripting.executeScript`. They
use what the page already has, as you: no API keys, and no request signing of
their own.

- **RedNote** keeps each note's photo list and a profile's note list in its
  Vue/Pinia state. A profile card carries only a cover, so each note's page is
  fetched from inside the tab and its photo list read from the state embedded in
  it. More notes come from the page's own store, which signs the request the
  posts API insists on.
- **Instagram** gives a post's photos through the media endpoint its web app
  calls. For a profile, the readers send the page's own posts query through the
  page's own network layer, which signs it; each page of about ten posts carries
  every carousel whole.

Three failures in a row stop a walk, and the collage is built from what
arrived.

**Fetching photos.** Both CDNs allow it from any page. RedNote's guards against
hotlinking — it serves a request with no Referer and refuses one from anywhere
else — so the collage tab sends none. Instagram offers each photo in several
sizes, including square crops; the collage takes the smallest copy in the
photo's own shape that is at least 1080px wide, the width RedNote serves.

**Laying out.** Rows come from a dynamic program that keeps each row's height
close to a target, so heights stay even and no row is left stretched or
stranded. It is red_collage.py's, and the tests hold it to that script's output
on real notes and profiles.

**Exporting.** The preview is drawn small for speed; the download is drawn again
at full size. WebP tops out at 16,383px and Chrome's canvas at 32,767px, so on
a very tall sheet the rows shrink until it fits, and the readout says so.

| File | Role |
| --- | --- |
| `src/entrypoints/background.ts` | Toolbar click → collage tab, for a post or profile tab |
| `src/entrypoints/collage/` | The collage page: collection, preview, controls, export |
| `src/lib/red-page.ts` | Readers that run inside the RedNote tab |
| `src/lib/ig-page.ts` | Readers that run inside the Instagram tab |
| `src/lib/collect.ts` | A post's photos; both profile walks and their stop rules |
| `src/lib/layout.ts` | Justified rows, and each format's height limit |
| `src/lib/source.ts` | Site, post or profile from a URL; photo identity; file names |

## Setup

```bash
bun install
bun run build
```

Load `.output/chrome-mv3` unpacked (`chrome://extensions`, Developer mode, Load
unpacked). There is nothing to configure.

For development, `bun run dev` launches a browser with the extension loaded; log
in to RedNote and Instagram there once, and the profile keeps it. `bun test`
runs the tests.

## Permissions

`scripting`, and access to `www.xiaohongshu.com` and `www.instagram.com` — to
run the readers in the tab you clicked on and to see its URL. Nothing else: no
tabs, downloads or storage permission, and no access to any other site.

## Limits

- Photos come at about 1080px wide: RedNote serves that size, and of
  Instagram's copies the collage takes the smallest at least that wide.
- Videos are skipped, slide by slide.
- It reads the sites' page internals: RedNote's Pinia `note` and `user` stores
  and the state embedded in note pages; Instagram's media endpoint and its
  `PolarisProfilePostsQuery` and Relay environment. If either site changes
  them, the collage tab says it found no photos or posts rather than making
  something up.
- A walk is your account browsing, at a deliberate pace. If a site still asks
  for a captcha or blocks a request, three failures in a row end the walk with
  what it has. Solve it in the site's tab and click the icon again; that walk
  starts over from the top.
- A private Instagram profile works only if your account can see it.
