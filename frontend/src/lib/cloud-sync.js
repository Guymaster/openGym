// Sync without a server: one file in a WebDAV folder (Koofr, Nextcloud, any WebDAV drive) that
// every device reads, merges into its own copy and writes back.
//
// The merge is the one devices use through a server (lib/sync-merge.js, via the store's
// cloudMerge): every change carries its own stamp, so the newest edit of each field wins and
// deletions stay deleted, whichever device writes the file last. The write is conditional on the
// file's ETag when the drive gives one: a device that wrote in between makes it fail with 412, and
// the round starts again from that device's file.
//
// Only this phone's settings live here: the address and login in localStorage, the app password
// in the platform's secure storage (lib/coach-secrets.js), never in S, which is what gets synced.
import { secureGet, secureSet, secureRemove } from './coach-secrets.js'
import { mergeStates } from './sync-merge.js'

export const KOOFR_URL = 'https://app.koofr.net/dav/Koofr'
export const SYNC_FILE = 'opengym-sync.json'
const CONF_KEY = 'gym_cloud_sync'
const PASS_KEY = 'cloud.webdavPassword'
const MAX_ROUNDS = 3
const POLL_MS = 60000
const AFTER_CHANGE_MS = 4000

// ---------- settings ----------

export const DEFAULT_CONFIG = { enabled: false, url: KOOFR_URL, user: '', folder: 'openGym', last: 0, lastError: '' }

export function readConfig() {
  try { return { ...DEFAULT_CONFIG, ...JSON.parse(localStorage.getItem(CONF_KEY) || '{}') } } catch { return { ...DEFAULT_CONFIG } }
}
export function writeConfig(patch) {
  const next = { ...readConfig(), ...patch }
  try { localStorage.setItem(CONF_KEY, JSON.stringify(next)) } catch { /* kept in memory by the caller */ }
  emit(next)
  return next
}
export const getPassword = () => secureGet(PASS_KEY)
export const setPassword = v => secureSet(PASS_KEY, v)
export async function forgetCloud() {
  await secureRemove(PASS_KEY)
  return writeConfig({ ...DEFAULT_CONFIG })
}

const listeners = new Set()
export function onConfigChange(fn) { listeners.add(fn); return () => listeners.delete(fn) }
function emit(conf) { for (const fn of listeners) { try { fn(conf) } catch { /* one listener's trouble */ } } }

// ---------- paths ----------

const trimSlashes = s => String(s || '').replace(/^\/+|\/+$/g, '')
const encodePath = p => trimSlashes(p).split('/').filter(Boolean).map(encodeURIComponent).join('/')
export function folderUrl(conf) {
  const base = String(conf.url || '').replace(/\/+$/, '')
  const dir = encodePath(conf.folder)
  return dir ? `${base}/${dir}` : base
}
export const fileUrl = conf => `${folderUrl(conf)}/${SYNC_FILE}`

// ---------- transport ----------

const basic = (user, pass) => 'Basic ' + btoa(unescape(encodeURIComponent(`${user}:${pass}`)))
const headerOf = (headers, name) => {
  if (!headers) return null
  const k = Object.keys(headers).find(h => h.toLowerCase() === name.toLowerCase())
  return k ? headers[k] : null
}

// The request goes out from native code on the phone: a WebDAV drive has no CORS for the app's
// origin. On a plain browser run it is an ordinary fetch (which most drives will refuse).
// Answers { status, headers, text }.
export async function webdavRequest({ url, method, headers = {}, body }) {
  let cap = null
  try { cap = await import('@capacitor/core') } catch { /* not a Capacitor build */ }
  if (cap?.Capacitor?.isNativePlatform?.()) {
    const res = await cap.CapacitorHttp.request({
      url, method, headers, data: body, responseType: 'text', connectTimeout: 20000, readTimeout: 60000
    })
    const text = typeof res.data === 'string' ? res.data : res.data == null ? '' : JSON.stringify(res.data)
    return { status: res.status, headers: res.headers || {}, text }
  }
  const res = await fetch(url, { method, headers, body })
  const h = {}
  res.headers.forEach((v, k) => { h[k] = v })
  return { status: res.status, headers: h, text: await res.text() }
}

export class CloudError extends Error {
  constructor(code, status) { super(code); this.code = code; this.status = status }
}
const fail = (res) => {
  if (res.status === 401 || res.status === 403) throw new CloudError('auth', res.status)
  throw new CloudError('http', res.status)
}

// ---------- one round ----------

// What is worth writing back: the copy without its timestamp and without the workout running
// here (each device keeps its own, so a set ticked is not a reason to upload).
// The file's copy goes through the merge too (with itself), so lists the merge always writes
// out compare equal to a file written before they existed.
const comparable = S => JSON.stringify({ ...S, _ts: 0, active: null, _wid: undefined })
const settled = S => comparable(mergeStates(S, S))

/* Read the file, merge it in, write the result back when it differs from the file.
   `merge(remote)` takes the file's copy into the store and returns the store's copy;
   `local()` is the store's copy as it is. */
