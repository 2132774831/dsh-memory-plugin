/**
 * dsh-local-memory — 浏览器半侧（设置页「本地记忆」）
 * ----------------------------------------------------------------------------
 * 手写 ModuleLoader bundle（无需构建）。在 DSH 设置里注册一个 settings.section，
 * 页面分两块：
 *   1) 记忆浏览：看全部记忆、搜索、新增、编辑、删除；
 *   2) 插件设置：开关、自动回忆参数、存储文件路径。
 *
 * 数据走 Host 半侧自带的 HTTP API（/dsh-local-memory/*），不走 settings 命名空间。
 * 注册 id 必须等于 loader entry 名（dsh-local-memory），否则 ModuleLoader 会报
 * "loaded without registering dsh-local-memory"。
 */

window.__ModuleLoader__.load({
  id: 'dsh-local-memory',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    var react = require('react')
    var h = react.createElement

    var STATE_API = '/dsh-local-memory/state'
    var CONFIG_API = '/dsh-local-memory/config'
    var MEMORY_API = '/dsh-local-memory/memory'

    /* Host 半侧若是旧版本，面板也要能正常渲染这些字段 */
    var FALLBACK = {
      enabled: true,
      storeFile: '',
      maxMemories: 5000,
      autoRecall: true,
      autoRecallMaxItems: 5,
      autoRecallMinChars: 8,
      autoTagProject: true,
      injectBrief: true
    }

    function num(value, fallback) {
      var n = Number(value)
      return isFinite(n) ? n : fallback
    }

    /** 逗号/空格分隔的标签串 → 数组 */
    function parseTags(text) {
      return String(text || '')
        .split(/[,，\s]+/)
        .map(function (s) { return s.trim() })
        .filter(Boolean)
    }

    function formatDate(ts) {
      var n = Number(ts)
      if (!isFinite(n) || n <= 0) return ''
      try {
        var d = new Date(n)
        var p = function (x) { return String(x).padStart(2, '0') }
        return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes())
      } catch (e) { return '' }
    }

    function formatBytes(bytes) {
      var n = Number(bytes) || 0
      if (n < 1024) return n + ' B'
      if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB'
      return (n / 1024 / 1024).toFixed(1) + ' MB'
    }

    /* ── CSS ─────────────────────────────────────────────────────────────── */
    var CSS = [
      '.__lm_root{max-width:760px;display:flex;flex-direction:column;gap:14px;font-size:13px;color:var(--dsw-alias-label-primary)}',
      '.__lm_lead{font-size:12px;line-height:1.7;color:var(--dsw-alias-label-tertiary)}',
      '.__lm_group{border:1px solid var(--dsw-alias-border-l2);border-radius:10px;padding:12px 14px;display:flex;flex-direction:column;gap:11px}',
      '.__lm_groupTitle{font-size:11px;font-weight:600;letter-spacing:.08em;text-transform:uppercase;color:var(--dsw-alias-label-tertiary)}',
      '.__lm_field{display:flex;flex-direction:column;gap:5px}',
      '.__lm_label{font-size:12px;font-weight:600;color:var(--dsw-alias-label-primary)}',
      '.__lm_hint{font-size:11px;line-height:1.6;color:var(--dsw-alias-label-tertiary)}',
      '.__lm_row{display:flex;align-items:center;gap:10px;flex-wrap:wrap}',
      '.__lm_input{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);font:inherit;color:var(--dsw-alias-label-primary);border-radius:8px;padding:6px 10px;font-size:13px;box-sizing:border-box;width:100%;outline:none}',
      '.__lm_input:focus{border-color:var(--dsw-alias-state-business-primary)}',
      '.__lm_inputMono{font-family:ui-monospace,Consolas,monospace;font-size:12px}',
      '.__lm_area{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);font:inherit;color:var(--dsw-alias-label-primary);border-radius:8px;padding:8px 10px;font-size:13px;box-sizing:border-box;width:100%;outline:none;resize:vertical;min-height:64px;line-height:1.6}',
      '.__lm_area:focus{border-color:var(--dsw-alias-state-business-primary)}',
      '.__lm_check{display:flex;align-items:flex-start;gap:8px;cursor:pointer}',
      '.__lm_check input{margin-top:2px;accent-color:var(--dsw-alias-state-business-primary)}',
      '.__lm_checkText{display:flex;flex-direction:column;gap:2px}',
      '.__lm_actions{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-top:2px}',
      '.__lm_btn{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-primary);border-radius:8px;padding:5px 12px;font:inherit;font-size:12px;cursor:pointer}',
      '.__lm_btn:hover:not(:disabled){border-color:var(--dsw-alias-state-business-primary)}',
      '.__lm_btn:disabled{opacity:.5;cursor:default}',
      '.__lm_btnPrimary{border-color:var(--dsw-alias-state-business-primary,#3964fe);background:var(--dsw-alias-state-business-primary,#3964fe);color:#fff}',
      '.__lm_btnDanger{color:var(--dsw-alias-state-error-primary,#f85149)}',
      '.__lm_status{font-size:12px;color:var(--dsw-alias-label-tertiary)}',
      '.__lm_ok{font-size:12px;color:var(--dsw-alias-state-business-primary)}',
      '.__lm_err{font-size:12px;color:var(--dsw-alias-state-error-primary,#f85149)}',
      '.__lm_kv{display:flex;flex-direction:column;gap:4px;font-size:12px}',
      '.__lm_kvRow{display:flex;gap:8px}',
      '.__lm_kvKey{color:var(--dsw-alias-label-tertiary);min-width:88px;flex:0 0 auto}',
      '.__lm_kvVal{font-family:ui-monospace,Consolas,monospace;font-size:11.5px;word-break:break-all}',
      '.__lm_list{display:flex;flex-direction:column;gap:8px;max-height:420px;overflow:auto;padding-right:2px}',
      '.__lm_item{border:1px solid var(--dsw-alias-border-l2);border-radius:9px;padding:9px 11px;display:flex;flex-direction:column;gap:6px;background:var(--dsw-alias-bg-layer-3)}',
      '.__lm_itemText{font-size:13px;line-height:1.6;white-space:pre-wrap;word-break:break-word}',
      '.__lm_meta{display:flex;gap:8px;flex-wrap:wrap;align-items:center;font-size:11px;color:var(--dsw-alias-label-tertiary)}',
      '.__lm_tag{display:inline-block;padding:1px 7px;border-radius:999px;font-size:11px;border:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary)}',
      '.__lm_mono{font-family:ui-monospace,Consolas,monospace;font-size:11px;color:var(--dsw-alias-label-tertiary)}',
      '.__lm_empty{font-size:12px;color:var(--dsw-alias-label-tertiary);padding:10px 2px;line-height:1.6}',
      '.__lm_itemActions{display:flex;gap:6px}',
      '.__lm_search{display:flex;gap:8px;align-items:center}',
      '.__lm_search .__lm_input{flex:1 1 auto}'
    ].join('')
    var tagId = 'dsh-local-memory/main.css'
    if (typeof document !== 'undefined' && document.querySelector('style[data-plugin-css="' + tagId + '"]') === null) {
      var styleTag = document.createElement('style')
      styleTag.dataset.plugin = 'dsh-local-memory'
      styleTag.dataset.pluginCss = tagId
      styleTag.textContent = CSS
      document.head.appendChild(styleTag)
    }

    /* ── 表单原子 ────────────────────────────────────────────────────────── */
    function Field(props) {
      return h('div', { className: '__lm_field' },
        h('label', { className: '__lm_label' }, props.label),
        props.children,
        props.hint ? h('div', { className: '__lm_hint' }, props.hint) : null
      )
    }

    function TextInput(props) {
      return h('input', {
        className: '__lm_input' + (props.mono ? ' __lm_inputMono' : ''),
        type: 'text',
        value: props.value == null ? '' : String(props.value),
        placeholder: props.placeholder || '',
        spellCheck: false,
        autoComplete: 'off',
        onKeyDown: props.onEnter ? function (e) { if (e.key === 'Enter') props.onEnter() } : undefined,
        onChange: function (e) { props.onChange(e.target.value) }
      })
    }

    function TextArea(props) {
      return h('textarea', {
        className: '__lm_area',
        value: props.value == null ? '' : String(props.value),
        placeholder: props.placeholder || '',
        spellCheck: false,
        rows: props.rows || 3,
        onChange: function (e) { props.onChange(e.target.value) }
      })
    }

    function Check(props) {
      return h('label', { className: '__lm_check' },
        h('input', {
          type: 'checkbox',
          checked: !!props.checked,
          onChange: function (e) { props.onChange(e.target.checked) }
        }),
        h('span', { className: '__lm_checkText' },
          h('span', null, props.label),
          props.hint ? h('span', { className: '__lm_hint' }, props.hint) : null
        )
      )
    }

    function Range(props) {
      return h('div', { className: '__lm_row' },
        h('input', {
          type: 'range',
          min: props.min, max: props.max, step: props.step || 1,
          value: props.value,
          style: { flex: '1 1 220px' },
          onChange: function (e) { props.onChange(Number(e.target.value)) }
        }),
        h('span', { className: '__lm_status' }, props.display)
      )
    }

    function Kv(props) {
      return h('div', { className: '__lm_kvRow' },
        h('span', { className: '__lm_kvKey' }, props.label),
        h('span', { className: '__lm_kvVal' }, props.value == null || props.value === '' ? '—' : String(props.value))
      )
    }

    /* ── 面板 ────────────────────────────────────────────────────────────── */
    function Panel() {
      var [state, setState] = react.useState(null)
      var [draft, setDraft] = react.useState(null)
      var [query, setQuery] = react.useState('')
      var [busy, setBusy] = react.useState(false)
      var [notice, setNotice] = react.useState(null)
      var [error, setError] = react.useState(null)

      // 新增表单
      var [addText, setAddText] = react.useState('')
      var [addTags, setAddTags] = react.useState('')
      var [showAdd, setShowAdd] = react.useState(false)

      // 编辑中的记忆
      var [editingId, setEditingId] = react.useState(null)
      var [editText, setEditText] = react.useState('')
      var [editTags, setEditTags] = react.useState('')

      // 待确认删除
      var [confirmId, setConfirmId] = react.useState(null)

      function applyState(payload) {
        setState(payload)
        setDraft(Object.assign({}, FALLBACK, payload.config || {}))
      }

      function load(q) {
        var url = STATE_API + '?limit=100'
        if (q) url += '&q=' + encodeURIComponent(q)
        return fetch(url, { headers: { Accept: 'application/json' } })
          .then(function (r) { return r.json() })
          .then(function (j) {
            if (!j || j.ok !== true) throw new Error((j && j.error) || 'load failed')
            applyState(j)
          })
          .catch(function (e) { setError('读取失败：' + String((e && e.message) || e)) })
      }

      react.useEffect(function () { load('') }, [])

      function post(url, body) {
        return fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body)
        })
          .then(function (r) { return r.json() })
          .then(function (j) {
            if (!j || j.ok !== true) throw new Error((j && j.error) || 'request failed')
            applyState(j)
            return j
          })
      }

      function saveConfig() {
        if (!draft) return
        setBusy(true); setNotice(null); setError(null)
        post(CONFIG_API, { patch: draft })
          .then(function () { setNotice('设置已保存，立即生效。') })
          .catch(function (e) { setError('保存失败：' + String((e && e.message) || e)) })
          .then(function () { setBusy(false) })
      }

      function resetConfig() {
        setBusy(true); setNotice(null); setError(null)
        post(CONFIG_API, { action: 'reset' })
          .then(function () { setNotice('已恢复默认设置。') })
          .catch(function (e) { setError('恢复默认失败：' + String((e && e.message) || e)) })
          .then(function () { setBusy(false) })
      }

      function addMemory() {
        var text = addText.trim()
        if (!text) { setError('记忆内容不能为空。'); return }
        setBusy(true); setNotice(null); setError(null)
        post(MEMORY_API, { action: 'add', text: text, tags: parseTags(addTags) })
          .then(function (j) {
            setNotice(j.created ? '已新增一条记忆。' : '这条已经记过了，已合并标签。')
            setAddText(''); setAddTags(''); setShowAdd(false)
          })
          .catch(function (e) { setError('新增失败：' + String((e && e.message) || e)) })
          .then(function () { setBusy(false) })
      }

      function startEdit(memory) {
        setEditingId(memory.id)
        setEditText(memory.text || '')
        setEditTags((memory.tags || []).join(', '))
        setConfirmId(null)
      }

      function saveEdit() {
        if (!editingId) return
        var text = editText.trim()
        if (!text) { setError('记忆内容不能为空。'); return }
        setBusy(true); setNotice(null); setError(null)
        post(MEMORY_API, { action: 'update', id: editingId, text: text, tags: parseTags(editTags) })
          .then(function () { setNotice('已保存修改。'); setEditingId(null) })
          .catch(function (e) { setError('保存失败：' + String((e && e.message) || e)) })
          .then(function () { setBusy(false) })
      }

      function removeMemory(id) {
        setBusy(true); setNotice(null); setError(null)
        post(MEMORY_API, { action: 'delete', id: id })
          .then(function () { setNotice('已删除。'); setConfirmId(null) })
          .catch(function (e) { setError('删除失败：' + String((e && e.message) || e)) })
          .then(function () { setBusy(false) })
      }

      function set(key, value) {
        setNotice(null)
        setDraft(function (d) { return Object.assign({}, d, { [key]: value }) })
      }

      if (!draft || !state) {
        return h('div', { className: '__lm_root' },
          h('div', { className: '__lm_status' }, error || '读取中…'),
          error ? h('div', { className: '__lm_actions' },
            h('button', { className: '__lm_btn', onClick: function () { load('') } }, '重试')
          ) : null
        )
      }

      var stats = state.stats || { count: 0, tags: [], projects: [], bytes: 0, file: '' }
      var memories = state.memories || []

      /* ── 记忆列表 ── */
      var listNodes = memories.map(function (memory) {
        var isEditing = editingId === memory.id
        var isConfirming = confirmId === memory.id
        return h('div', { className: '__lm_item', key: memory.id },
          isEditing
            ? h('div', { className: '__lm_field' },
              h(TextArea, { value: editText, onChange: setEditText, rows: 3 }),
              h(TextInput, {
                value: editTags,
                placeholder: '标签，用逗号分隔（可留空）',
                onChange: setEditTags
              }),
              h('div', { className: '__lm_itemActions' },
                h('button', { className: '__lm_btn __lm_btnPrimary', disabled: busy, onClick: saveEdit }, '保存'),
                h('button', { className: '__lm_btn', disabled: busy, onClick: function () { setEditingId(null) } }, '取消')
              )
            )
            : h('div', null,
              h('div', { className: '__lm_itemText' }, memory.text),
              h('div', { className: '__lm_meta' },
                (memory.tags || []).map(function (tag) {
                  return h('span', { className: '__lm_tag', key: tag }, tag)
                }),
                memory.project ? h('span', { className: '__lm_tag' }, memory.project) : null,
                h('span', null, formatDate(memory.updatedAt || memory.createdAt)),
                Number(memory.hits) > 0 ? h('span', null, '用过 ' + memory.hits + ' 次') : null,
                h('span', { className: '__lm_mono' }, memory.id)
              ),
              h('div', { className: '__lm_itemActions' },
                isConfirming
                  ? h('span', { className: '__lm_row' },
                    h('span', { className: '__lm_err' }, '确定删除？'),
                    h('button', { className: '__lm_btn __lm_btnDanger', disabled: busy, onClick: function () { removeMemory(memory.id) } }, '删除'),
                    h('button', { className: '__lm_btn', disabled: busy, onClick: function () { setConfirmId(null) } }, '取消')
                  )
                  : h('span', { className: '__lm_row' },
                    h('button', { className: '__lm_btn', onClick: function () { startEdit(memory) } }, '编辑'),
                    h('button', { className: '__lm_btn __lm_btnDanger', onClick: function () { setConfirmId(memory.id) } }, '删除')
                  )
              )
            )
        )
      })

      var memoryGroup = h('div', { className: '__lm_group' },
        h('div', { className: '__lm_groupTitle' }, '记忆（共 ' + stats.count + ' 条）'),

        h('div', { className: '__lm_search' },
          h(TextInput, {
            value: query,
            placeholder: '输入关键词筛选（留空显示最近 100 条）',
            onChange: setQuery,
            onEnter: function () { load(query) }
          }),
          h('button', { className: '__lm_btn', disabled: busy, onClick: function () { load(query) } }, '筛选'),
          h('button', { className: '__lm_btn', disabled: busy, onClick: function () { setQuery(''); load('') } }, '显示全部')
        ),

        h('div', { className: '__lm_row' },
          h('button', {
            className: '__lm_btn __lm_btnPrimary',
            onClick: function () { setShowAdd(function (v) { return !v }) }
          }, showAdd ? '收起' : '+ 新增记忆')
        ),

        showAdd
          ? h('div', { className: '__lm_field' },
            h(TextArea, {
              value: addText,
              placeholder: '要记住什么？（写成能独立读懂的一句话，包含「为什么」）',
              onChange: setAddText,
              rows: 3
            }),
            h(TextInput, {
              value: addTags,
              placeholder: '标签，用逗号分隔（可留空），如 topic:auth, pref',
              onChange: setAddTags
            }),
            h('div', { className: '__lm_itemActions' },
              h('button', { className: '__lm_btn __lm_btnPrimary', disabled: busy, onClick: addMemory }, '保存'),
              h('button', { className: '__lm_btn', disabled: busy, onClick: function () { setShowAdd(false); setAddText(''); setAddTags('') } }, '取消')
            )
          )
          : null,

        memories.length
          ? h('div', { className: '__lm_list' }, listNodes)
          : h('div', { className: '__lm_empty' },
            state.total > 0
              ? '没有匹配「' + query + '」的记忆。换个词试试，或点「显示全部」。'
              : '还没有任何记忆。模型在对话里用 memory_save 写入，或者你在上面点「+ 新增记忆」。')
      )

      var configGroup = h('div', { className: '__lm_group' },
        h('div', { className: '__lm_groupTitle' }, '设置'),

        h(Check, {
          label: '启用本地记忆',
          hint: '关闭后不注册记忆工具、不做自动回忆、不注入提示词。',
          checked: !!draft.enabled,
          onChange: function (v) { set('enabled', v) }
        }),
        h(Check, {
          label: '每轮自动回忆',
          hint: '在模型回答前，用你的输入做关键词检索，命中就作为附加上下文注入。纯本地，很快。',
          checked: !!draft.autoRecall,
          onChange: function (v) { set('autoRecall', v) }
        }),
        draft.autoRecall
          ? h(Field, { label: '每次最多注入几条' },
            h(Range, {
              value: num(draft.autoRecallMaxItems, 5), min: 1, max: 20, step: 1,
              display: Math.round(num(draft.autoRecallMaxItems, 5)) + ' 条',
              onChange: function (v) { set('autoRecallMaxItems', v) }
            }))
          : null,
        draft.autoRecall
          ? h(Field, { label: '输入短于此不触发', hint: '避免「好的」「继续」这类短句也去翻记忆。' },
            h(Range, {
              value: num(draft.autoRecallMinChars, 8), min: 0, max: 60, step: 1,
              display: Math.round(num(draft.autoRecallMinChars, 8)) + ' 字',
              onChange: function (v) { set('autoRecallMinChars', v) }
            }))
          : null,
        h(Check, {
          label: '写入时自动打上项目标签',
          hint: '按会话目录识别项目名（优先 git remote 的 owner/repo），方便按项目筛选。不影响默认检索范围。',
          checked: !!draft.autoTagProject,
          onChange: function (v) { set('autoTagProject', v) }
        }),
        h(Check, {
          label: '把记忆库说明写进系统提示词',
          hint: '让模型知道有这个记忆库、以及什么时候该用。',
          checked: !!draft.injectBrief,
          onChange: function (v) { set('injectBrief', v) }
        }),
        h(Field, { label: '记忆条数上限', hint: '超出后自动丢弃最旧的，防止文件无界增长。' },
          h(Range, {
            value: num(draft.maxMemories, 5000), min: 50, max: 20000, step: 50,
            display: Math.round(num(draft.maxMemories, 5000)) + ' 条',
            onChange: function (v) { set('maxMemories', v) }
          })),
        h(Field, { label: '存储文件', hint: '记忆全部存在这个本地文件里，可以直接用编辑器打开看。' },
          h(TextInput, {
            value: draft.storeFile,
            mono: true,
            placeholder: '默认 ~/.dsh/dsh-local-memory.json',
            onChange: function (v) { set('storeFile', v) }
          }))
      )

      var storageGroup = h('div', { className: '__lm_group' },
        h('div', { className: '__lm_groupTitle' }, '存储'),
        h('div', { className: '__lm_kv' },
          h(Kv, { label: '记忆文件', value: stats.file }),
          h(Kv, { label: '配置文件', value: state.configFile }),
          h(Kv, {
            label: '统计',
            value: stats.count + ' 条 · ' + (stats.tags.length || 0) + ' 个标签 · '
              + (stats.projects.length || 0) + ' 个项目 · ' + formatBytes(stats.bytes)
          })
        ),
        stats.tags.length
          ? h('div', { className: '__lm_hint' }, '已用标签：' + stats.tags.join('、'))
          : null,
        stats.projects.length
          ? h('div', { className: '__lm_hint' }, '已记录项目：' + stats.projects.join('、'))
          : null
      )

      return h('div', { className: '__lm_root' },
        h('div', { className: '__lm_lead' },
          '纯本地的长期记忆：跨对话、跨项目，数据只存在你本机的一个 JSON 文件里。' +
          '不联网、不调用任何大模型、不需要 API key。检索用关键词匹配（中文按二字组合）。'
        ),

        memoryGroup,
        storageGroup,
        configGroup,

        h('div', { className: '__lm_actions' },
          h('button', { className: '__lm_btn __lm_btnPrimary', disabled: busy, onClick: saveConfig },
            busy ? '处理中…' : '保存设置'),
          h('button', { className: '__lm_btn', disabled: busy, onClick: resetConfig }, '恢复默认'),
          h('button', { className: '__lm_btn', disabled: busy, onClick: function () { load(query) } }, '刷新'),
          notice ? h('span', { className: '__lm_ok' }, notice) : null,
          error ? h('span', { className: '__lm_err' }, error) : null
        )
      )
    }

    /* ── 插件 ────────────────────────────────────────────────────────────── */
    var inject = ['slots']

    function apply(ctx) {
      ctx.slots.inject('settings.section', function () {
        return ctx.slots.register(
          { name: 'settings.section', id: 'local-memory', order: 28, label: '本地记忆' },
          function () { return h(Panel, {}) }
        )
      })
    }

    exports.apply = apply
    exports.inject = inject
    return module.exports
  }
})
