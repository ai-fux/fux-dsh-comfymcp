/* global window, document */
/**
 * dsh-comfymcp-client · Client 半区
 *
 * - settings.section：ComfyUI MCP 服务配置（DSH 设置页风格，theme tokens）
 * - tool.call.toolview（keyed comfymcp_run_workflow / comfymcp_fetch_artifacts）：运行产物卡
 *
 * 样式遵循 harness kit：28px 控件、8px 圆角、tonal 填充、悬停才显边框；
 * 颜色只用 `--dsw-alias-*` 主题令牌（自动适配亮/暗主题）。
 */
if (typeof window !== 'undefined' && window.__ModuleLoader__ !== undefined) {
  window.__ModuleLoader__.load({
    id: 'dsh-comfymcp-client',
    factory(require) {
      var react = require('react')
      var h = react.createElement

      // ─── 主题令牌（与 @deepseek-ai/dsh-client-ui-theme 公开的 13 个对齐） ───
      var T = {
        text: 'var(--dsw-alias-label-primary, inherit)',
        textSecondary: 'var(--dsw-alias-label-secondary, inherit)',
        surface: 'var(--dsw-alias-bg-layer-1, rgba(127,127,127,.08))',
        surface2: 'var(--dsw-alias-bg-layer-2, rgba(127,127,127,.12))',
        base: 'var(--dsw-alias-bg-base, transparent)',
        overlay: 'var(--dsw-alias-bg-overlay, Canvas)',
        border: 'var(--dsw-alias-border-l1, rgba(127,127,127,.3))',
        borderStrong: 'var(--dsw-alias-border-l2, rgba(127,127,127,.5))',
        brand: 'var(--dsw-alias-brand-primary, #4c8bf5)',
        error: 'var(--dsw-alias-state-error-primary, #c0392b)',
        success: 'var(--dsw-alias-state-success-primary, #1a7f37)',
        warn: 'var(--dsw-alias-state-warn-primary, #9a6700)',
      }

      // ─── 样式（harness kit：28px 高控件 / 8px 圆角 / tonal 填充 / 悬停显边） ───
      var CSS = [
        '.dshmcp-root{font-size:13px;line-height:1.5;color:' + T.text + ';display:flex;flex-direction:column;gap:8px}',
        '.dshmcp-row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}',
        '.dshmcp-row-tight{gap:6px}',
        '.dshmcp-spacer{flex:1 1 auto}',
        '.dshmcp-field{display:flex;flex-direction:column;gap:4px;min-width:220px;flex:1}',
        '.dshmcp-label{font-size:11px;color:' + T.textSecondary + '}',
        '.dshmcp-hint{font-size:11px;color:' + T.textSecondary + '}',
        '.dshmcp-input{background:' + T.surface2 + ';border:1px solid transparent;border-radius:8px;color:inherit;padding:0 8px;font:inherit;font-size:13px;min-width:0;height:28px;width:100%;box-sizing:border-box}',
        '.dshmcp-input:hover{border-color:' + T.border + '}',
        '.dshmcp-input:focus{outline:none;border-color:' + T.brand + '}',
        '.dshmcp-input[disabled]{opacity:.55;cursor:default}',
        '.dshmcp-btn{background:' + T.surface2 + ';border:1px solid transparent;border-radius:8px;color:inherit;padding:0 10px;height:28px;font:inherit;font-size:13px;cursor:pointer;display:inline-flex;align-items:center;gap:5px;white-space:nowrap;transition:background .12s ease,border-color .12s ease}',
        '.dshmcp-btn:hover:not([disabled]){border-color:' + T.border + '}',
        '.dshmcp-btn:focus-visible{outline:2px solid ' + T.brand + ';outline-offset:1px}',
        '.dshmcp-btn[disabled]{cursor:default;color:' + T.textSecondary + ';opacity:.55}',
        '.dshmcp-btn-primary{background:' + T.brand + ';color:#fff}',
        '.dshmcp-btn-primary:hover:not([disabled]){border-color:' + T.brand + ';filter:brightness(1.06)}',
        '.dshmcp-btn-ghost{background:transparent}',
        '.dshmcp-btn-ghost:hover:not([disabled]){background:' + T.surface2 + '}',
        '.dshmcp-btn-sm{height:24px;padding:0 8px;font-size:12px;border-radius:6px}',
        '.dshmcp-muted{color:' + T.textSecondary + '}',
        '.dshmcp-err{color:' + T.error + '}',
        '.dshmcp-ok{color:' + T.success + '}',
        '.dshmcp-warn{color:' + T.warn + '}',
        '.dshmcp-mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px}',
        '.dshmcp-badge{font-size:11px;background:' + T.surface2 + ';border-radius:6px;padding:2px 7px;color:' + T.textSecondary + ';white-space:nowrap}',
        '.dshmcp-badge-strong{color:' + T.text + ';font-weight:600}',
        '.dshmcp-dot{width:7px;height:7px;border-radius:50%;background:' + T.textSecondary + ';flex:0 0 auto}',
        '.dshmcp-dot-ok{background:' + T.success + '}',
        '.dshmcp-dot-err{background:' + T.error + '}',
        '.dshmcp-dot-warn{background:' + T.warn + '}',
        '.dshmcp-panel{display:flex;flex-direction:column;gap:8px;border:1px solid ' + T.border + ';border-radius:10px;padding:10px;background:' + T.surface + '}',
        '.dshmcp-section{display:flex;flex-direction:column;gap:6px}',
        '.dshmcp-section-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap}',
        '.dshmcp-section-title{font-size:11px;letter-spacing:.06em;text-transform:uppercase;color:' + T.textSecondary + '}',
        '.dshmcp-banner{display:flex;align-items:center;gap:8px;flex-wrap:wrap;border-radius:8px;padding:6px 8px;background:' + T.surface2 + ';box-shadow:inset 3px 0 0 ' + T.error + '}',
        '.dshmcp-banner-info{box-shadow:inset 3px 0 0 ' + T.brand + '}',
        '.dshmcp-banner-warn{box-shadow:inset 3px 0 0 ' + T.warn + '}',
        '.dshmcp-note{min-height:18px;font-size:12px;color:' + T.textSecondary + '}',
        /* 开关：28px 药丸，tonal 轨道，品牌色激活；disabled 时整行降透明度 */
        '.dshmcp-switch{position:relative;width:40px;height:22px;border-radius:999px;border:1px solid transparent;background:' + T.surface2 + ';cursor:pointer;padding:0;flex:0 0 auto;transition:background .12s ease,border-color .12s ease}',
        '.dshmcp-switch:hover:not([disabled]){border-color:' + T.border + '}',
        '.dshmcp-switch[aria-checked="true"]{background:' + T.brand + '}',
        '.dshmcp-switch[disabled]{opacity:.5;cursor:default}',
        '.dshmcp-switch-knob{position:absolute;top:2px;left:2px;width:16px;height:16px;border-radius:50%;background:#fff;box-shadow:0 1px 2px rgba(0,0,0,.25);transition:left .12s ease}',
        '.dshmcp-switch[aria-checked="true"] .dshmcp-switch-knob{left:20px}',
        '.dshmcp-switchrow{display:flex;align-items:center;gap:8px;flex-wrap:wrap}',
        /* 运行产物卡 */
        '.dshmcp-card{display:flex;flex-direction:column;gap:8px;border:1px solid ' + T.border + ';border-radius:10px;padding:10px;background:' + T.surface + ';max-width:720px}',
        '.dshmcp-card[data-state="running"]{border-color:' + T.borderStrong + '}',
        '.dshmcp-card[data-state="failed"]{box-shadow:inset 3px 0 0 ' + T.error + '}',
        '.dshmcp-card[data-state="completed"]{box-shadow:inset 3px 0 0 ' + T.success + '}',
        '.dshmcp-card-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap}',
        '.dshmcp-card-title{font-weight:600}',
        '.dshmcp-card-meta{display:flex;flex-direction:column;gap:2px;font-size:12px;color:' + T.textSecondary + '}',
        '.dshmcp-tiles{display:grid;grid-template-columns:repeat(auto-fill,minmax(132px,1fr));gap:8px}',
        '.dshmcp-tile{position:relative;border:1px solid transparent;border-radius:10px;overflow:hidden;background:' + T.surface2 + ';cursor:pointer;padding:0;display:block;width:100%;transition:border-color .12s ease}',
        '.dshmcp-tile:hover{border-color:' + T.brand + '}',
        '.dshmcp-tile img{display:block;width:100%;aspect-ratio:1/1;object-fit:cover;background:' + T.surface2 + '}',
        '.dshmcp-tile-kind{position:absolute;top:6px;left:6px;background:rgba(0,0,0,.55);color:#fff;border-radius:6px;font-size:10px;padding:1px 6px;letter-spacing:.02em}',
        '.dshmcp-fileline{display:inline-flex;align-items:center;gap:6px;background:' + T.surface2 + ';border:1px solid transparent;border-radius:8px;padding:3px 8px;font-size:12px;color:inherit;text-decoration:none;max-width:100%}',
        '.dshmcp-fileline:hover{border-color:' + T.border + '}',
      ].join('\n')

      // ─── 面板通道 ──────────────────────────────────────────────────────
      var CHANNEL = '/comfymcp'

      function unwrap(result) {
        if (result && typeof result === 'object' && 'ok' in result) {
          if (result.ok === false) {
            var message = (result.error && result.error.message) || 'RPC failed'
            throw new Error(message)
          }
          return result.value
        }
        return result
      }

      function rpc(ctx, method, payload) {
        var connection = ctx && ctx.connection
        var api = connection && connection.rpc
        if (!api || typeof api.call !== 'function') {
          return Promise.reject(new Error('connection RPC 不可用（插件为动态挂载时才有面板通道）'))
        }
        return Promise.resolve(api.call(CHANNEL, method, payload || {})).then(unwrap)
      }

      function text(value) {
        if (value === undefined || value === null) return ''
        return typeof value === 'string' ? value : JSON.stringify(value)
      }

      // ─── 通用小组件（harness kit 词汇） ─────────────────────────────────
      function Field(props) {
        return h('label', { className: 'dshmcp-field' },
          h('span', { className: 'dshmcp-label' }, props.label),
          props.children,
          props.hint ? h('span', { className: 'dshmcp-hint' }, props.hint) : null,
        )
      }

      function TextInput(props) {
        return h('input', {
          className: 'dshmcp-input' + (props.mono ? ' dshmcp-mono' : ''),
          type: 'text',
          value: props.value,
          placeholder: props.placeholder || '',
          spellCheck: false,
          disabled: props.disabled === true,
          onChange: function (event) { props.onChange(event.target.value) },
        })
      }

      function ErrorLine(props) {
        if (!props.error) return null
        return h('div', { className: 'dshmcp-banner' },
          h('span', { className: 'dshmcp-err' }, props.label || '出错了：'),
          h('span', { className: 'dshmcp-muted' }, String(props.error)),
          props.onRetry
            ? h('button', { className: 'dshmcp-btn dshmcp-btn-sm', onClick: props.onRetry }, props.retryLabel || '重试')
            : null,
        )
      }

      function CopyButton(props) {
        var state = react.useState(false)
        var copied = state[0]
        function copy() {
          var value = text(props.value)
          if (value.length === 0) return
          try {
            if (typeof navigator !== 'undefined' && navigator.clipboard && navigator.clipboard.writeText) {
              navigator.clipboard.writeText(value).then(function () {
                state[1](true)
                setTimeout(function () { state[1](false) }, 1500)
              })
              return
            }
          } catch (error) {
            /* fall through */
          }
          state[1](true)
          setTimeout(function () { state[1](false) }, 1500)
        }
        return h('button', {
          className: 'dshmcp-btn dshmcp-btn-sm dshmcp-btn-ghost',
          onClick: copy,
          disabled: text(props.value).length === 0,
          title: text(props.value),
        }, copied ? '已复制' : props.label || '复制')
      }

      /** 只读行：标签 + 等宽值（可复制）。 */
      function LinkRow(props) {
        return h('div', { className: 'dshmcp-row' },
          h('span', { className: 'dshmcp-label', style: { minWidth: 76 } }, props.label),
          h('span', {
            className: 'dshmcp-mono dshmcp-linkvalue' + (props.value ? '' : ' dshmcp-muted'),
            style: { flex: '1 1 auto', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
            title: props.value || '',
          }, props.value || props.empty || '—'),
          h(CopyButton, { value: props.value }),
        )
      }

      /** 一个设置块：标题 + 描述 + 子元素。 */
      function SettingsSection(props) {
        return h('section', { className: 'dshmcp-section dshmcp-panel' },
          h('div', { className: 'dshmcp-section-head' },
            h('span', { className: 'dshmcp-section-title' }, props.title),
            h('span', { className: 'dshmcp-spacer' }),
            props.extra || null,
          ),
          props.description ? h('div', { className: 'dshmcp-note' }, props.description) : null,
          props.children,
        )
      }

      /** 开关行：switch + 标签 +（可选）状态说明。 */
      function SwitchRow(props) {
        return h('div', { className: 'dshmcp-switchrow' },
          h('button', {
            type: 'button',
            role: 'switch',
            'aria-checked': props.checked ? 'true' : 'false',
            'aria-label': props.label,
            disabled: props.disabled === true,
            className: 'dshmcp-switch',
            onClick: function () { if (!props.disabled) props.onChange(!props.checked) },
          }, h('span', { className: 'dshmcp-switch-knob' })),
          h('span', { className: props.disabled ? 'dshmcp-muted' : '' }, props.label),
          props.hint ? h('span', { className: 'dshmcp-hint' }, props.hint) : null,
        )
      }

      // ─── 设置页 ─────────────────────────────────────────────────────────
      function ComfymcpSettings(props) {
        var ctx = props.ctx
        var initial = react.useState({
          endpoint: '', workflowDirs: '', saveSubdir: '', artifactsDir: '', hostEntry: '', autoUnloadModel: true, embeddedServer: false,
        })
        var draft = initial[0]
        var setDraft = initial[1]
        var saved = react.useState(initial[0])
        var savedConfig = saved[0]
        var setSaved = saved[1]
        var probeState = react.useState(null)
        var probe = probeState[0]
        var setProbe = probeState[1]
        var uiState = react.useState({ loading: true, saving: false, testing: false, note: '' })
        var ui = uiState[0]
        var setUi = uiState[1]

        function edit(key, value) {
          setDraft(function (previous) {
            var patch = {}
            patch[key] = value
            return Object.assign({}, previous, patch)
          })
        }

        var refresh = react.useCallback(function () {
          setUi(function (previous) { return Object.assign({}, previous, { loading: true, note: '' }) })
          return rpc(ctx, 'configRead', {})
            .then(function (config) {
              var next = {
                endpoint: text(config.endpoint),
                workflowDirs: (config.workflowDirs || []).join(';'),
                saveSubdir: text(config.saveSubdir),
                artifactsDir: text(config.artifactsDir),
                hostEntry: text(config.hostEntry),
                autoUnloadModel: config.autoUnloadModel === true,
                embeddedServer: config.embeddedServer === true,
              }
              setDraft(next)
              setSaved(next)
              setUi(function (previous) { return Object.assign({}, previous, { loading: false }) })
              return rpc(ctx, 'status', {})
            })
            .then(function (value) { setProbe(value) })
            .catch(function (error) {
              setUi(function (previous) { return Object.assign({}, previous, { loading: false, note: error.message || String(error) }) })
            })
        }, [ctx])

        react.useEffect(function () {
          refresh()
          return function () {}
        }, [refresh])

        function isDirty() {
          return ['endpoint', 'workflowDirs', 'saveSubdir', 'artifactsDir', 'hostEntry', 'autoUnloadModel', 'embeddedServer'].some(function (key) {
            return text(draft[key]) !== text(savedConfig[key])
          })
        }

        function testConnection() {
          setUi(function (previous) { return Object.assign({}, previous, { testing: true, note: '' }) })
          rpc(ctx, 'status', {})
            .then(function (value) {
              setProbe(value)
              setUi(function (previous) {
                return Object.assign({}, previous, {
                  testing: false,
                  note: value && value.ok === true
                    ? '已连接 comfy-mcp' + (value.remote && value.remote.backend ? '（后端 ' + value.remote.backend + '）' : '')
                    : '未连接：' + text(value && value.error),
                })
              })
            })
            .catch(function (error) {
              setUi(function (previous) { return Object.assign({}, previous, { testing: false, note: '探测失败：' + error.message }) })
            })
        }

        function save() {
          setUi(function (previous) { return Object.assign({}, previous, { saving: true, note: '' }) })
          var patch = {
            endpoint: draft.endpoint,
            workflowDirs: text(draft.workflowDirs)
              .split(';')
              .map(function (entry) { return entry.trim() })
              .filter(function (entry) { return entry.length > 0 })
              .join(';'),
            saveSubdir: draft.saveSubdir,
            artifactsDir: draft.artifactsDir,
            hostEntry: draft.hostEntry,
            autoUnloadModel: draft.autoUnloadModel === true,
            embeddedServer: draft.embeddedServer === true,
          }
          rpc(ctx, 'configWrite', patch)
            .then(function (result) {
              var applied = (result && result.applied) || {}
              var next = {
                endpoint: text(applied.endpoint),
                workflowDirs: (applied.workflowDirs || []).join(';'),
                saveSubdir: text(applied.saveSubdir),
                artifactsDir: text(applied.artifactsDir),
                hostEntry: text(applied.hostEntry),
                autoUnloadModel: applied.autoUnloadModel === true,
                embeddedServer: applied.embeddedServer === true,
              }
              setDraft(next)
              setSaved(next)
              setUi(function (previous) { return Object.assign({}, previous, { saving: false, note: '已保存（覆盖层即时生效；内嵌服务端在下次运行/探测时按新开关拉起）' }) })
              return rpc(ctx, 'status', {})
            })
            .then(function (value) { if (value) setProbe(value) })
            .catch(function (error) {
              setUi(function (previous) { return Object.assign({}, previous, { saving: false, note: '保存失败：' + (error.message || String(error)) }) })
            })
        }

        // 卸载开关三态：未连接=未知（禁用）；连接但无插件=不可用（禁用）；否则可用
        var probeOk = probe !== null && probe.ok === true
        var unloadAvailable = probeOk && probe.unload !== undefined && probe.unload !== null && probe.unload.available === true
        var unloadDisabled = !probeOk || !unloadAvailable
        var unloadHint = !probeOk
          ? '未连接服务端，无法确认卸载插件是否可用'
          : (unloadAvailable
            ? '服务端支持 UnloadAllModels 节点整合，运行时自动插桩释放显存'
            : '服务端未安装或未启用卸载模型插件（' + text(probe.unload && probe.unload.reason) + '）')

        var host = (probe && probe.host) || null
        var dirty = isDirty()

        return h('div', { className: 'dshmcp-root' },
          // 头部：身份 + 连接状态
          h('div', { className: 'dshmcp-section-head' },
            h('span', { className: 'dshmcp-dot' + (probeOk ? ' dshmcp-dot-ok' : (probe ? ' dshmcp-dot-err' : ' dshmcp-dot-warn')) }),
            h('span', { className: 'dshmcp-badge-strong' }, 'ComfyUI MCP'),
            h('span', { className: probeOk ? 'dshmcp-ok' : 'dshmcp-muted' },
              probeOk ? 'comfy-mcp 已连接' : (probe ? 'comfy-mcp 未连接' : '尚未探测')),
            h('span', { className: 'dshmcp-spacer' }),
            probeOk && unloadAvailable ? h('span', { className: 'dshmcp-badge dshmcp-ok' }, '卸载节点可用') : null,
            !probeOk && probe ? h('span', { className: 'dshmcp-badge dshmcp-err' }, '离线') : null,
          ),
          h(ErrorLine, {
            error: probe && !probeOk ? probe.error : '',
            label: 'comfy-mcp 不可达：',
            onRetry: testConnection,
            retryLabel: '重新探测',
          }),

          h(SettingsSection, {
            title: '连接',
            description: 'comfy-mcp 服务端点（MCP Streamable HTTP）。保存后新运行立即使用新端点。',
          },
            h(Field, { label: 'comfy-mcp 服务端点' },
              h(TextInput, { value: draft.endpoint, mono: true, placeholder: 'http://127.0.0.1:18800/mcp', onChange: function (value) { edit('endpoint', value) } })),
            host ? h(LinkRow, { label: '宿主入口', value: text(host.entry), empty: '未配置（环境变量 DSH_COMFYMCP_HOST_ENTRY）' }) : null,
            host && host.serverInfo ? h(LinkRow, {
              label: '桥接版本',
              value: text(host.serverInfo.name) + ' ' + text(host.serverInfo.version),
            }) : null,
            h('div', { className: 'dshmcp-row dshmcp-row-tight' },
              h('button', { className: 'dshmcp-btn dshmcp-btn-sm', onClick: testConnection, disabled: ui.testing || ui.loading },
                ui.testing ? '探测中…' : '测试连接'),
              h('button', { className: 'dshmcp-btn dshmcp-btn-sm dshmcp-btn-ghost', onClick: refresh, disabled: ui.loading }, '重新加载'),
            ),
          ),

          h(SettingsSection, {
            title: '工作流空间',
            description: '模板检索与强制保存都发生在这里；多个目录用分号分隔。',
          },
            h(Field, { label: '工作流目录（分号分隔）' },
              h(TextInput, { value: draft.workflowDirs, mono: true, placeholder: 'F:\\Comfy\\ComfyUI\\user\\default\\workflows', onChange: function (value) { edit('workflowDirs', value) } })),
            h(Field, { label: '生成保存子目录', hint: '每次运行先保存到该子目录，保证可回溯' },
              h(TextInput, { value: draft.saveSubdir, placeholder: 'dsh-generated', onChange: function (value) { edit('saveSubdir', value) } })),
            h(Field, { label: '产物下载目录', hint: '留空使用 DSH 数据目录' },
              h(TextInput, { value: draft.artifactsDir, mono: true, placeholder: '', onChange: function (value) { edit('artifactsDir', value) } })),
          ),

          h(SettingsSection, {
            title: 'MCP 宿主与 comfy-mcp 服务端',
            description: '宿主入口留空时用环境变量 DSH_COMFYMCP_HOST_ENTRY。内嵌模式由插件自动拉起 comfy-mcp 服务（随机端口，随 DSH 生命周期）；关闭后使用下方端点连接外置服务。',
          },
            h(Field, { label: 'MCP 宿主入口（可选）' },
              h(TextInput, { value: draft.hostEntry, mono: true, placeholder: '…\\projects\\dsh-comfymcp\\mcp\\bin\\fux-comfymcp-host.mjs', onChange: function (value) { edit('hostEntry', value) } })),
            h(SwitchRow, {
              label: '内嵌 comfy-mcp 服务端（推荐单机使用）',
              checked: draft.embeddedServer === true,
              disabled: false,
              onChange: function (value) { edit('embeddedServer', value) },
            }),
            h('span', { className: 'dshmcp-hint' },
              draft.embeddedServer === true
                ? '开启：端点由内嵌服务自动分配并接管（当前生效端点见「连接」分区）；ComfyUI 可在本机或局域网任意主机'
                : '关闭：连接下方端点指向的外置 comfy-mcp 服务'),
            h(Field, { label: 'comfy-mcp 服务端点（外置模式）' },
              h(TextInput, {
                value: draft.endpoint, mono: true, placeholder: 'http://127.0.0.1:18800/mcp',
                disabled: draft.embeddedServer === true,
                onChange: function (value) { edit('endpoint', value) },
              })),
          ),

          h(SettingsSection, {
            title: '模型卸载',
            description: '卸载开关在服务端无 UnloadAllModels 插件时自动置灰。',
          },
            h(SwitchRow, {
              label: '运行后自动卸载模型（释放显存）',
              checked: draft.autoUnloadModel === true,
              disabled: unloadDisabled,
              onChange: function (value) { edit('autoUnloadModel', value) },
            }),
            h('span', { className: 'dshmcp-hint' }, unloadHint),
          ),

          h('div', { className: 'dshmcp-row' },
            h('button', {
              className: 'dshmcp-btn dshmcp-btn-primary',
              onClick: save,
              disabled: ui.saving || ui.loading,
            }, ui.saving ? '保存中…' : (dirty ? '保存配置（有未保存改动）' : '保存配置')),
            dirty
              ? h('span', { className: 'dshmcp-warn' }, '有未保存的改动')
              : h('span', { className: 'dshmcp-muted' }, '配置与当前一致'),
          ),
          ui.note ? h('div', { className: 'dshmcp-note' }, ui.note) : null,
        )
      }

      // ─── 运行产物卡（keyed toolview） ───────────────────────────────────
      function artifactSrc(entry) {
        if (entry === null || typeof entry !== 'object') return null
        if (typeof entry.path === 'string' && entry.path.length > 0) {
          return '/api/comfymcp/artifact?path=' + encodeURIComponent(entry.path)
        }
        return null
      }

      var IMG_ATTRS = { loading: 'lazy', decoding: 'async' }

      function ArtifactsGrid(props) {
        var list = Array.isArray(props.files) ? props.files : []
        if (list.length === 0) return null
        var images = []
        var files = []
        list.forEach(function (entry, index) {
          var src = artifactSrc(entry)
          var kind = entry.kind || 'file'
          var name = text(entry.filename) || text(entry.path) || 'artifact-' + index
          if (src !== null && (kind === 'image' || /\.(png|jpe?g|webp|gif|bmp)$/i.test(name))) {
            images.push(h('a', { key: 'i' + index, href: src, target: '_blank', rel: 'noreferrer', className: 'dshmcp-tile' },
              h('img', Object.assign({ src: src, alt: name }, IMG_ATTRS)),
              h('span', { className: 'dshmcp-tile-kind' }, 'IMG'),
            ))
            return
          }
          files.push(h('a', { key: 'f' + index, href: src || '#', target: '_blank', rel: 'noreferrer', className: 'dshmcp-fileline' },
            h('span', null, kind === 'video' ? '▶' : '📄'),
            h('span', { className: 'dshmcp-mono', style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, name),
          ))
        })
        return h('div', { className: 'dshmcp-section', style: { gap: 6 } },
          images.length > 0 ? h('div', { className: 'dshmcp-tiles' }, images) : null,
          files.length > 0 ? h('div', { className: 'dshmcp-row dshmcp-row-tight' }, files) : null,
        )
      }

      function RunCard(props) {
        var block = props.block
        if (block === undefined || block === null || block.kind === undefined) return null
        if (props.phase === 'preparing') {
          return h('div', { className: 'dshmcp-card', 'data-state': 'running' },
            h('div', { className: 'dshmcp-card-head' },
              h('span', { className: 'dshmcp-dot dshmcp-dot-warn' }),
              h('span', { className: 'dshmcp-card-title' }, '工作流运行中…'),
            ),
          )
        }
        var meta = block.meta !== undefined && block.meta !== null && typeof block.meta === 'object' ? block.meta : {}
        var call = block.call !== undefined && block.call !== null ? block.call : {}
        var args = {}
        try { args = JSON.parse(call.argsRaw || '{}') || {} } catch (error) { args = {} }
        var state = typeof meta.state === 'string' ? meta.state : (block.isError ? 'failed' : 'completed')
        var unload = meta.unload !== undefined && meta.unload !== null && typeof meta.unload === 'object' ? meta.unload : {}
        var stateLabel = state === 'completed' ? '已完成' : (state === 'running' ? '运行中' : '失败')
        return h('div', { className: 'dshmcp-card', 'data-state': state },
          h('div', { className: 'dshmcp-card-head' },
            h('span', { className: 'dshmcp-dot' + (state === 'completed' ? ' dshmcp-dot-ok' : (state === 'failed' ? ' dshmcp-dot-err' : ' dshmcp-dot-warn')) }),
            h('span', { className: 'dshmcp-card-title' }, '工作流 · ' + (typeof args.name === 'string' && args.name.length > 0 ? args.name : 'workflow')),
            h('span', { className: 'dshmcp-spacer' }),
            h('span', {
              className: 'dshmcp-badge ' + (state === 'completed' ? 'dshmcp-ok' : (state === 'failed' ? 'dshmcp-err' : '')),
            }, stateLabel),
            unload.requested === true
              ? h('span', { className: 'dshmcp-badge ' + (unload.applied === true ? 'dshmcp-ok' : 'dshmcp-warn') },
                unload.applied === true ? '卸载已插桩' : '卸载未生效')
              : null,
          ),
          h(ArtifactsGrid, {
            files: Array.isArray(meta.localFiles) && meta.localFiles.length > 0 ? meta.localFiles : (Array.isArray(meta.artifacts) ? meta.artifacts : []),
          }),
          h('div', { className: 'dshmcp-card-meta' },
            meta.saved !== undefined && meta.saved !== null
              ? h('span', { className: 'dshmcp-mono' }, '已保存 ' + text(meta.saved.subdir) + ' / ' + text(meta.saved.name || meta.saved.id || ''))
              : null,
            (meta.seed !== undefined && meta.seed !== null) ? h('span', null, '种子 ' + text(meta.seed)) : null,
            typeof meta.prompt === 'string' && meta.prompt.length > 0
              ? h('span', null, '提示词 ' + (meta.prompt.length > 80 ? meta.prompt.slice(0, 77) + '…' : meta.prompt))
              : null,
            typeof meta.error === 'string' && meta.error.length > 0
              ? h('span', { className: 'dshmcp-err' }, meta.error)
              : null,
          ),
        )
      }

      // ─── 挂载 ────────────────────────────────────────────────────────────
      var inject = ['slots', 'connection']

      function apply(ctx) {
        var slots = ctx.slots
        if (slots === undefined) return

        // 样式表挂载/卸载（disposer 移除 <style>）
        if (typeof document !== 'undefined' && typeof ctx.effect === 'function') {
          ctx.effect(function () {
            var tag = document.createElement('style')
            tag.dataset.plugin = 'dsh-comfymcp-client'
            tag.textContent = CSS
            document.head.appendChild(tag)
            return function () {
              if (tag.parentNode !== null) tag.parentNode.removeChild(tag)
            }
          }, 'dsh-comfymcp-client: settings stylesheet')
        }

        slots.inject('settings.section', function () {
          return slots.register(
            { name: 'settings.section', id: 'comfymcp', order: 60, label: function () { return 'ComfyUI MCP' } },
            function (props) {
              return h(ComfymcpSettings, Object.assign({}, props, { ctx: ctx }))
            },
          )
        })

        slots.inject('tool.call.toolview', function () {
          return slots.register(
            { name: 'tool.call.toolview', key: 'comfymcp_run_workflow' },
            function (props) { return h(RunCard, props) },
          )
        })

        slots.inject('tool.call.toolview', function () {
          return slots.register(
            { name: 'tool.call.toolview', key: 'comfymcp_fetch_artifacts' },
            function (props) { return h(RunCard, props) },
          )
        })
      }

      return { inject: inject, apply: apply }
    },
  })
}
