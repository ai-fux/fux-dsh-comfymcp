/* global window */
if (typeof window !== 'undefined' && window.__ModuleLoader__ !== undefined) {
  window.__ModuleLoader__.load({
    id: 'dsh-comfymcp-client',
    factory(require) {
    const React = require('react');
    const h = React.createElement;

    // ---------------------------------------------------------------- helpers

    function textClass(extra) {
      return extra ? 'comfymcp-text ' + extra : 'comfymcp-text';
    }

    function Field({ label, hint, children }) {
      return h('label', { className: 'comfymcp-field' },
        h('span', { className: 'comfymcp-field-label' }, label),
        children,
        hint ? h('span', { className: 'comfymcp-field-hint' }, hint) : null,
      );
    }

    function TextInput(props) {
      return h('input', {
        className: 'comfymcp-input',
        type: 'text',
        value: props.value,
        placeholder: props.placeholder || '',
        disabled: props.disabled === true,
        onChange: (event) => props.onChange(event.target.value),
      });
    }

    function Toggle({ checked, disabled, onChange, label }) {
      return h('button', {
        type: 'button',
        role: 'switch',
        'aria-checked': checked ? 'true' : 'false',
        'aria-label': label,
        disabled: disabled === true,
        className: 'comfymcp-switch' + (checked ? ' is-on' : '') + (disabled ? ' is-disabled' : ''),
        onClick: () => { if (!disabled) onChange(!checked); },
      }, h('span', { className: 'comfymcp-switch-knob' }));
    }

    function Button({ children, onClick, disabled, kind }) {
      return h('button', {
        type: 'button',
        disabled: disabled === true,
        className: 'comfymcp-button' + (kind === 'primary' ? ' is-primary' : ''),
        onClick,
      }, children);
    }

    /** Read a localized string with a fallback map (keys are zh text themselves). */
    function useT(props) {
      return (key, fallback) => {
        if (props && typeof props.t === 'function') {
          const translated = props.t(key);
          if (typeof translated === 'string' && translated.length > 0 && translated !== key) return translated;
        }
        return fallback ?? key;
      };
    }

    // ------------------------------------------------------------- settings page

    function SettingsPage(props) {
      const t = useT(props);
      const [state, setState] = React.useState({
        endpoint: '',
        workflowDirs: '',
        saveSubdir: '',
        artifactsDir: '',
        autoUnloadModel: true,
        hostEntry: '',
        loading: true,
        saving: false,
        testing: false,
        probe: null,
        message: '',
      });
      const load = React.useCallback(async () => {
        try {
          const connection = ctx.get('connection');
          if (connection === undefined || connection.rpc === undefined) {
            setState((prev) => ({ ...prev, loading: false, message: '连接服务不可用，无法读取配置' }));
            return;
          }
          const result = await connection.rpc.call('/comfymcp', 'config/read', {});
          if (result.ok) {
            const config = result.value;
            setState((prev) => ({
              ...prev,
              endpoint: config.endpoint,
              workflowDirs: (config.workflowDirs || []).join('; '),
              saveSubdir: config.saveSubdir,
              artifactsDir: config.artifactsDir,
              autoUnloadModel: config.autoUnloadModel === true,
              hostEntry: config.hostEntry || '',
              loading: false,
            }));
            const probe = await connection.rpc.call('/comfymcp', 'status', {});
            if (probe.ok) setState((prev) => ({ ...prev, probe: probe.value }));
          } else {
            setState((prev) => ({ ...prev, loading: false, message: result.error ? result.error.message : '读取配置失败' }));
          }
        } catch (error) {
          setState((prev) => ({ ...prev, loading: false, message: String(error) }));
        }
      }, []);

      React.useEffect(() => { void load(); }, [load]);

      const save = async () => {
        setState((prev) => ({ ...prev, saving: true, message: '' }));
        try {
          const connection = ctx.get('connection');
          const result = await connection.rpc.call('/comfymcp', 'config/write', {
            endpoint: state.endpoint,
            workflowDirs: state.workflowDirs,
            saveSubdir: state.saveSubdir,
            artifactsDir: state.artifactsDir,
            autoUnloadModel: state.autoUnloadModel,
            hostEntry: state.hostEntry,
          });
          if (result.ok) {
            setState((prev) => ({ ...prev, saving: false, message: '已保存' }));
            const probe = await connection.rpc.call('/comfymcp', 'status', {});
            if (probe.ok) setState((prev) => ({ ...prev, probe: probe.value }));
          } else {
            setState((prev) => ({ ...prev, saving: false, message: result.error ? result.error.message : '保存失败' }));
          }
        } catch (error) {
          setState((prev) => ({ ...prev, saving: false, message: String(error) }));
        }
      };

      const testConnection = async () => {
        setState((prev) => ({ ...prev, testing: true, message: '' }));
        try {
          const connection = ctx.get('connection');
          const probe = await connection.rpc.call('/comfymcp', 'status', {});
          setState((prev) => ({ ...prev, testing: false, probe: probe.ok ? probe.value : null, message: probe.ok ? (probe.value.ok ? '已连接' : probe.value.error) : '探测失败' }));
        } catch (error) {
          setState((prev) => ({ ...prev, testing: false, message: String(error) }));
        }
      };

      const probe = state.probe;
      const unloadAvailable = probe !== null && probe.ok === true && probe.unload !== undefined && probe.unload.available === true;
      const unloadChecked = probe === null ? state.autoUnloadModel : state.autoUnloadModel && unloadAvailable;
      const unloadDisabled = probe === null || probe.ok !== true || !unloadAvailable;
      const unloadHint = probe === null
        ? t('settings.unloadHintUnknown', '尚未连接服务端，无法确认卸载插件是否可用')
        : (probe.ok !== true
          ? t('settings.offline', '未连接：{error}').replace('{error}', probe.error || '')
          : (unloadAvailable
            ? t('settings.unloadHintOk', '已连接：服务端支持 UnloadAllModels 节点整合')
            : t('settings.unloadHintMissing', '服务端未安装或未启用卸载模型插件，该选项不可用')));

      return h('div', { className: 'comfymcp-settings' },
        h('div', { className: 'comfymcp-row' },
          h(Field, { label: t('settings.endpoint', 'comfy-mcp 服务端点'), hint: t('settings.endpointHint', 'MCP Streamable HTTP 地址，例如 http://127.0.0.1:18800/mcp') },
            h(TextInput, { value: state.endpoint, placeholder: 'http://127.0.0.1:18800/mcp', onChange: (v) => setState((p) => ({ ...p, endpoint: v })) })),
          h(Button, { onClick: testConnection, disabled: state.testing }, state.testing ? t('settings.testing', '探测中…') : t('settings.test', '测试连接')),
        ),
        h(Field, { label: t('settings.workflowDirs', '工作流空间目录'), hint: t('settings.workflowDirsHint', '分号分隔；模板检索与保存都发生在这些目录') },
          h(TextInput, { value: state.workflowDirs, placeholder: 'F:\\Comfy\\workflows; F:\\Comfy\\templates', onChange: (v) => setState((p) => ({ ...p, workflowDirs: v })) })),
        h(Field, { label: t('settings.saveSubdir', '生成保存子目录'), hint: t('settings.saveSubdirHint', '每次运行先保存到该子目录，保证可回溯') },
          h(TextInput, { value: state.saveSubdir, placeholder: 'dsh-generated', onChange: (v) => setState((p) => ({ ...p, saveSubdir: v })) })),
        h(Field, { label: t('settings.artifactsDir', '成果物下载目录'), hint: t('settings.artifactsDirHint', '留空则使用 DSH 数据目录') },
          h(TextInput, { value: state.artifactsDir, placeholder: '', onChange: (v) => setState((p) => ({ ...p, artifactsDir: v })) })),
        h(Field, { label: t('settings.hostEntry', 'MCP 宿主入口（可选）'), hint: t('settings.hostEntryHint', 'projects/dsh-comfymcp/mcp/bin/fux-comfymcp-host.mjs 的绝对路径；留空用环境变量 DSH_COMFYMCP_HOST_ENTRY') },
          h(TextInput, { value: state.hostEntry, placeholder: '', onChange: (v) => setState((p) => ({ ...p, hostEntry: v })) })),
        h('div', { className: 'comfymcp-row comfymcp-unload-row' },
          h(Toggle, {
            checked: unloadChecked,
            disabled: unloadDisabled,
            label: t('settings.autoUnload', '运行后自动卸载模型（释放显存）'),
            onChange: (v) => setState((p) => ({ ...p, autoUnloadModel: v })),
          }),
          h('span', { className: textClass(unloadDisabled ? 'is-muted' : '') }, t('settings.autoUnload', '运行后自动卸载模型（释放显存）')),
        ),
        h('span', { className: 'comfymcp-field-hint' }, unloadHint),
        h('div', { className: 'comfymcp-row comfymcp-actions' },
          h(Button, { kind: 'primary', onClick: save, disabled: state.saving || state.loading }, state.saving ? t('settings.saving', '保存中…') : t('settings.save', '保存配置')),
          h('span', { className: 'comfymcp-status' },
            probe === null ? '' : (probe.ok ? t('settings.connected', '● 已连接 comfy-mcp') : t('settings.disconnected', '● 未连接'))),
        ),
        state.message ? h('span', { className: 'comfymcp-message' }, state.message) : null,
      );
    }

    // ------------------------------------------------------------- run artifact card

    function artifactSrc(entry) {
      if (typeof entry.path !== 'string' || entry.path.length === 0) return null;
      return '/api/comfymcp/artifact?path=' + encodeURIComponent(entry.path);
    }

    function ArtifactsGrid({ files }) {
      const list = Array.isArray(files) ? files : [];
      if (list.length === 0) return null;
      return h('div', { className: 'comfymcp-artifacts' },
        list.map((entry, index) => {
          const src = artifactSrc(entry);
          const kind = entry.kind || 'file';
          if (kind === 'image' && src !== null) {
            return h('a', { key: index, href: src, target: '_blank', rel: 'noreferrer', className: 'comfymcp-artifact-thumb' },
              h('img', { src, alt: entry.filename || ('artifact-' + index), loading: 'lazy' }));
          }
          return h('a', { key: index, href: src || '#', target: '_blank', rel: 'noreferrer', className: 'comfymcp-artifact-file' },
            (kind === 'video' ? '▶ ' : '📄 ') + (entry.filename || entry.path || ('artifact-' + index)));
        }),
      );
    }

    function RunCard(props) {
      const t = useT(props);
      const block = props.block;
      if (block === undefined || block === null || block.kind === undefined) return null;
      if (props.phase === 'preparing') {
        return h('div', { className: 'comfymcp-card comfymcp-card-running' }, t('card.running', '工作流运行中…'));
      }
      const meta = block.meta !== undefined && block.meta !== null && typeof block.meta === 'object' ? block.meta : {};
      const call = block.call !== undefined && block.call !== null ? block.call : {};
      let args = {};
      try { args = JSON.parse(call.argsRaw || '{}') || {}; } catch { args = {}; }
      const state = typeof meta.state === 'string' ? meta.state : (block.isError ? 'failed' : 'completed');
      const unload = meta.unload !== undefined && meta.unload !== null ? meta.unload : {};
      return h('div', { className: 'comfymcp-card', 'data-state': state },
        h('div', { className: 'comfymcp-card-head' },
          h('span', { className: 'comfymcp-card-title' }, t('card.title', '工作流运行') + ' · ' + (typeof args.name === 'string' ? args.name : 'workflow')),
          h('span', { className: 'comfymcp-card-state', 'data-state': state }, state)),
        h(ArtifactsGrid, { files: Array.isArray(meta.localFiles) ? meta.localFiles : (Array.isArray(meta.artifacts) ? meta.artifacts : []) }),
        h('div', { className: 'comfymcp-card-meta' },
          meta.saved !== undefined && meta.saved !== null
            ? h('span', null, t('card.saved', '已保存 {subdir} / {name}').replace('{subdir}', meta.saved.subdir || '').replace('{name}', meta.saved.name || meta.saved.id || ''))
            : null,
          unload.requested === true
            ? h('span', null, unload.applied === true
              ? t('card.unloadApplied', '自动卸载：已整合 UnloadAllModels')
              : t('card.unloadSkipped', '自动卸载未生效') + '（' + (unload.reason || '') + '）')
            : null,
          (typeof meta.seed === 'number' || (meta.seed !== undefined && meta.seed !== null))
            ? h('span', null, t('card.seed', '种子') + ' ' + meta.seed)
            : null,
          typeof meta.prompt === 'string' && meta.prompt.length > 0
            ? h('span', { className: 'comfymcp-card-prompt' }, t('card.prompt', '提示词') + ' ' + (meta.prompt.length > 80 ? meta.prompt.slice(0, 77) + '…' : meta.prompt))
            : null,
          typeof meta.error === 'string' && meta.error.length > 0
            ? h('span', { className: 'comfymcp-card-error' }, meta.error)
            : null,
        ));
    }

    // ---------------------------------------------------------------- apply

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section',
          id: 'comfymcp',
          order: 60,
          label: 'ComfyUI MCP',
          locale: 'dsh-comfymcp-client',
        }, SettingsPage));

        ctx.slots.inject('tool.call.toolview', () => ctx.slots.register({
          name: 'tool.call.toolview',
          key: 'comfymcp_run_workflow',
          locale: 'dsh-comfymcp-client',
        }, RunCard));
        ctx.slots.inject('tool.call.toolview', () => ctx.slots.register({
          name: 'tool.call.toolview',
          key: 'comfymcp_fetch_artifacts',
          locale: 'dsh-comfymcp-client',
        }, RunCard));
      },
    };
  },
  });
}
