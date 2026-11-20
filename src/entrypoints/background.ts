import { classify } from '@/lib/source'

console.log(`[collage-bro] service worker init — v${__VERSION__}, built ${__BUILD_TIME__}`)

/**
 * The toolbar icon opens a collage tab beside the RedNote or Instagram tab it
 * was clicked on. Everything else — reading the tab, fetching photos, laying
 * them out — happens in that collage tab, which stays open for as long as the
 * work takes, while this worker may be stopped at any time.
 */
export default defineBackground(() => {
  chrome.action.onClicked.addListener(async (tab) => {
    if (tab.id === undefined) return
    if (!classify(tab.url)) {
      // Not a post or a profile, or neither site at all, where the URL is not
      // even visible to us. Say so on the icon rather than open an empty tab.
      await chrome.action.setBadgeBackgroundColor({ tabId: tab.id, color: '#71717A' })
      await chrome.action.setBadgeText({ tabId: tab.id, text: '?' })
      await chrome.action.setTitle({ tabId: tab.id, title: 'Open a RedNote or Instagram post or profile, then click again' })
      setTimeout(() => chrome.action.setBadgeText({ tabId: tab.id, text: '' }), 2500)
      return
    }
    await chrome.tabs.create({
      url: chrome.runtime.getURL(`/collage.html?tab=${tab.id}`),
      index: tab.index + 1,
      openerTabId: tab.id,
    })
  })
})
