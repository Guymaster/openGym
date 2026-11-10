import { useEffect, useState } from 'react'
import { t } from '../lib/i18n.js'
import { useUI } from '../store/useUI.js'
import { Section, Row, Button } from './ui.jsx'
import {
  readConfig, writeConfig, onConfigChange, getPassword, setPassword, forgetCloud,
  testConnection, syncNow, syncStatus, onSyncStatus, KOOFR_URL, CloudError
} from '../lib/cloud-sync.js'

/* Settings → Data & backup → "Sync with a cloud folder" (lib/cloud-sync.js): the phone and the
   tablet share one file in a WebDAV folder (Koofr by default) instead of a server. */

const field = { autoCapitalize: 'none', autoCorrect: 'off', spellCheck: false }
const errStyle = { color: 'var(--red)', marginTop: 8 }

export function cloudErrorText(code) {
  return code === 'auth' ? t('The login was refused. Check the e-mail and the app password.')
    : code === 'corrupt' ? t('The sync file in the folder is damaged. Move it away to start a new one.')
    : code === 'busy' ? t('Another device kept writing at the same time. It will try again shortly.')
    : code === 'http' ? t('The cloud answered with an error. Check the address and the folder.')
    : t('The cloud could not be reached. It will try again when you are online.')
}

function useCloudConfig() {
  const [conf, setConf] = useState(readConfig)
  const [busy, setBusy] = useState(syncStatus)
  useEffect(() => {
    const a = onConfigChange(setConf)
    const b = onSyncStatus(setBusy)
    return () => { a(); b() }
  }, [])
  return [conf, busy]
}

function CloudSetupSheet({ close }) {
  const start = readConfig()
  const [url, setUrl] = useState(start.url || KOOFR_URL)
  const [user, setUser] = useState(start.user || '')
  const [pass, setPass] = useState('')
  const [folder, setFolder] = useState(start.folder || 'openGym')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState(null)
  useEffect(() => { getPassword().then(p => { if (p) setPass(p) }).catch(() => {}) }, [])

  const submit = async ev => {
    ev.preventDefault()
    if (busy) return
    const conf = { url: url.trim().replace(/\/+$/, ''), user: user.trim(), folder: folder.trim() }
    if (!/^https:\/\//i.test(conf.url)) { setErr(t('The address must start with https://')); return }
    if (!conf.user || !pass) { setErr(t('Enter the e-mail and the app password.')); return }
    setBusy(true); setErr(null)
    try {
      await testConnection({ conf, password: pass })
      await setPassword(pass)
      writeConfig({ ...conf, enabled: true, lastError: '' })
      close()
      const r = await syncNow()
      useUI.getState().toast(r?.error ? cloudErrorText(r.error) : t('Cloud sync is on.'))
    } catch (e) {
      setErr(cloudErrorText(e instanceof CloudError ? e.code : 'network'))
    } finally { setBusy(false) }
  }

  return <>
    <h3>{t('Sync with a cloud folder')}</h3>
    <div className="muted small" style={{ marginBottom: 14 }}>
      {t('Every device with the same folder gets the same data. In Koofr, create an app password under Preferences → Passwords and paste it here.')}
    </div>
    <form onSubmit={submit} noValidate>
      <input className="input" name="webdav-url" placeholder={t('WebDAV address')} value={url} onChange={e => setUrl(e.target.value)} {...field} />
      <div style={{ height: 10 }} />
      <input className="input" name="username" type="email" autoComplete="username" placeholder={t('E-mail')} value={user} onChange={e => setUser(e.target.value)} {...field} />
      <div style={{ height: 10 }} />
      <input className="input" name="password" type="password" autoComplete="current-password" placeholder={t('App password')} value={pass} onChange={e => setPass(e.target.value)} />
      <div style={{ height: 10 }} />
      <input className="input" name="folder" placeholder={t('Folder')} value={folder} onChange={e => setFolder(e.target.value)} {...field} />
      <div className="dim small" style={{ marginTop: 6 }}>{t('Use the same address, e-mail and folder on every device.')}</div>
      {err && <div className="small" role="alert" style={errStyle}>{err}</div>}
      <div style={{ height: 12 }} />
      <Button type="submit" variant="primary" disabled={busy}>{busy ? t('Checking…') : t('Connect and sync')}</Button>
    </form>
  </>
}
export const openCloudSetup = () => useUI.getState().openSheet(close => <CloudSetupSheet close={close} />)

const fmtTime = ms => new Date(ms).toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short' })

export function CloudSyncSection() {
  const [conf, busy] = useCloudConfig()
  const on = conf.enabled && conf.user
  const turnOff = async () => {
    await forgetCloud()
    useUI.getState().toast(t('Cloud sync is off. The data stays on this device and in the folder.'))
  }
  const now = async () => {
    const r = await syncNow()
    useUI.getState().toast(r?.error ? cloudErrorText(r.error) : t('Synced.'))
  }
  return <Section title={t('Sync with a cloud folder')}
    footer={on ? null : t('Koofr, Nextcloud or any WebDAV drive. Your phone and your tablet then share the same workouts, without a server.')}>
    {on ? <>
      <Row icon="cloud" iconTint="var(--indigo)" title={conf.folder ? `${conf.user} · ${conf.folder}` : conf.user}
        subtitle={busy ? t('Syncing…') : conf.lastError ? cloudErrorText(conf.lastError) : conf.last ? t('Last sync: {0}', fmtTime(conf.last)) : t('Not synced yet')}
        accessory="chevron" onClick={openCloudSetup} />
      <Row icon="reset" iconTint="var(--blue)" title={t('Sync now')} onClick={now} />
      <Row icon="cloudSlash" iconTint="var(--red)" title={t('Turn off cloud sync')} danger onClick={turnOff} />
    </> : <Row icon="cloud" iconTint="var(--indigo)" title={t('Set up Koofr sync')} subtitle={t('Or another WebDAV drive')} accessory="chevron" onClick={openCloudSetup} />}
  </Section>
}
