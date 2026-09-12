/**
 * Server-profile storage for dsh-ssh-servers.
 *
 * What is stored here is deliberately limited to NON-SECRET fields. A password
 * is never written, never cached, and never returned: it travels from the
 * human's browser to the Host inside one POST body, is used once for SSH
 * authentication, and is dropped. See `ssh.js` for that handoff.
 *
 * The store is a small JSON document under $DSH_HOME so it survives restarts
 * without touching any harness-owned file. Writes are atomic (temp + rename)
 * so a crash mid-write cannot leave a truncated profile list behind.
 */

import { createRequire } from 'node:module'
import { mkdirSync, readFileSync, renameSync, writeFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { randomUUID } from 'node:crypto'

const require = createRequire(import.meta.url)

/** Resolve the harness home the same way the rest of the product does. */
function harnessHome() {
  const fromEnv = process.env.DSH_HOME
  if (typeof fromEnv === 'string' && fromEnv.length > 0) return fromEnv
  return join(homedir(), '.dsh')
}

/** Absolute path of the profile document. */
export function storePath() {
  return join(harnessHome(), 'dsh-ssh-servers', 'profiles.json')
}

const EMPTY = Object.freeze({ version: 1, profiles: [] })

/** Fields a profile may carry. Anything else in the document is dropped. */
const TEXT_FIELDS = [
  'id',
  'label',
  'host',
  'username',
  'authMode',
  'privateKeyPath',
  'remoteCwd',
  'hostKeyFingerprint',
]

function coerceProfile(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const out = {}
  for (const field of TEXT_FIELDS) {
    const value = raw[field]
    if (typeof value === 'string') out[field] = value
  }
  const port = Number(raw.port)
  out.port = Number.isInteger(port) && port > 0 && port <= 65535 ? port : 22
  if (typeof out.id !== 'string' || out.id.length === 0) return undefined
  if (typeof out.host !== 'string' || out.host.length === 0) return undefined
  if (typeof out.username !== 'string' || out.username.length === 0) return undefined
  if (out.label === undefined || out.label.length === 0) out.label = out.host
  if (out.authMode !== 'password' && out.authMode !== 'key') out.authMode = 'password'
  if (out.remoteCwd === undefined || out.remoteCwd.length === 0) out.remoteCwd = '.'
  return out
}

/** Read the document, tolerating absence but not silent corruption. */
function readDocument() {
  const path = storePath()
  if (!existsSync(path)) return { ...EMPTY, profiles: [] }
  let text
  try {
    text = readFileSync(path, 'utf8')
  } catch {
    return { ...EMPTY, profiles: [] }
  }
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    // A document we cannot parse is reported, not overwritten: silently
    // starting from empty would look like "my servers vanished".
    throw new Error(`profile store is not valid JSON: ${path}`)
  }
  const list = Array.isArray(parsed?.profiles) ? parsed.profiles : []
  const profiles = []
  for (const entry of list) {
    const coerced = coerceProfile(entry)
    if (coerced !== undefined) profiles.push(coerced)
  }
  return { version: 1, profiles }
}

/** Atomically replace the document. */
function writeDocument(doc) {
  const path = storePath()
  mkdirSync(dirname(path), { recursive: true })
  const temp = `${path}.${process.pid}.tmp`
  writeFileSync(temp, `${JSON.stringify(doc, null, 2)}\n`, 'utf8')
  renameSync(temp, path)
}

/**
 * Server profiles the human has saved. Non-secret only; a password has no
 * field here by construction.
 */
export class ProfileStore {
  /** Every saved profile, secrets excluded. */
  list() {
    return readDocument().profiles
  }

  /** One profile by id, or undefined. */
  get(id) {
    return this.list().find((profile) => profile.id === id)
  }

  /** Insert or replace one profile; returns the stored record. */
  upsert(input) {
    const doc = readDocument()
    const candidate = coerceProfile({
      ...input,
      id: typeof input?.id === 'string' && input.id.length > 0 ? input.id : randomUUID(),
    })
    if (candidate === undefined) {
      throw new Error('a profile needs at least host and username')
    }
    const index = doc.profiles.findIndex((profile) => profile.id === candidate.id)
    if (index >= 0) doc.profiles[index] = { ...doc.profiles[index], ...candidate }
    else doc.profiles.push(candidate)
    writeDocument(doc)
    return doc.profiles.find((profile) => profile.id === candidate.id)
  }

  /** Remove one profile; removing an absent id is a no-op. */
  remove(id) {
    const doc = readDocument()
    const before = doc.profiles.length
    doc.profiles = doc.profiles.filter((profile) => profile.id !== id)
    if (doc.profiles.length !== before) writeDocument(doc)
    return before - doc.profiles.length
  }

  /**
   * Record the host key fingerprint learned on a first successful connection.
   * This is trust-on-first-use: the value is only ever written after a
   * connection the human explicitly initiated.
   */
  rememberHostKey(id, fingerprint) {
    const doc = readDocument()
    const profile = doc.profiles.find((entry) => entry.id === id)
    if (profile === undefined || profile.hostKeyFingerprint === fingerprint) return
    profile.hostKeyFingerprint = fingerprint
    writeDocument(doc)
  }
}

export { require }
