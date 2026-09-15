/**
 * dsh-ssh-servers — human-gated SSH connections for DeepSeek Harness.
 *
 * Three ideas, and the third is the one that shapes the code:
 *
 *   1. The human saves server profiles (address, port, username, remote
 *      working directory). Secrets are not part of a profile.
 *   2. The agent gets a remote workspace: `ssh_*` tools that run against the
 *      saved remote directory.
 *   3. ONLY THE HUMAN CONNECTS. There is deliberately no `ssh_connect` tool —
 *      a connection is created exclusively from the browser panel, with a
 *      password the agent never sees. The agent's tools can only use a
 *      connection that already exists, and they fail loudly when none does.
 *
 * Why that is stronger than "hiding the button": the agent holds a shell
 * tool, so it can POST to any loopback HTTP route this row registers. What it
 * cannot do is invent the password. The password travels browser → Host in
 * one POST body, is used for a single SSH authentication round, and is
 * dropped; it is never persisted, never placed in a child process argument
 * vector, and never returned to any caller. Removing that secret is what
 * makes the gate real.
 *
 * Residual risk, stated plainly: anyone who can read the Host process's
 * memory, or who already knows the password, is outside this boundary. Every
 * connect/disconnect attempt is recorded and surfaced in the panel so a human
 * can see one they did not make.
 */

import { ProfileStore } from './store.js'
import { SshManager, shellQuote } from './ssh.js'

export const name = 'dsh-ssh-servers'

/**
 * `tools` is a hard dependency: the row exists to give the agent its remote
 * workspace tools. `webServer` is optional on purpose — the row must still
 * mount in a headless profile, where there is simply no browser to log in
 * from.
 */
export const inject = ['tools']

const ROUTE_PREFIX = '/plugins/dsh-ssh-servers'
const MAX_BODY_BYTES = 64 * 1024
const MAX_AUDIT_ENTRIES = 50

/**
 * The browser API surface. A path absent from this table is answered with 404
 * rather than a method error, so a typo reads as a typo. The null prototype
 * keeps inherited keys such as `__proto__` from masquerading as routes.
 */
const KNOWN_ROUTES = Object.freeze(
  Object.assign(Object.create(null), {
    '/state': 'GET',
    '/profiles': 'POST',
    '/connect': 'POST',
    '/disconnect': 'POST',
  }),
)

/** Render one canonical string value as model-facing text. */
function textResult(value) {
  return [{ type: 'text', text: String(value) }]
}

/**
 * Build a registry-ready ToolDefinition from a raw JSON Schema.
 *
 * Hand-written rather than compiled through `defineTool` so this row depends
 * on nothing but `ssh2`; the shape is the documented `ToolDefinition`
 * contract (`parameters` as JSON Schema, `output.schema` + `output.render`).
 */
function defineTextTool({ name: toolName, description, parameters, execute }) {
  return {
    name: toolName,
    description,
    parameters,
    output: {
      schema: { type: 'string' },
      render: (_args, value) => textResult(value),
    },
    execute,
  }
}

function jsonResponse(res, status, body) {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(payload),
  })
  res.end(payload)
}

function isLoopback(address) {
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1'
}

