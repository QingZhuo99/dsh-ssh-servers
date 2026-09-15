/**
 * SSH transport for dsh-ssh-servers.
 *
 * The whole point of this module is the secret handoff: a password arrives as
 * a function argument, is handed to `ssh2` for one authentication round, and
 * is then unreachable. Nothing here writes a secret to disk, to a child
 * process argv, or to an environment variable — which is exactly what makes
 * "the agent cannot read the password" true rather than aspirational.
 *
 * Connections are long-lived and owned by the human's explicit action. The
 * agent never opens one; it can only use one that already exists.
 */

import { Client } from 'ssh2'

/** POSIX single-quote escaping for values interpolated into a remote command. */
export function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`
}

const DEFAULT_READY_TIMEOUT_MS = 20_000
const DEFAULT_EXEC_TIMEOUT_MS = 120_000
const MAX_CAPTURED_BYTES = 512 * 1024

/** One live, authenticated connection plus its bookkeeping. */
class Connection {
  constructor(profile, client) {
    this.profile = profile
    this.client = client
    this.connectedAt = Date.now()
    this.execCount = 0
  }

  /** Non-secret view for the UI and for tool output. */
  describe() {
    return {
      profileId: this.profile.id,
      label: this.profile.label,
      host: this.profile.host,
      port: this.profile.port,
      username: this.profile.username,
      remoteCwd: this.profile.remoteCwd,
      connectedAt: this.connectedAt,
      execCount: this.execCount,
    }
  }

  /**
   * Run one non-interactive command. `ssh2` has no cwd option, so a working
   * directory is expressed by prefixing a quoted `cd`.
   */
  exec(command, options = {}) {
    const cwd = typeof options.cwd === 'string' && options.cwd.length > 0 ? options.cwd : this.profile.remoteCwd
    const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : DEFAULT_EXEC_TIMEOUT_MS
    const full = cwd && cwd !== '.' ? `cd ${shellQuote(cwd)} && ${command}` : command

    return new Promise((resolve, reject) => {
      let settled = false
      const finish = (fn, value) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        fn(value)
      }

      const timer = setTimeout(() => {
        finish(reject, new Error(`remote command timed out after ${timeoutMs} ms`))
      }, timeoutMs)

      this.client.exec(full, (error, stream) => {
        if (error) {
          finish(reject, error)
          return
        }
        let stdout = ''
        let stderr = ''
        let truncated = false

        const append = (current, chunk) => {
          if (current.length >= MAX_CAPTURED_BYTES) {
            truncated = true
            return current
          }
          return current + chunk.toString('utf8')
        }

        stream.on('data', (chunk) => {
          stdout = append(stdout, chunk)
        })
        stream.stderr.on('data', (chunk) => {
          stderr = append(stderr, chunk)
        })
        stream.on('close', (code, signal) => {
          this.execCount += 1
          finish(resolve, {
            code: typeof code === 'number' ? code : null,
            signal: signal ?? null,
            stdout,
            stderr,
            truncated,
            cwd: cwd || '.',
          })
        })
        stream.on('error', (streamError) => {
          finish(reject, streamError)
        })
      })
    })
  }

  close() {
    try {
      this.client.end()
    } catch {
      // A socket already gone is the outcome we wanted anyway.
    }
  }
}

/**
 * Owns every live connection. One instance per mounted plugin row; disposal
 * closes everything it opened.
 */
export class SshManager {
  #connections = new Map()

  /** Non-secret snapshot of every live connection. */
  list() {
    return [...this.#connections.values()].map((connection) => connection.describe())
  }

  /** The live connection for one profile, or undefined. */
  get(profileId) {
    return this.#connections.get(profileId)
  }

  /**
   * Resolve "which server does this tool call mean". The argument accepts a
   * profile id or a saved profile's LABEL — the tool descriptions promise both,
   * and the label is what the human sees in the panel. With one connection the
   * argument is optional; with several it is required, so an ambiguous request
   * fails loudly instead of guessing.
   */
  resolve(profileId) {
    if (typeof profileId === 'string' && profileId.trim().length > 0) {
      const key = profileId.trim()
      const byId = this.#connections.get(key)
      if (byId !== undefined) return byId

      const byLabel = [...this.#connections.values()].filter((connection) => connection.profile.label === key)
      if (byLabel.length === 1) return byLabel[0]
      if (byLabel.length > 1) {
        const ids = byLabel.map((connection) => connection.profile.id).join(', ')
        throw new Error(`several open connections are named "${key}"; address one by its id instead: ${ids}`)
      }
      throw new Error(`no live connection for server "${key}". Ask the user to log in to it first.`)
    }
    if (this.#connections.size === 1) return [...this.#connections.values()][0]
    if (this.#connections.size === 0) {
      throw new Error('no SSH connection is open. The user must click Connect in the SSH panel before any remote work is possible.')
    }
    const ids = [...this.#connections.keys()].join(', ')
    throw new Error(`several connections are open (${ids}); pass an explicit "server" argument.`)
  }

  /**
   * Authenticate and hold a connection open.
   *
   * @param profile - non-secret saved profile.
   * @param secret - `{ password }` or `{ privateKey, passphrase }`, used once.
   * @param hooks - `onHostKey(fingerprint)` for trust-on-first-use.
   */
  async connect(profile, secret, hooks = {}) {
    this.disconnect(profile.id)
    const client = new Client()
    let learnedFingerprint

    await new Promise((resolve, reject) => {
      let settled = false
      const done = (fn, value) => {
        if (settled) return
        settled = true
        client.removeListener('ready', onReady)
        client.removeListener('error', onError)
        fn(value)
      }
      const onReady = () => done(resolve)
      const onError = (error) => done(reject, error)

      client.on('ready', onReady)
      client.on('error', onError)

      const options = {
        host: profile.host,
        port: profile.port,
        username: profile.username,
        readyTimeout: DEFAULT_READY_TIMEOUT_MS,
        keepaliveInterval: 15_000,
        keepaliveCountMax: 4,
        hostHash: 'sha256',
        hostVerifier: (fingerprint) => {
          // Trust on first use, pinned afterwards. A changed host key is a
          // hard refusal: it is the one signal that a server may not be the
          // server the human saved.
          if (profile.hostKeyFingerprint === undefined || profile.hostKeyFingerprint.length === 0) {
            learnedFingerprint = fingerprint
            return true
          }
          return profile.hostKeyFingerprint === fingerprint
        },
      }

      if (profile.authMode === 'key' && typeof secret.privateKey === 'string') {
        options.privateKey = secret.privateKey
        if (typeof secret.passphrase === 'string' && secret.passphrase.length > 0) {
          options.passphrase = secret.passphrase
        }
      } else {
        options.password = secret.password
        options.tryKeyboard = true
      }

      try {
        client.connect(options)
      } catch (error) {
        done(reject, error)
      }
    })

    // From here the secret is no longer referenced by this frame; `options`
    // goes out of scope with `secret` still owned by the caller's closure.
    const connection = new Connection(profile, client)
    this.#connections.set(profile.id, connection)

    if (typeof learnedFingerprint === 'string' && typeof hooks.onHostKey === 'function') {
      hooks.onHostKey(learnedFingerprint)
    }

    client.on('close', () => {
      const current = this.#connections.get(profile.id)
      if (current === connection) this.#connections.delete(profile.id)
    })

    return connection
  }

  /** Close one connection; closing an absent one is a no-op. */
  disconnect(profileId) {
    const existing = this.#connections.get(profileId)
    if (existing === undefined) return false
    this.#connections.delete(profileId)
    existing.close()
    return true
  }

  /** Close every connection this row owns. */
  dispose() {
    for (const connection of this.#connections.values()) connection.close()
    this.#connections.clear()
  }
}