export async function syncOnce({ conf, password, local, merge, request = webdavRequest }) {
  const auth = { Authorization: basic(conf.user, password) }
  const url = fileUrl(conf)
  for (let round = 0; round < MAX_ROUNDS; round++) {
    const got = await request({ url, method: 'GET', headers: { ...auth, 'Cache-Control': 'no-cache' } })
    let remote = null
    let etag = null
    if (got.status === 200) {
      try { remote = JSON.parse(got.text) } catch { throw new CloudError('corrupt', 200) }
      etag = headerOf(got.headers, 'etag')
    } else if (got.status !== 404) fail(got)

    const mine = remote ? merge(remote) : local()
    if (remote && settled(mine) === settled(remote)) return { wrote: false, read: true }

    // text/plain: CapacitorHttp re-encodes a string body sent as application/json on some
    // platforms. The drive only stores the bytes.
    const headers = { ...auth, 'Content-Type': 'text/plain; charset=utf-8' }
    // The last round writes without the condition: a drive whose ETags never match (a weak tag
    // compared strongly) would otherwise refuse every write, and the copy written still holds
    // the merge of a file read a moment ago.
    if (etag && round < MAX_ROUNDS - 1) headers['If-Match'] = etag
    else if (!remote) headers['If-None-Match'] = '*'
    let put = await request({ url, method: 'PUT', headers, body: JSON.stringify(mine) })
    // A first write into a folder that does not exist yet: make it, then write again.
    if (!remote && (put.status === 409 || put.status === 404)) {
      const mk = await request({ url: folderUrl(conf), method: 'MKCOL', headers: auth })
      if (mk.status >= 400 && mk.status !== 405) fail(mk)
      put = await request({ url, method: 'PUT', headers, body: JSON.stringify(mine) })
    }
    if (put.status === 412) continue   // another device wrote in between: read its copy, merge again
    if (put.status >= 200 && put.status < 300) return { wrote: true, read: !!remote }
    fail(put)
  }
  throw new CloudError('busy', 412)
}

// Checks the address and login before they are saved: a PROPFIND of the base folder.
export async function testConnection({ conf, password, request = webdavRequest }) {
  const res = await request({ url: String(conf.url || '').replace(/\/+$/, '') + '/', method: 'PROPFIND', headers: { Authorization: basic(conf.user, password), Depth: '0' } })
  if (res.status === 207 || res.status === 200) return true
  fail(res)
}

// ---------- running it ----------

let running = null
let store = null
let pollTm = null
let changeTm = null
let merging = false

const status = { busy: false }
const statusListeners = new Set()
export const syncStatus = () => status.busy
export function onSyncStatus(fn) { statusListeners.add(fn); return () => statusListeners.delete(fn) }
const setBusy = b => { status.busy = b; for (const fn of statusListeners) { try { fn(b) } catch { /* ignore */ } } }

// One sync at a time; a call while one runs gets that one. Never throws: the outcome is in the
// config (`last`, `lastError`) and in the returned object.
export function syncNow() {
  if (running) return running
  running = (async () => {
    const conf = readConfig()
    if (!store || !conf.enabled || !conf.user) return { skipped: true }
    // A phone connected to its own openGym server syncs through that server instead.
    // Nor before the start has settled the copy it holds.
    if (store.getState().user || !store.getState().ready) return { skipped: true }
    const password = await getPassword()
    if (!password) { writeConfig({ lastError: 'auth' }); return { error: 'auth' } }
    setBusy(true)
    try {
      const r = await syncOnce({
        conf, password,
        local: () => store.getState().S,
        merge: remote => { merging = true; try { return store.getState().cloudMerge(remote) } finally { merging = false } }
      })
      writeConfig({ last: Date.now(), lastError: '' })
      return r
    } catch (e) {
      const code = e instanceof CloudError ? e.code : 'network'
      writeConfig({ lastError: code })
      return { error: code }
    } finally {
      setBusy(false)
    }
  })().finally(() => { running = null })
  return running
}

// Wired once at start: syncs when the app comes back, when the network does, every minute while
// open, and a few seconds after a change made here.
export function startCloudSync(theStore, { onAppActive } = {}) {
  if (store) return
  store = theStore
  const kick = () => { if (readConfig().enabled && document.visibilityState !== 'hidden') syncNow() }
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') kick() })
  window.addEventListener('online', kick)
  if (onAppActive) onAppActive(kick)
  const poll = () => { clearTimeout(pollTm); pollTm = setTimeout(() => { kick(); poll() }, POLL_MS) }
  poll()
  store.subscribe((st, prev) => {
    if (st.ready && !prev.ready) { kick(); return }   // the start has settled: first sync now
    if (merging || st.S === prev.S) return
    clearTimeout(changeTm)
    changeTm = setTimeout(kick, AFTER_CHANGE_MS)
  })
  kick()
}

export function _resetCloudSync() { running = null; store = null; clearTimeout(pollTm); clearTimeout(changeTm); listeners.clear(); statusListeners.clear() }