async function readJsonBody(req) {
  const chunks = []
  let bytes = 0
  for await (const chunk of req) {
    bytes += chunk.length
    if (bytes > MAX_BODY_BYTES) throw new Error('request body is too large')
    chunks.push(chunk)
  }
  if (bytes === 0) return {}
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

/** Format one command outcome for the model. */
function formatExecResult(result, label) {
  const lines = [`[${label}] exit=${result.code ?? 'n/a'} cwd=${result.cwd}`]
  if (result.stdout.length > 0) lines.push('--- stdout ---', result.stdout.replace(/\s+$/, ''))
  if (result.stderr.length > 0) lines.push('--- stderr ---', result.stderr.replace(/\s+$/, ''))
  if (result.stdout.length === 0 && result.stderr.length === 0) lines.push('(no output)')
  if (result.truncated) lines.push('(output truncated at the capture limit)')
  return lines.join('\n')
}

export function apply(ctx) {
  const store = new ProfileStore()
  const manager = new SshManager()

  /** Recent connect/disconnect attempts, newest first. Secrets excluded. */
  const audit = []
  const record = (entry) => {
    audit.unshift({ at: new Date().toISOString(), ...entry })
    if (audit.length > MAX_AUDIT_ENTRIES) audit.length = MAX_AUDIT_ENTRIES
  }

  ctx.effect(() => () => manager.dispose(), 'dsh-ssh-servers: close connections')

  // ---------------------------------------------------------------- HTTP API
  // The browser panel is the only place a connection can be created. The
  // agent can reach these routes too; it just cannot supply the password.
  //
  // Registered through a SCOPED injection rather than a one-shot `ctx.get`
  // read. This row injects only `tools`, and Cordis activates rows by service
  // availability rather than by row order: `tools` is ready long before
  // `webServer`, whose own row waits on `webStartup`. Reading the service once
  // in `apply` therefore saw `undefined` and skipped this whole block, leaving
  // the panel no route to call. `ctx.inject` runs the callback when the service
  // arrives and re-runs it when the service changes; a profile with no web
  // server at all never runs this child fiber, so the agent tools below still
  // mount headless.
  ctx.inject(['webServer'], (scope) => {
    const webServer = scope.get('webServer')
    if (webServer === undefined) return

    const handler = async (req, res) => {
      if (!isLoopback(req.socket?.remoteAddress)) {
        jsonResponse(res, 403, { error: 'local access only' })
        return
      }
      const origin = req.headers?.origin
      if (origin !== undefined) {
        let originHost
        try {
          originHost = new URL(origin).host
        } catch {
          originHost = undefined
        }
        if (originHost === undefined || originHost !== req.headers.host) {
          jsonResponse(res, 403, { error: 'origin mismatch' })
          return
        }
      }

      const url = new URL(req.url ?? '/', 'http://localhost')
      const route = url.pathname.slice(ROUTE_PREFIX.length) || '/'

      try {
        const expectedMethod = KNOWN_ROUTES[route]
        if (expectedMethod === undefined) {
          jsonResponse(res, 404, { error: 'unknown route' })
          return
        }
        if (req.method !== expectedMethod) {
          jsonResponse(res, 405, { error: `method not allowed; ${route} expects ${expectedMethod}` })
          return
        }

        if (route === '/state') {
          jsonResponse(res, 200, {
            profiles: store.list(),
            connections: manager.list(),
            audit,
          })
          return
        }

        if (route === '/profiles') {
          const body = await readJsonBody(req)
          if (body.action === 'delete') {
            store.remove(String(body.profile?.id ?? body.id ?? ''))
          } else {
            store.upsert(body.profile ?? body)
          }
          jsonResponse(res, 200, { profiles: store.list() })
          return
        }

        if (route === '/connect') {
          const body = await readJsonBody(req)
          const profileId = String(body.profileId ?? '')
          const profile = store.get(profileId)
          if (profile === undefined) {
            jsonResponse(res, 404, { error: `unknown server "${profileId}"` })
            return
          }

          // Assemble the secret exactly once, hand it to the transport, then
          // drop every reference this frame holds.
          const secret = {
            password: typeof body.password === 'string' ? body.password : undefined,
            privateKey: typeof body.privateKey === 'string' ? body.privateKey : undefined,
            passphrase: typeof body.passphrase === 'string' ? body.passphrase : undefined,
          }
          body.password = undefined
          body.privateKey = undefined
          body.passphrase = undefined

          if (secret.password === undefined && secret.privateKey === undefined) {
            record({ profileId, action: 'connect', result: 'rejected: no credential supplied' })
            jsonResponse(res, 400, { error: 'a password or a private key is required' })
            return
          }

          try {
            await manager.connect(profile, secret, {
              onHostKey: (fingerprint) => store.rememberHostKey(profile.id, fingerprint),
            })
            secret.password = undefined
            secret.privateKey = undefined
            secret.passphrase = undefined
            record({ profileId, action: 'connect', result: 'ok', label: profile.label })
            jsonResponse(res, 200, { connections: manager.list() })
          } catch (error) {
            secret.password = undefined
            secret.privateKey = undefined
            secret.passphrase = undefined
            const message = error instanceof Error ? error.message : String(error)
            record({ profileId, action: 'connect', result: `failed: ${message}`, label: profile.label })
            jsonResponse(res, 400, { error: message })
          }
          return
        }

        if (route === '/disconnect') {
          const body = await readJsonBody(req)
          const profileId = String(body.profileId ?? '')
          const closed = manager.disconnect(profileId)
          record({ profileId, action: 'disconnect', result: closed ? 'ok' : 'no live connection' })
          jsonResponse(res, 200, { connections: manager.list() })
          return
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        jsonResponse(res, 400, { error: message })
      }
    }

    // /plugins also serves browser bundles. Claim only API endpoints so the
    // host bundle route can still serve this plugin's client.js and source map.
    for (const route of Object.keys(KNOWN_ROUTES)) {
      scope.effect(
        () => webServer.register({ kind: 'exact', path: `${ROUTE_PREFIX}${route}`, handler }),
        `dsh-ssh-servers: browser API ${route}`,
      )
    }
  })

  // ------------------------------------------------------------ Model tools
  // Note what is absent: there is no tool that opens a connection.
  const serverParam = {
    type: 'string',
    description: '服务器 id 或名称。只开了一条连接时可省略；开了多条时必须指定。',
  }

  ctx.effect(
    () =>
      ctx.tools.register(
        defineTextTool({
          name: 'ssh_status',
          description:
            '查看当前有哪些 SSH 连接是打开的，以及每条连接的远程工作目录和执行次数。这是只读操作：它不会、也无法建立连接。要建立连接必须由使用者在 SSH 面板上手动点击登录。',
          parameters: { type: 'object', properties: {}, required: [], additionalProperties: false },
          async execute() {
            const connections = manager.list()
            const profiles = store.list()
            const lines = []
            if (profiles.length === 0) {
              lines.push('尚未保存任何服务器。请让使用者在 SSH 面板中添加。')
            } else {
              lines.push(`已保存 ${profiles.length} 台服务器：`)
              for (const profile of profiles) {
                const live = connections.some((entry) => entry.profileId === profile.id)
                lines.push(
                  `  - ${profile.label} (id=${profile.id}) ${profile.username}@${profile.host}:${profile.port} ` +
                    `工作目录=${profile.remoteCwd} 状态=${live ? '已连接' : '未连接'}`,
                )
              }
            }
            lines.push('')
            if (connections.length === 0) {
              lines.push('当前没有任何打开的连接。使用者点击登录后才能执行远程命令。')
            } else {
              lines.push('当前打开的连接：')
              for (const connection of connections) {
                lines.push(
                  `  - ${connection.label} (id=${connection.profileId}) ${connection.username}@${connection.host} ` +
                    `工作目录=${connection.remoteCwd} 已执行 ${connection.execCount} 条命令`,
                )
              }
              if (connections.length > 1) {
                lines.push('')
                lines.push(
                  '同时打开了多条连接：调用 ssh_exec / ssh_read_file / ssh_write_file / ssh_list_dir 时' +
                    '必须带 server 参数，取值可以是上面的名称或 id。',
                )
              }
            }
            return lines.join('\n')
          },
        }),
      ),
    'dsh-ssh-servers: ssh_status',
  )

  ctx.effect(
    () =>
      ctx.tools.register(
        defineTextTool({
          name: 'ssh_exec',
          description:
            '在已连接的服务器上执行一条非交互式命令，返回退出码、stdout 和 stderr。命令默认在使用者设定的远程工作目录中执行。注意：这里没有 TTY，需要终端交互的命令（sudo 提示、top、vim 等）无法正常工作。若尚未连接，本工具会失败并提示使用者先登录。',
          parameters: {
            type: 'object',
            properties: {
              command: { type: 'string', description: '要在远程执行的 shell 命令。' },
              server: serverParam,
              cwd: { type: 'string', description: '临时覆盖工作目录（绝对路径或相对家目录）。' },
              timeoutMs: { type: 'integer', description: '超时毫秒数，默认 120000。' },
            },
            required: ['command'],
            additionalProperties: false,
          },
          async execute(args) {
            const connection = manager.resolve(args.server)
            const result = await connection.exec(String(args.command), {
              cwd: typeof args.cwd === 'string' ? args.cwd : undefined,
              timeoutMs: Number.isFinite(args.timeoutMs) ? Number(args.timeoutMs) : undefined,
            })
            return formatExecResult(result, connection.profile.label)
          },
        }),
      ),
    'dsh-ssh-servers: ssh_exec',
  )

  ctx.effect(
    () =>
      ctx.tools.register(
        defineTextTool({
          name: 'ssh_read_file',
          description:
            '读取远程服务器上的一个文本文件。路径相对于工作目录，也可以是绝对路径。这是本机 read 工具的远程对应物：本机 read 读到的是你本地磁盘，要读服务器上的文件必须用这个工具。',
          parameters: {
            type: 'object',
            properties: {
              path: { type: 'string', description: '远程文件路径。' },
              server: serverParam,
            },
            required: ['path'],
            additionalProperties: false,
          },
          async execute(args) {
            const connection = manager.resolve(args.server)
            const result = await connection.exec(`cat -- ${shellQuote(String(args.path))}`)
            if (result.code !== 0) {
              throw new Error(`读取失败（exit=${result.code}）：${result.stderr.trim() || result.stdout.trim()}`)
            }
            return result.stdout
          },
        }),
      ),
    'dsh-ssh-servers: ssh_read_file',
  )

  ctx.effect(
    () =>
      ctx.tools.register(
        defineTextTool({
          name: 'ssh_write_file',
          description:
            '把文本内容写入远程服务器上的文件（覆盖已有内容）。内容以 base64 传输，因此不必担心引号或换行被 shell 改写。父目录必须已存在。',
          parameters: {
            type: 'object',
            properties: {
              path: { type: 'string', description: '远程文件路径。' },
              content: { type: 'string', description: '要写入的完整文本内容。' },
              server: serverParam,
            },
            required: ['path', 'content'],
            additionalProperties: false,
          },
          async execute(args) {
            const connection = manager.resolve(args.server)
            const encoded = Buffer.from(String(args.content), 'utf8').toString('base64')
            const target = shellQuote(String(args.path))
            const command =
              `printf %s ${shellQuote(encoded)} | base64 -d > ${target} 2>/dev/null ` +
              `|| printf %s ${shellQuote(encoded)} | base64 -D > ${target}`
            const result = await connection.exec(command)
            if (result.code !== 0) {
              throw new Error(`写入失败（exit=${result.code}）：${result.stderr.trim() || result.stdout.trim()}`)
            }
            return `已写入 ${args.path}（${Buffer.byteLength(String(args.content), 'utf8')} 字节）`
          },
        }),
      ),
    'dsh-ssh-servers: ssh_write_file',
  )

  ctx.effect(
    () =>
      ctx.tools.register(
        defineTextTool({
          name: 'ssh_list_dir',
          description:
            '列出远程服务器上某个目录的内容。路径相对于工作目录，也可以是绝对路径。这是本机 glob 工具的远程对应物。',
          parameters: {
            type: 'object',
            properties: {
              path: { type: 'string', description: '远程目录路径，默认当前工作目录。' },
              server: serverParam,
            },
            required: [],
            additionalProperties: false,
          },
          async execute(args) {
            const connection = manager.resolve(args.server)
            const target = typeof args.path === 'string' && args.path.length > 0 ? String(args.path) : '.'
            const result = await connection.exec(`ls -la -- ${shellQuote(target)}`)
            if (result.code !== 0) {
              throw new Error(`列目录失败（exit=${result.code}）：${result.stderr.trim() || result.stdout.trim()}`)
            }
            return result.stdout
          },
        }),
      ),
    'dsh-ssh-servers: ssh_list_dir',
  )
}
