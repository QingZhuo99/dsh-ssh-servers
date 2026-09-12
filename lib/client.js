window.__ModuleLoader__.load({ id: 'dsh-ssh-servers', factory: (require) => {
  const module = { exports: {} }
  const exports = module.exports
  const React = require('react')
  const { useCallback, useEffect, useMemo, useState } = React

  const API = '/plugins/dsh-ssh-servers'
  const POLL_MS = 5000

  // ---------------------------------------------------------------- styling
  const barStyle = {
    display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap',
    padding: '6px 12px', fontSize: 12,
    border: '1px solid var(--border-color, #d8d8d8)', borderRadius: 10,
    background: 'var(--surface-color, transparent)',
  }
  const dotStyle = (live) => ({
    width: 8, height: 8, borderRadius: '50%', flex: '0 0 auto',
    background: live ? '#2ea043' : '#8b949e',
  })
  const buttonStyle = (primary) => ({
    padding: '5px 12px', borderRadius: 8, cursor: 'pointer', fontSize: 12,
    border: primary ? '1px solid transparent' : '1px solid var(--border-color, #d8d8d8)',
    background: primary ? '#2f81f7' : 'transparent',
    color: primary ? '#fff' : 'inherit',
  })
  const inputStyle = { padding: '5px 8px', borderRadius: 6, border: '1px solid var(--border-color, #d8d8d8)', background: 'transparent', color: 'inherit', fontSize: 12, width: '100%', boxSizing: 'border-box' }
  const cardStyle = {
    display: 'grid', gap: 10, padding: 14, marginTop: 8,
    border: '1px solid var(--border-color, #d8d8d8)', borderRadius: 12,
  }
  const fieldStyle = { display: 'grid', gap: 4 }
  const labelStyle = { fontWeight: 600, fontSize: 12 }
  const hintStyle = { opacity: 0.65, fontSize: 11 }
  const errorStyle = { color: '#f85149', fontSize: 12, whiteSpace: 'pre-wrap' }
  const monoStyle = { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 11, opacity: 0.75 }

  function Field({ label, hint, children }) {
    return React.createElement('label', { style: fieldStyle },
      React.createElement('span', { style: labelStyle }, label),
      hint ? React.createElement('span', { style: hintStyle }, hint) : null,
      children,
    )
  }

  // ------------------------------------------------------------------ state
  function useServerState() {
    const [state, setState] = useState({ profiles: [], connections: [], audit: [] })
    const [error, setError] = useState(null)
    const [loaded, setLoaded] = useState(false)

    const refresh = useCallback(async () => {
      try {
        const response = await fetch(`${API}/state`, { headers: { accept: 'application/json' } })
        if (!response.ok) throw new Error(`HTTP ${response.status}`)
        const data = await response.json()
        setState({
          profiles: Array.isArray(data.profiles) ? data.profiles : [],
          connections: Array.isArray(data.connections) ? data.connections : [],
          audit: Array.isArray(data.audit) ? data.audit : [],
        })
        setError(null)
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause))
      } finally {
        setLoaded(true)
      }
    }, [])

    useEffect(() => {
      let alive = true
      const tick = () => { if (alive) void refresh() }
      tick()
      const handle = setInterval(tick, POLL_MS)
      return () => { alive = false; clearInterval(handle) }
    }, [refresh])

    return { state, error, loaded, refresh }
  }

  async function post(path, body) {
    const response = await fetch(`${API}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body ?? {}),
    })
    let payload = {}
    try { payload = await response.json() } catch { /* an empty body is fine */ }
    if (!response.ok) throw new Error(payload.error || `HTTP ${response.status}`)
    return payload
  }

  // ---------------------------------------------------------- login surface
  //
  // This component is the ONLY place a connection can be created. The password
  // lives in this component's local state for as long as it takes to POST it,
  // and is cleared immediately afterwards. It is never written to storage and
  // never rendered back.
  function LoginPanel({ profiles, audit, onDone }) {
    const [selected, setSelected] = useState(profiles[0]?.id ?? '')
    const [password, setPassword] = useState('')
    const [busy, setBusy] = useState(false)
    const [error, setError] = useState(null)

    useEffect(() => {
      if (selected === '' && profiles.length > 0) setSelected(profiles[0].id)
      if (selected !== '' && !profiles.some((p) => p.id === selected)) setSelected(profiles[0]?.id ?? '')
    }, [profiles, selected])

    const profile = useMemo(() => profiles.find((p) => p.id === selected), [profiles, selected])

    const submit = async () => {
      if (profile === undefined) return
      setBusy(true)
      setError(null)
      try {
        await post('/connect', { profileId: profile.id, password })
        setPassword('')
        await onDone()
      } catch (cause) {
        setPassword('')
        setError(cause instanceof Error ? cause.message : String(cause))
      } finally {
        setBusy(false)
      }
    }

    if (profiles.length === 0) {
      return React.createElement('div', { style: cardStyle },
        React.createElement('div', { style: labelStyle }, '还没有保存任何服务器'),
        React.createElement('div', { style: hintStyle }, '请到「设置 → 插件 → SSH 服务器」里先添加一台。'),
      )
    }

    return React.createElement('div', { style: cardStyle },
      React.createElement(Field, { label: '服务器' },
        React.createElement('select', {
          style: inputStyle, value: selected, disabled: busy,
          onChange: (event) => setSelected(event.target.value),
        }, ...profiles.map((entry) =>
          React.createElement('option', { key: entry.id, value: entry.id },
            `${entry.label} — ${entry.username}@${entry.host}:${entry.port}`))),
      ),
      profile !== undefined
        ? React.createElement('div', { style: monoStyle }, `远程工作目录：${profile.remoteCwd}`)
        : null,
      React.createElement(Field, {
        label: '密码',
        hint: '只用于本次认证。不写盘、不进进程参数、不回传，认证完成后立即丢弃。',
      },
        React.createElement('input', {
          style: inputStyle, type: 'password', value: password, disabled: busy,
          autoComplete: 'off', placeholder: '仅本次登录使用',
          onChange: (event) => setPassword(event.target.value),
          onKeyDown: (event) => { if (event.key === 'Enter') void submit() },
        }),
      ),
      error !== null ? React.createElement('div', { style: errorStyle }, error) : null,
      React.createElement('div', { style: { display: 'flex', gap: 8, justifyContent: 'flex-end' } },
        React.createElement('button', { style: buttonStyle(false), disabled: busy, onClick: () => onDone() }, '取消'),
        React.createElement('button', { style: buttonStyle(true), disabled: busy || password.length === 0, onClick: () => void submit() },
          busy ? '登录中…' : '登录'),
      ),
      audit.length > 0
        ? React.createElement('div', null,
            React.createElement('div', { style: labelStyle }, '最近登录记录'),
            React.createElement('div', { style: { ...monoStyle, maxHeight: 96, overflow: 'auto', marginTop: 4 } },
              ...audit.slice(0, 6).map((entry, index) =>
                React.createElement('div', { key: index },
                  `${entry.at} ${entry.action} ${entry.label ?? entry.profileId ?? ''} → ${entry.result}`))),
          )
        : null,
    )
  }

  // ------------------------------------------------------------ status dock
  function StatusDock() {
    const { state, error, loaded, refresh } = useServerState()
    const [open, setOpen] = useState(false)
    const live = state.connections

    if (!loaded && error === null) return null
    if (error !== null && !loaded) {
      return React.createElement('div', { style: barStyle },
        React.createElement('span', { style: dotStyle(false) }),
        React.createElement('span', null, `SSH 面板不可用：${error}`),
      )
    }

    const summary = live.length === 0
      ? '未连接'
      : live.map((entry) => `${entry.label} (${entry.username}@${entry.host})`).join('，')

    return React.createElement('div', null,
      React.createElement('div', { style: barStyle },
        React.createElement('span', { style: dotStyle(live.length > 0) }),
        React.createElement('span', { style: { fontWeight: 600 } }, 'SSH'),
        React.createElement('span', { style: { opacity: 0.85 } }, summary),
        live.length > 0
          ? React.createElement('span', { style: monoStyle }, live.map((e) => e.remoteCwd).join(' | '))
          : null,
        React.createElement('span', { style: { flex: 1 } }),
        live.length === 0
          ? React.createElement('button', {
              style: buttonStyle(true),
              onClick: () => setOpen((value) => !value),
            }, open ? '收起' : '登录…')
          : React.createElement('button', {
              style: buttonStyle(false),
              onClick: async () => {
                for (const entry of live) {
                  try { await post('/disconnect', { profileId: entry.profileId }) } catch { /* keep going */ }
                }
                await refresh()
              },
            }, '全部断开'),
      ),
      open && live.length === 0
        ? React.createElement(LoginPanel, {
            profiles: state.profiles, audit: state.audit,
            onDone: async () => { await refresh(); setOpen(false) },
          })
        : null,
    )
  }

  // ----------------------------------------------------------- profile admin
  const BLANK = { label: '', host: '', port: 22, username: '', remoteCwd: '.', authMode: 'password' }

  function ProfileAdmin() {
    const { state, error, refresh } = useServerState()
    const [draft, setDraft] = useState(BLANK)
    const [message, setMessage] = useState(null)

    const edit = (key) => (event) => {
      const value = key === 'port' ? Number(event.target.value) || 22 : event.target.value
      setDraft((current) => ({ ...current, [key]: value }))
    }

    const save = async () => {
      setMessage(null)
      try {
        await post('/profiles', { action: 'upsert', profile: draft })
        setDraft(BLANK)
        setMessage('已保存')
        await refresh()
      } catch (cause) {
        setMessage(cause instanceof Error ? cause.message : String(cause))
      }
    }

    const remove = async (id) => {
      setMessage(null)
      try {
        await post('/profiles', { action: 'delete', profile: { id } })
        await refresh()
      } catch (cause) {
        setMessage(cause instanceof Error ? cause.message : String(cause))
      }
    }

    return React.createElement('div', { style: { display: 'grid', gap: 14 } },
      React.createElement('div', { style: hintStyle },
        '这里保存的是服务器地址、用户名和远程工作目录——都是非机密信息。密码不在其中：它只在每次登录时由你手动输入，认证完成后立即丢弃。'),
      error !== null ? React.createElement('div', { style: errorStyle }, error) : null,

      state.profiles.length > 0
        ? React.createElement('div', { style: { display: 'grid', gap: 8 } },
            ...state.profiles.map((profile) => {
              const connected = state.connections.some((entry) => entry.profileId === profile.id)
              return React.createElement('div', {
                key: profile.id,
                style: { display: 'flex', alignItems: 'center', gap: 10, padding: '8px 10px', border: '1px solid var(--border-color, #d8d8d8)', borderRadius: 10 },
              },
                React.createElement('span', { style: dotStyle(connected) }),
                React.createElement('span', { style: { flex: 1 } },
                  React.createElement('span', { style: { fontWeight: 600 } }, profile.label),
                  React.createElement('span', { style: { ...monoStyle, marginLeft: 8 } },
                    `${profile.username}@${profile.host}:${profile.port}  ${profile.remoteCwd}`),
                ),
                React.createElement('button', { style: buttonStyle(false), onClick: () => setDraft({ ...profile }) }, '编辑'),
                React.createElement('button', { style: buttonStyle(false), onClick: () => void remove(profile.id) }, '删除'),
              )
            }),
          )
        : React.createElement('div', { style: hintStyle }, '还没有服务器。在下面添加第一台。'),

      React.createElement('div', { style: cardStyle },
        React.createElement('div', { style: labelStyle }, draft.id ? '编辑服务器' : '添加服务器'),
        React.createElement(Field, { label: '名称' },
          React.createElement('input', { style: inputStyle, value: draft.label, onChange: edit('label'), placeholder: '例如 计算节点' })),
        React.createElement('div', { style: { display: 'grid', gridTemplateColumns: '2fr 1fr', gap: 10 } },
          React.createElement(Field, { label: '地址' },
            React.createElement('input', { style: inputStyle, value: draft.host, onChange: edit('host'), placeholder: '192.168.1.10 或 host.example.com' })),
          React.createElement(Field, { label: '端口' },
            React.createElement('input', { style: inputStyle, type: 'number', value: draft.port, onChange: edit('port') })),
        ),
        React.createElement(Field, { label: '用户名' },
          React.createElement('input', { style: inputStyle, value: draft.username, onChange: edit('username') })),
        React.createElement(Field, { label: '远程工作目录', hint: 'agent 的 ssh_* 工具默认在这个目录下执行。' },
          React.createElement('input', { style: inputStyle, value: draft.remoteCwd, onChange: edit('remoteCwd'), placeholder: '/home/user/project' })),
        message !== null ? React.createElement('div', { style: hintStyle }, message) : null,
        React.createElement('div', { style: { display: 'flex', gap: 8, justifyContent: 'flex-end' } },
          draft.id ? React.createElement('button', { style: buttonStyle(false), onClick: () => setDraft(BLANK) }, '取消编辑') : null,
          React.createElement('button', { style: buttonStyle(true), disabled: draft.host.length === 0 || draft.username.length === 0, onClick: () => void save() }, '保存'),
        ),
      ),
    )
  }

  // ------------------------------------------------------------------ mount
  function apply(ctx) {
    // Each registration is guarded on its own: a slot-contract change must
    // degrade this panel, never the whole WebUI load.
    try {
      ctx.slots.inject('conversation.input.dock', () => {
        try {
          ctx.slots.register({ name: 'conversation.input.dock', id: 'dsh-ssh-servers', order: 40 }, StatusDock)
        } catch (cause) {
          if (typeof console !== 'undefined' && console.error) console.error('[dsh-ssh-servers] dock registration failed:', cause)
        }
      })
    } catch (cause) {
      if (typeof console !== 'undefined' && console.error) console.error('[dsh-ssh-servers] dock inject failed:', cause)
    }

    try {
      ctx.slots.inject('settings.plugins.tab', () => {
        try {
          ctx.slots.register({
            name: 'settings.plugins.tab', id: 'dsh-ssh-servers', order: 40,
            label: 'SSH 服务器',
            inject: () => ({}),
          }, ProfileAdmin)
        } catch (cause) {
          if (typeof console !== 'undefined' && console.error) console.error('[dsh-ssh-servers] settings registration failed:', cause)
        }
      })
    } catch (cause) {
      if (typeof console !== 'undefined' && console.error) console.error('[dsh-ssh-servers] settings inject failed:', cause)
    }
  }

  module.exports = {
    name: 'dsh-ssh-servers-client',
    inject: ['slots'],
    apply,
  }
  return module.exports
} })
