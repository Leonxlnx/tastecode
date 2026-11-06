// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import {
  browserVisitAddress,
  readBrowserHistory,
  rememberBrowserVisit,
  subscribeBrowserHistory,
} from './browser-history.js'

const STORAGE_KEY = 'harness.browserHistory'
const titles = () => readBrowserHistory().map(({ title }) => title)
const urls = () => readBrowserHistory().map(({ url }) => url)

beforeEach(() => localStorage.clear())
afterEach(() => vi.unstubAllGlobals())

it('lists the newest page first and survives a new read of storage', () => {
  rememberBrowserVisit('https://one.example/', 'One', 1_000)
  rememberBrowserVisit('https://two.example/', 'Two', 2_000)

  expect(readBrowserHistory()).toEqual([
    { url: 'https://two.example/', title: 'Two', visitedAt: 2_000 },
    { url: 'https://one.example/', title: 'One', visitedAt: 1_000 },
  ])
  expect(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '[]')).toEqual(readBrowserHistory())
})

it('moves a page opened again to the top instead of listing it twice', () => {
  rememberBrowserVisit('https://one.example/', 'One', 1_000)
  rememberBrowserVisit('https://two.example/', 'Two', 2_000)
  rememberBrowserVisit('https://one.example/', 'One', 3_000)

  expect(urls()).toEqual(['https://one.example/', 'https://two.example/'])
  expect(readBrowserHistory()[0]?.visitedAt).toBe(3_000)
})

it('keeps one row for a page whose fragment moves, and stores no fragment', () => {
  rememberBrowserVisit('https://docs.example/guide#start', 'Guide')
  rememberBrowserVisit('https://docs.example/guide#install', 'Guide')

  expect(urls()).toEqual(['https://docs.example/guide'])
})

it('keeps separate rows for different paths and queries', () => {
  rememberBrowserVisit('https://site.example/a', 'A')
  rememberBrowserVisit('https://site.example/b', 'B')
  rememberBrowserVisit('https://site.example/b?tab=files', 'B files')

  expect(titles()).toEqual(['B files', 'B', 'A'])
})

it('keeps the saved title until the page reports its own', () => {
  rememberBrowserVisit('https://one.example/', 'One', 1_000)
  rememberBrowserVisit('https://one.example/', '   ', 2_000)
  expect(titles()).toEqual(['One'])

  rememberBrowserVisit('https://one.example/', 'One, renamed', 3_000)
  expect(titles()).toEqual(['One, renamed'])
})

it('does not take the address Chromium reports for an untitled page as a title', () => {
  rememberBrowserVisit('http://127.0.0.1:3000/plain', '127.0.0.1:3000/plain')

  expect(titles()).toEqual([''])
})

it('never stores a password from the address', () => {
  rememberBrowserVisit('https://me:hunter2@site.example/admin', 'Admin')

  expect(urls()).toEqual(['https://site.example/admin'])
  expect(localStorage.getItem(STORAGE_KEY)).not.toContain('hunter2')
})

it('never stores a sign-in code, token or key from the address', () => {
  rememberBrowserVisit(
    'https://app.example/callback?code=abc123&state=xyz&Access_Token=tok1&id_token=tok2&key=k1&sig=s1&signature=s2&auth=a1&session=s3&password=p1&tab=files#access_token=frag',
    'Signed in',
  )

  expect(urls()).toEqual(['https://app.example/callback?tab=files'])
  const stored = localStorage.getItem(STORAGE_KEY) ?? ''
  for (const secret of [
    'abc123',
    'xyz',
    'tok1',
    'tok2',
    'k1',
    's1',
    's2',
    'a1',
    's3',
    'p1',
    'frag',
  ])
    expect(stored).not.toContain(secret)
})

it('lists only web pages', () => {
  rememberBrowserVisit('about:blank', 'Blank')
  rememberBrowserVisit('file:///etc/hosts', 'Hosts')
  rememberBrowserVisit('not a url', 'Nothing')

  expect(readBrowserHistory()).toEqual([])
})

it('leaves out an address too long to be worth a slot and bounds a title', () => {
  rememberBrowserVisit(`https://site.example/#${'x'.repeat(4_000)}`, 'Huge')
  expect(readBrowserHistory()).toEqual([])

  rememberBrowserVisit('https://site.example/', 'T'.repeat(1_000))
  expect(titles()[0]).toHaveLength(300)
})

it('drops the oldest page past the limit', () => {
  for (let page = 0; page < 60; page += 1) {
    rememberBrowserVisit(`https://site.example/${page}`, `Page ${page}`, page)
  }

  expect(readBrowserHistory()).toHaveLength(50)
  expect(titles()[0]).toBe('Page 59')
  expect(titles().at(-1)).toBe('Page 10')
})

it.each(['{not json', '{"url":"https://one.example/"}', '[{"url":1}]'])(
  'starts empty from unreadable storage: %s',
  (saved) => {
    localStorage.setItem(STORAGE_KEY, saved)
    expect(readBrowserHistory()).toEqual([])
  },
)

it('skips a saved row that is not a web page', () => {
  localStorage.setItem(
    STORAGE_KEY,
    JSON.stringify([
      { url: 'javascript:alert(1)', title: 'Bad', visitedAt: 2 },
      { url: 'https://one.example/', title: 'One', visitedAt: 1 },
    ]),
  )

  expect(titles()).toEqual(['One'])
})

it('keeps its snapshot identity until the list changes', () => {
  rememberBrowserVisit('https://one.example/', 'One')
  const before = readBrowserHistory()
  expect(readBrowserHistory()).toBe(before)

  rememberBrowserVisit('https://two.example/', 'Two')
  expect(readBrowserHistory()).not.toBe(before)
})

it('tells subscribers about a new page and a write from another window', () => {
  const onChange = vi.fn()
  const unsubscribe = subscribeBrowserHistory(onChange)

  rememberBrowserVisit('https://one.example/', 'One')
  window.dispatchEvent(new Event('storage'))
  expect(onChange).toHaveBeenCalledTimes(2)

  unsubscribe()
  rememberBrowserVisit('https://two.example/', 'Two')
  window.dispatchEvent(new Event('storage'))
  expect(onChange).toHaveBeenCalledTimes(2)
})

it('still lets the page open when storage refuses the write', () => {
  vi.stubGlobal('localStorage', {
    getItem: () => null,
    setItem: () => {
      throw new DOMException('Quota exceeded', 'QuotaExceededError')
    },
  })
  const onChange = vi.fn()
  const unsubscribe = subscribeBrowserHistory(onChange)

  expect(() => rememberBrowserVisit('https://one.example/', 'One')).not.toThrow()
  expect(readBrowserHistory()).toEqual([])
  expect(onChange).not.toHaveBeenCalled()
  unsubscribe()
})

it.each([
  ['http://127.0.0.1:3000/', '127.0.0.1:3000'],
  ['https://github.com/', 'github.com'],
  ['https://github.com/acme/app/pulls?q=open#top', 'github.com/acme/app/pulls?q=open'],
  ['not a url', 'not a url'],
])('shows %s as %s', (url, address) => {
  expect(browserVisitAddress(url)).toBe(address)
})
