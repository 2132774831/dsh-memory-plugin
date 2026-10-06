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
    var EXPORT_API = '/dsh-local-memory/export'
    var IMPORT_API = '/dsh-local-memory/import'

    /** 评分权重的字段定义（默认值 + 区间 + 中文名），与 Host 半侧保持一致。 */
    var WEIGHT_FIELDS = [
      { key: 'textMatch', label: '正文命中', def: 2, min: 0, max: 20, step: 1, hint: '关键词在记忆正文里出现时得多少分' },
      { key: 'tagMatch', label: '标签命中', def: 1, min: 0, max: 20, step: 1, hint: '只在标签里命中时得多少分' },
      { key: 'wholeQuery', label: '整句命中', def: 5, min: 0, max: 50, step: 1, hint: '整条查询原样出现在正文里的额外分' },
      { key: 'exactTag', label: '标签精确', def: 3, min: 0, max: 50, step: 1, hint: '标签与整条查询完全相同时的额外分' },
      { key: 'longTermBonus', label: '长词加成', def: 1.5, min: 0, max: 5, step: 0.1, hint: '长度 ≥3 的词项的权重倍率（长词更具体）' }
    ]

    var DEFAULT_WEIGHTS = (function () {
      var w = {}
      WEIGHT_FIELDS.forEach(function (f) { w[f.key] = f.def })
      return w
    })()

    /* Host 半侧若是旧版本，面板也要能正常渲染这些字段 */
    var FALLBACK = {
      enabled: true,
      storeFile: '',
      maxMemories: 5000,
      autoRecall: true,
      autoRecallMaxItems: 5,
      autoRecallMinChars: 8,
      autoTagProject: true,
      organizeBeforeDelete: false,
      weights: DEFAULT_WEIGHTS,
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
      '.__lm_search .__lm_input{flex:1 1 auto}',
      '.__lm_menuitem{display:block;width:100%;text-align:left;border:0;background:transparent;color:inherit;font:inherit;font-size:13px;padding:7px 10px;border-radius:6px;cursor:pointer}',
      '.__lm_menuitem:hover{background:var(--dsw-alias-bg-layer-3)}',
      '.__lm_overlay{position:fixed;inset:0;z-index:2147483001;background:rgba(0,0,0,.38);display:flex;align-items:center;justify-content:center;padding:24px}',
      '.__lm_modal{width:min(560px,100%);max-height:82vh;overflow:auto;background:var(--dsw-alias-bg-layer-2,#fff);color:var(--dsw-alias-label-primary);border:1px solid var(--dsw-alias-border-l2);border-radius:12px;padding:16px 18px;display:flex;flex-direction:column;gap:12px;box-shadow:0 18px 48px rgba(0,0,0,.28)}',
      '.__lm_modalTitle{font-size:14px;font-weight:600}'
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

      /* ── 权重 ── */
      function setWeight(key, value) {
        setNotice(null)
        setDraft(function (d) {
          var next = Object.assign({}, d.weights || DEFAULT_WEIGHTS)
          next[key] = value
          return Object.assign({}, d, { weights: next })
        })
      }

      function resetWeights() {
        setNotice(null)
        setDraft(function (d) { return Object.assign({}, d, { weights: Object.assign({}, DEFAULT_WEIGHTS) }) })
      }

      /* ── 导出 ── */
      function exportMarkdown() {
        setBusy(true); setNotice(null); setError(null)
        fetch(EXPORT_API, { headers: { Accept: 'text/markdown' } })
          .then(function (r) {
            if (!r.ok) throw new Error('HTTP ' + r.status)
            return r.text()
          })
          .then(function (text) {
            var stamp = new Date().toISOString().slice(0, 10)
            var blob = new Blob([text], { type: 'text/markdown;charset=utf-8' })
            var url = URL.createObjectURL(blob)
            var a = document.createElement('a')
            a.href = url
            a.download = 'dsh-local-memory-' + stamp + '.md'
            document.body.appendChild(a)
            a.click()
            document.body.removeChild(a)
            setTimeout(function () { URL.revokeObjectURL(url) }, 2000)
            setNotice('已导出 Markdown 文件。')
          })
          .catch(function (e) { setError('导出失败：' + String((e && e.message) || e)) })
          .then(function () { setBusy(false) })
      }

      /* ── 导入 ── */
      function importMarkdownFile(file) {
        if (!file) return
        setBusy(true); setNotice(null); setError(null)
        var reader = new FileReader()
        reader.onload = function () {
          fetch(IMPORT_API, {
            method: 'POST',
            headers: { 'Content-Type': 'text/markdown;charset=utf-8' },
            body: String(reader.result || '')
          })
            .then(function (r) { return r.json() })
            .then(function (j) {
              if (!j || j.ok !== true) throw new Error((j && j.error) || 'import failed')
              applyState(j)
              setNotice('导入完成：新增 ' + j.added + ' 条，合并 ' + j.merged + ' 条'
                + (j.skipped ? '，跳过 ' + j.skipped + ' 条' : '') + '。')
            })
            .catch(function (e) { setError('导入失败：' + String((e && e.message) || e)) })
            .then(function () { setBusy(false) })
        }
        reader.onerror = function () {
          setError('读取文件失败。')
          setBusy(false)
        }
        reader.readAsText(file, 'utf-8')
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
          }, showAdd ? '收起' : '+ 新增记忆'),
          h('button', {
            className: '__lm_btn',
            disabled: busy,
            onClick: exportMarkdown
          }, '导出 Markdown'),
          h('label', { className: '__lm_btn', title: '从 Markdown 文件导入（支持本插件导出格式，也支持其他 Agent / 别的电脑导出的笔记）' },
            '导入 Markdown',
            h('input', {
              type: 'file',
              accept: '.md,.markdown,.txt,text/markdown,text/plain',
              style: { display: 'none' },
              disabled: busy,
              onChange: function (e) {
                var file = e.target && e.target.files && e.target.files[0]
                importMarkdownFile(file)
                e.target.value = ''
              }
            })
          )
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
        h(Check, {
          label: '删除对话前提醒整理记忆',
          hint: '开启后，从会话菜单点「整理记忆并归档…」时会弹出确认框，先让你把这段对话里值得留的写进记忆库，再归档。'
            + '（插件无法拦截系统原生的删除动作，所以入口是会话菜单里的这一项。）',
          checked: !!draft.organizeBeforeDelete,
          onChange: function (v) { set('organizeBeforeDelete', v) }
        }),
        h(Field, { label: '存储文件', hint: '记忆全部存在这个本地文件里，可以直接用编辑器打开看。' },
          h(TextInput, {
            value: draft.storeFile,
            mono: true,
            placeholder: '默认 ~/.dsh/dsh-local-memory.json',
            onChange: function (v) { set('storeFile', v) }
          }))
      )

      /* ── 检索权重 ── */
      var weights = draft.weights || DEFAULT_WEIGHTS
      var weightsGroup = h('div', { className: '__lm_group' },
        h('div', { className: '__lm_groupTitle' }, '检索权重'),
        h('div', { className: '__lm_hint' },
          '记忆检索靠关键词打分。下面是当前生效的权重，调大 = 这类命中更有分量。'
          + '改完点「保存设置」立即生效。'),
        h('div', { className: '__lm_kv' },
          WEIGHT_FIELDS.map(function (f) {
            return h(Kv, { key: f.key, label: f.label, value: String(num(weights[f.key], f.def)) })
          })
        ),
        h('div', { className: '__lm_row' },
          h('button', { className: '__lm_btn', onClick: resetWeights }, '权重恢复默认')
        ),
        h('div', null,
          WEIGHT_FIELDS.map(function (f) {
            return h(Field, { key: f.key, label: f.label, hint: f.hint },
              h(Range, {
                value: num(weights[f.key], f.def), min: f.min, max: f.max, step: f.step,
                display: String(num(weights[f.key], f.def)),
                onChange: function (v) { setWeight(f.key, v) }
              }))
          })
        )
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
        weightsGroup,
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

    /* ── 功能 3：删除对话前整理记忆 —— 会话菜单项 + 弹窗 ───────────────────
     * 约束（已通过 Inspect 确认）：
     *   - 插件槽位是"追加"语义，拦不住系统原生的删除动作；
     *   - 所以入口做成会话「...」菜单里的一行，点开弹自己的确认框。
     * 会话菜单项收到的 props 是 { sessionId, displayTitle }（SessionRowOwnerProps）。
     * ──────────────────────────────────────────────────────────────────────── */

    /** 极简广播：菜单项发，overlay 收。 */
    var organizeSubscribers = []
    function broadcastOrganize(target) {
      organizeSubscribers.slice().forEach(function (fn) {
        try { fn(target) } catch (e) { /* noop */ }
      })
    }
    function subscribeOrganize(fn) {
      organizeSubscribers.push(fn)
      return function () {
        var i = organizeSubscribers.indexOf(fn)
        if (i >= 0) organizeSubscribers.splice(i, 1)
      }
    }

    /** 配置缓存：菜单项要根据 organizeBeforeDelete 决定显不显示。 */
    var configCache = { at: 0, value: null }
    function loadConfigCached() {
      var now = Date.now()
      if (configCache.value && now - configCache.at < 15000) return Promise.resolve(configCache.value)
      return fetch(STATE_API + '?limit=1', { headers: { Accept: 'application/json' } })
        .then(function (r) { return r.json() })
        .then(function (j) {
          if (j && j.ok && j.config) {
            configCache.value = j.config
            configCache.at = Date.now()
          }
          return configCache.value
        })
        .catch(function () { return configCache.value })
    }

    /** 会话「...」菜单里的一行。 */
    function OrganizeMenuItem(props) {
      var [enabled, setEnabled] = react.useState(configCache.value ? !!configCache.value.organizeBeforeDelete : null)

      react.useEffect(function () {
        var alive = true
        loadConfigCached().then(function (cfg) {
          if (alive && cfg) setEnabled(!!cfg.organizeBeforeDelete)
        })
        return function () { alive = false }
      }, [])

      if (enabled !== true) return null

      var sessionId = props && (props.sessionId || (props.session && props.session.id))
      var title = (props && (props.displayTitle || props.title)) || ''

      function closeMenu() {
        // 壳通过 slotInject 提供 menuOpenState 钩子；形状不确定，全部兜住，
        // 关不掉菜单也不影响功能。
        try {
          if (props && typeof props.useMenuOpenState === 'function') {
            var close = props.useMenuOpenState()
            if (typeof close === 'function') close()
          }
        } catch (e) { /* noop */ }
      }

      return h('button', {
        type: 'button',
        role: 'menuitem',
        className: '__lm_menuitem',
        onClick: function () {
          closeMenu()
          broadcastOrganize({ sessionId: sessionId, title: title })
        }
      }, '整理记忆…')
    }

    /** 弹窗本体，挂在 shell.overlay 上。 */
    function OrganizeOverlay() {
      var [target, setTarget] = react.useState(null)
      var [text, setText] = react.useState('')
      var [tagText, setTagText] = react.useState('')
      var [busy, setBusy] = react.useState(false)
      var [error, setError] = react.useState(null)
      var [done, setDone] = react.useState(null)

      react.useEffect(function () { return subscribeOrganize(setTarget) }, [])

      if (!target) return null

      function close() {
        setTarget(null); setText(''); setTagText(''); setError(null); setDone(null)
      }

      function save() {
        var body = text.trim()
        if (!body) { setError('先写点要记住的内容。'); return }
        setBusy(true); setError(null)
        fetch(MEMORY_API, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'add', text: body, tags: parseTags(tagText) })
        })
          .then(function (r) { return r.json() })
          .then(function (j) {
            if (!j || j.ok !== true) throw new Error((j && j.error) || 'save failed')
            setDone(j.created ? '已存进记忆库。现在可以放心归档/删除这个对话了。' : '这条已经记过了，已合并标签。')
            setText('')
          })
          .catch(function (e) { setError('保存失败：' + String((e && e.message) || e)) })
          .then(function () { setBusy(false) })
      }

      return h('div', { className: '__lm_overlay' },
        h('div', { className: '__lm_modal' },
          h('div', { className: '__lm_modalTitle' },
            '整理记忆' + (target.title ? ' · ' + target.title : '')),
          h('div', { className: '__lm_hint' },
            '把这段对话里值得长期保留的结论写下来，存进本地记忆库。存完再归档/删除这个对话，就不会丢东西了。'),
          h('div', { className: '__lm_field' },
            h(TextArea, {
              value: text,
              rows: 5,
              placeholder: '例如：这个项目的鉴权用轮询而不是 webhook，因为要避免公网回调。',
              onChange: setText
            }),
            h(TextInput, {
              value: tagText,
              placeholder: '标签，用逗号分隔（可留空）',
              onChange: setTagText
            })
          ),
          done ? h('div', { className: '__lm_ok' }, done) : null,
          error ? h('div', { className: '__lm_err' }, error) : null,
          h('div', { className: '__lm_row' },
            h('button', { className: '__lm_btn __lm_btnPrimary', disabled: busy, onClick: save },
              busy ? '保存中…' : '保存为记忆'),
            h('button', { className: '__lm_btn', disabled: busy, onClick: close }, '关闭')
          )
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

      // 会话「...」菜单里加一行（order 350：夹在 fork(300) 与 archive(400) 之间）
      ctx.slots.inject('sidebar.workspaces.session.menu.item', function () {
        return ctx.slots.register(
          { name: 'sidebar.workspaces.session.menu.item', id: 'local-memory-organize', order: 350 },
          function (props) { return h(OrganizeMenuItem, props || {}) }
        )
      })

      // 弹窗挂到 shell.overlay
      ctx.slots.inject('shell.overlay', function () {
        return ctx.slots.register(
          { name: 'shell.overlay', id: 'local-memory-organize-overlay', order: 900 },
          function () { return h(OrganizeOverlay, {}) }
        )
      })
    }

    exports.apply = apply
    exports.inject = inject
    return module.exports
  }
})
