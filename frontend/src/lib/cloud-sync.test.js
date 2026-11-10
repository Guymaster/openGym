import { describe, it, expect } from 'vitest'
import { syncOnce, fileUrl, folderUrl, testConnection, KOOFR_URL, CloudError } from './cloud-sync.js'
import { mergeStates } from './sync-merge.js'

// A WebDAV drive in memory: files with ETags, folders, and the conditions syncOnce sends.
function fakeDrive({ password = 'pw', etags = true } = {}) {
  const files = new Map()
  const dirs = new Set([KOOFR_URL])
  let n = 0
  const log = []
  const dirOf = url => url.slice(0, url.lastIndexOf('/'))
  const request = async ({ url, method, headers = {}, body }) => {
    log.push(method)
    if (headers.Authorization !== 'Basic ' + btoa('me@example.com:' + password)) return { status: 401, headers: {}, text: '' }
    const f = files.get(url)
    if (method === 'GET') return f ? { status: 200, headers: etags ? { ETag: f.etag } : {}, text: f.body } : { status: 404, headers: {}, text: '' }
    if (method === 'PROPFIND') return { status: 207, headers: {}, text: '' }
    if (method === 'MKCOL') { dirs.add(url); return { status: 201, headers: {}, text: '' } }
    if (method === 'PUT') {
      if (!dirs.has(dirOf(url))) return { status: 409, headers: {}, text: '' }
      if (headers['If-Match'] && (!f || f.etag !== headers['If-Match'])) return { status: 412, headers: {}, text: '' }
      if (headers['If-None-Match'] === '*' && f) return { status: 412, headers: {}, text: '' }
      files.set(url, { body, etag: `"e${++n}"` })
      return { status: 201, headers: {}, text: '' }
    }
    return { status: 405, headers: {}, text: '' }
  }
  return { request, files, log, write: (url, S) => { dirs.add(dirOf(url)); files.set(url, { body: JSON.stringify(S), etag: `"e${++n}"` }) } }
}

const conf = { enabled: true, url: KOOFR_URL, user: 'me@example.com', folder: 'openGym' }

// A device: its copy, and the store's cloudMerge reduced to the merge itself.
function device(S) {
  const d = { S }
  d.local = () => d.S
  d.merge = remote => { d.S = mergeStates(d.S, remote); return d.S }
  return d
}
const hist = (id, ts) => ({ id, date: '2026-11-0' + id, _ts: ts, entries: [] })

describe('cloud-sync paths', () => {
  it('builds the Koofr file address, encoding the folder', () => {
    expect(folderUrl(conf)).toBe('https://app.koofr.net/dav/Koofr/openGym')
    expect(fileUrl({ ...conf, folder: '/Mes données/gym/' })).toBe('https://app.koofr.net/dav/Koofr/Mes%20donn%C3%A9es/gym/opengym-sync.json')
    expect(fileUrl({ ...conf, folder: '' })).toBe('https://app.koofr.net/dav/Koofr/opengym-sync.json')
  })
})

describe('syncOnce', () => {
  it('creates the folder and the file on the first sync', async () => {
    const drive = fakeDrive()
    const phone = device({ _ts: 1, workouts: [hist(1, 1)] })
    const r = await syncOnce({ conf, password: 'pw', local: phone.local, merge: phone.merge, request: drive.request })
    expect(r).toEqual({ wrote: true, read: false })
    expect(drive.log).toEqual(['GET', 'PUT', 'MKCOL', 'PUT'])
    expect(JSON.parse(drive.files.get(fileUrl(conf)).body).workouts).toHaveLength(1)
  })

  it('brings a phone workout to the tablet and a tablet workout to the phone', async () => {
    const drive = fakeDrive()
    const phone = device({ _ts: 10, workouts: [hist(1, 10)] })
    const tablet = device({ _ts: 20, workouts: [hist(2, 20)] })
    const run = d => syncOnce({ conf, password: 'pw', local: d.local, merge: d.merge, request: drive.request })
    await run(phone)
    await run(tablet)
    await run(phone)
    const ids = d => d.S.workouts.map(w => w.id).sort()
    expect(ids(phone)).toEqual([1, 2])
    expect(ids(tablet)).toEqual([1, 2])
  })

  it('does not write when the file already holds everything', async () => {
    const drive = fakeDrive()
    const phone = device({ _ts: 10, workouts: [hist(1, 10)] })
    await syncOnce({ conf, password: 'pw', local: phone.local, merge: phone.merge, request: drive.request })
    drive.log.length = 0
    const r = await syncOnce({ conf, password: 'pw', local: phone.local, merge: phone.merge, request: drive.request })
    expect(r.wrote).toBe(false)
    expect(drive.log).toEqual(['GET'])
  })

  it('reads again when another device wrote between the read and the write', async () => {
    const drive = fakeDrive()
    const url = fileUrl(conf)
    drive.write(url, { _ts: 5, workouts: [hist(1, 5)] })
    const phone = device({ _ts: 10, workouts: [hist(2, 10)] })
    let sneaked = false
    const request = async req => {
      if (req.method === 'PUT' && !sneaked) { sneaked = true; drive.write(url, { _ts: 6, workouts: [hist(1, 5), hist(3, 6)] }) }
      return drive.request(req)
    }
    await syncOnce({ conf, password: 'pw', local: phone.local, merge: phone.merge, request })
    const saved = JSON.parse(drive.files.get(url).body)
    expect(saved.workouts.map(w => w.id).sort()).toEqual([1, 2, 3])
  })

  it('works with a drive that gives no ETag', async () => {
    const drive = fakeDrive({ etags: false })
    const a = device({ _ts: 1, workouts: [hist(1, 1)] })
    const b = device({ _ts: 2, workouts: [hist(2, 2)] })
    await syncOnce({ conf, password: 'pw', local: a.local, merge: a.merge, request: drive.request })
    await syncOnce({ conf, password: 'pw', local: b.local, merge: b.merge, request: drive.request })
    expect(b.S.workouts).toHaveLength(2)
  })

  it('says so when the login is refused', async () => {
    const drive = fakeDrive()
    const phone = device({ _ts: 1 })
    await expect(syncOnce({ conf, password: 'wrong', local: phone.local, merge: phone.merge, request: drive.request }))
      .rejects.toMatchObject({ code: 'auth' })
    await expect(testConnection({ conf, password: 'wrong', request: drive.request })).rejects.toBeInstanceOf(CloudError)
    await expect(testConnection({ conf, password: 'pw', request: drive.request })).resolves.toBe(true)
  })

  it('refuses a file that is not JSON rather than overwrite it', async () => {
    const drive = fakeDrive()
    drive.files.set(fileUrl(conf), { body: 'not json', etag: '"x"' })
    const phone = device({ _ts: 1 })
    await expect(syncOnce({ conf, password: 'pw', local: phone.local, merge: phone.merge, request: drive.request }))
      .rejects.toMatchObject({ code: 'corrupt' })
    expect(drive.files.get(fileUrl(conf)).body).toBe('not json')
  })
})
