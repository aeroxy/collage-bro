import { mkdirSync, readFileSync } from 'node:fs'
import { defineConfig } from 'wxt'

const chromeProfile = '.wxt/chrome-data'
mkdirSync(chromeProfile, { recursive: true })

const pkg = JSON.parse(readFileSync('./package.json', 'utf-8'))

export default defineConfig({
  srcDir: 'src',
  webExt: {
    chromiumProfile: chromeProfile,
    keepProfileChanges: true,
    chromiumArgs: ['--hide-crash-restore-bubble'],
  },
  vite: () => ({
    define: {
      __VERSION__: JSON.stringify(pkg.version),
      __BUILD_TIME__: JSON.stringify(new Date().toISOString()),
    },
    build: {
      // Loaded unpacked, never from the Web Store, so bundle size buys nothing
      // — and readable output means what runs inside the sites' pages is auditable.
      minify: false,
    },
  }),
  manifest: {
    name: 'Collage Bro',
    description: "Turn a RedNote or Instagram post's photos, or a whole profile's, into one collage",
    // `scripting` runs the readers inside the site's tab, in the page's own
    // JavaScript world, where RedNote keeps its note and profile state and
    // Instagram its Relay environment. That is the whole list.
    //
    // Note what is absent. No `tabs`: the host permissions below already show
    // us the tab's URL. No `downloads`: the collage is saved with an
    // <a download>. No `storage`: nothing outlives the collage tab. And no host
    // permission for either photo CDN: both answer with
    // `Access-Control-Allow-Origin: *`, so the collage page fetches photos with
    // plain CORS. RedNote's sns-webpic-qc.xhscdn.com refuses a foreign Referer,
    // chrome-extension:// included, so photos are fetched with `referrerPolicy:
    // 'no-referrer'`; a host permission would not lift that check.
    permissions: ['scripting'],
    // The tabs a collage is made from. executeScript needs host access to
    // them, and tabs.get needs it to read the tab's URL.
    host_permissions: ['*://www.xiaohongshu.com/*', '*://www.instagram.com/*'],
    // No popup: a click goes straight to action.onClicked.
    action: {
      default_title: 'Make a collage of this post or profile',
    },
    icons: {
      16: 'assets/icon-16.png',
      32: 'assets/icon-32.png',
      48: 'assets/icon-48.png',
      128: 'assets/icon-128.png',
    },
  },
})
