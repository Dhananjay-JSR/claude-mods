/**
 * intent-lens — a Claude Mod that shows the intent of a tool call.
 *
 * Claude Code calls `register` once when the plugin loads and passes `on`.
 * Every hook receives ($, e, next): the mods API, the frozen event, and the
 * continuation. Nothing here imports npm packages, reads the filesystem, or
 * calls a model unless the intent engine asks for it.
 */

// How many intents `/intent-log` remembers per session
const MAX_HISTORY = 50
// Longest detail shown in the band, before the terminal width trims it further
const DETAIL_LIMIT = 110

// The small, fast model used to phrase an intent. Costs a few tokens per call.
const MODEL = 'haiku'
// The request has no timeout option on 2.1.273, and the tool call waits for
// this answer, so the mod stops waiting here and keeps the local line.
const MODEL_TIMEOUT_MS = 1500
const MODEL_MAX_TOKENS = 60

// Instructions live in the prompt, not in `system`, so the call also works
// through Bedrock, Vertex, Foundry and LLM gateways.
const MODEL_RULES =
  'You describe what a coding agent is about to do with one tool call. ' +
  'Reply with a single line: imperative, specific, at most 12 words, ' +
  'no quotes, no markdown, no trailing period. Prefer what changes or why ' +
  'over restating the arguments.\n\n'

// Tools this mod already phrases well without a model.
const KNOWN_TOOLS = new Set([
  'Bash', 'BashOutput', 'KillBash', 'KillShell', 'Read', 'Write', 'Edit',
  'MultiEdit', 'NotebookEdit', 'Grep', 'Glob', 'WebFetch', 'WebSearch', 'Task',
  'Agent', 'TodoWrite', 'AskUserQuestion', 'ExitPlanMode', 'Skill',
  'SlashCommand', 'TaskOutput',
])

// Module state. Hot reload runs `register` again, so this resets on save;
// the on/off switch is kept in $.store so it survives reloads and sessions.
let enabled = true
// Which engine phrases the intent: 'auto' upgrades the calls that read worst.
let mode = 'auto'
// Set once the band has drawn, so headless runs never spend tokens.
let uiSeen = false
let lastIntent = null
let history = []
let seq = 0

export function register(on) {
  // ---------------------------------------------------------------- session

  on('session.start', async ($, e, next) => {
    // A resumed session reuses this process, so start from a clean slate:
    // otherwise the previous conversation's calls leak into /intent-log.
    history = []
    seq = 0
    lastIntent = null
    uiSeen = false

    // Register the commands first: if the store is unavailable on this
    // Claude Code build, the commands still exist. A name taken by another
    // mod must not stop the rest of session start.
    for (const command of [
      {
        name: 'intent',
        description: 'Toggle the intent line above the prompt: /intent [on|off|mode|log|clear]',
      },
      {
        name: 'intent-log',
        description: 'List what Claude has done this session, in plain language',
      },
    ]) {
      try {
        await $.command.register(command)
      } catch {
        // Leave the other command, and the store restore, to run.
      }
    }

    try {
      const saved = await $.store.get('enabled')
      if (typeof saved === 'boolean') enabled = saved
      const savedMode = await $.store.get('mode')
      if (savedMode === 'local' || savedMode === 'auto' || savedMode === 'model') {
        mode = savedMode
      }
    } catch {
      // No store on this build: the in-memory defaults stand.
    }

    return next(e)
  })

  // ------------------------------------------------------------- every tool

  // Fires for every tool, including subagent and MCP calls. Observing only:
  // it runs before the tool, then passes the event on unchanged.
  on('tool.call', async ($, e, next) => {
    const raw = String(e.tool || 'Tool')
    const item = intentOf(raw, e)
    seq += 1
    item.n = seq

    // Show the local line immediately, then refine it if the engine asks for
    // a model. The band never sits blank while the model thinks.
    lastIntent = item
    try {
      $.ui.invalidate('ui.render')
    } catch {
      // No UI (claude -p, headless): nothing to draw.
    }

    // Warn about calls that can destroy work, even when the band is hidden.
    // Best effort: a missing toast API must not stop the tool.
    if (item.risk) {
      try {
        $.ui.toast('⚠ ' + item.tool + ' will ' + item.risk, { timeoutMs: 6000 })
      } catch {
        // Toast unavailable.
      }
    }

    if (enabled && wantsModel(raw, item)) {
      const better = await modelIntent($, e, item)
      if (better) {
        item.detail = better
        item.source = 'model'
        try {
          $.ui.invalidate('ui.render')
        } catch {
          // No UI to redraw.
        }
      }
    }

    history.push(item)
    if (history.length > MAX_HISTORY) history.shift()

    let result
    try {
      result = await next(e)
    } catch (error) {
      // The chain failed; record it before the error continues outward.
      item.outcome = 'failed'
      throw error
    }

    // Record the outcome for /intent-log, then return the result untouched so
    // Claude reads exactly what the tool produced. 2.1.273 puts deny and
    // isError on the envelope; read the inner result too, for other builds.
    const inner = result && result.result && typeof result.result === 'object' ? result.result : null
    if (result && (result.deny || (inner && inner.deny))) item.outcome = 'denied'
    else if (result && (result.isError || (inner && inner.isError))) item.outcome = 'failed'
    else item.outcome = 'ok'
    return result
  })

  // ---------------------------------------------------------------- display

  // The band directly above the prompt. Drawn only while Claude is working.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    // Firing at all proves a real UI is drawing this session; headless runs
    // never raise this event, so they never spend tokens on a model call.
    uiSeen = true

    const working = !e.props || e.props.isWorking !== false
    if (!enabled || !lastIntent || !working) return next(e)

    const columns = (e.props && e.props.bodyColumns) || 80
    const el = $.ui.resolve(e)

    // Keep Claude Code's own band content below ours.
    const theirs = await next(e)

    return el.Box({
      flexDirection: 'column',
      children: [bandLine(el, lastIntent, columns), theirs],
    })
  })

  // --------------------------------------------------------------- commands

  on('command.run', { command: 'intent' }, async ($, e) => {
    const parts = String(e.args || '').trim().toLowerCase().split(/\s+/)
    const verb = parts[0] || ''
    const value = parts[1] || ''

    if (verb === 'log' || verb === 'history') return { text: logText() }
    if (verb === 'clear') {
      history = []
      seq = 0
      return { text: 'history cleared.' }
    }

    // Switch the engine: /intent mode model, or the shorthand /intent model
    const asked = verb === 'mode' ? value : verb
    if (asked === 'local' || asked === 'auto' || asked === 'model') {
      mode = asked
      try {
        await $.store.set('mode', mode)
      } catch {
        // Not persisted, but it still applies to this session.
      }
      try {
        $.ui.invalidate('ui.render')
      } catch {
        // No UI to redraw.
      }
      return { text: 'engine ' + mode + ' — ' + engineHint(mode) }
    }
    if (verb === 'mode') {
      return {
        text: 'engine is ' + mode + '. Use /intent mode local, auto, or model.',
      }
    }

    if (verb === 'on') enabled = true
    else if (verb === 'off') enabled = false
    else if (verb === 'toggle') enabled = !enabled
    else {
      return {
        text:
          'intent line is ' +
          (enabled ? 'on' : 'off') +
          ', engine ' +
          mode +
          '. Use /intent on, off, toggle, mode, log, or clear.',
      }
    }

    try {
      await $.store.set('enabled', enabled)
    } catch {
      // Not persisted, but it still applies to this session.
    }

    try {
      $.ui.invalidate('ui.render')
    } catch {
      // No UI to redraw.
    }

    return {
      text: 'intent line is ' + (enabled ? 'on' : 'off') + '.',
    }
  })

  on('command.run', { command: 'intent-log' }, async () => ({ text: logText() }))
}

// ---------------------------------------------------------------- the model

// Ask the small model for a better line. Returns null on any failure so the
// caller keeps the local phrasing; the intent line must never break a call.
async function modelIntent($, e, item) {
  const prompt =
    MODEL_RULES +
    'Tool: ' + String(e.tool || 'Tool') + '\n' +
    'Arguments:\n' + argumentsOf(e) + '\n' +
    'Draft: ' + item.detail + '\n' +
    'One-line intent:'

  try {
    const answer = await withDeadline(
      $,
      $.model.complete({
        model: MODEL,
        prompt,
        maxTokens: MODEL_MAX_TOKENS,
      }),
      MODEL_TIMEOUT_MS,
    )
    const text = answerText(answer)
    return text ? cleanIntent(text) : null
  } catch {
    // A refusal, a blocked model, or a bad request: keep the local line.
    return null
  }
}

// Claude Code 2.1.273 resolves to a plain string. Later builds resolve to
// { isAnswered, text, reason }, so read both contracts.
function answerText(answer) {
  if (typeof answer === 'string') return answer
  if (answer && typeof answer === 'object' && answer.isAnswered) {
    return typeof answer.text === 'string' ? answer.text : null
  }
  return null
}

// 2.1.273 has no timeout option, so the wait is bounded here. A slow model
// loses to the local line rather than holding the tool call open.
function withDeadline($, work, ms) {
  return new Promise((resolve, reject) => {
    let done = false
    let timer = null

    function finish(settle, value) {
      if (done) return
      done = true
      try {
        if (timer && typeof timer.cancel === 'function') timer.cancel()
      } catch {
        // A timer that cannot be cancelled has already fired.
      }
      settle(value)
    }

    try {
      timer = $.clock.after(ms, () => finish(resolve, null))
    } catch {
      // No timer on this build: the request's own timeout is the only bound.
      timer = null
    }

    work.then(
      (value) => finish(resolve, value),
      (error) => finish(reject, error),
    )
  })
}

// Decide whether the wording is worth a model call. 'auto' upgrades the calls
// where the local line is weakest: edits, and tools this mod doesn't know.
// Risk is never delegated: the warning must not depend on a model's wording.
function wantsModel(raw, item) {
  if (item.risk) return false
  if (mode === 'local') return false
  if (!uiSeen) return false
  if (mode === 'model') return true
  return (
    raw === 'Edit' ||
    raw === 'Write' ||
    raw === 'MultiEdit' ||
    raw === 'NotebookEdit' ||
    raw.startsWith('mcp__') ||
    !KNOWN_TOOLS.has(raw)
  )
}

// A compact, bounded view of the tool arguments for the prompt.
function argumentsOf(e) {
  const skip = new Set(['tool', 'agentId', 'tool_use_id', 'session_id'])
  const parts = []
  let budget = 900
  for (const key of Object.keys(e)) {
    if (skip.has(key)) continue
    const value = e[key]
    if (value === undefined || value === null) continue
    let text
    if (typeof value === 'string') text = value
    else {
      try {
        text = JSON.stringify(value)
      } catch {
        continue
      }
    }
    if (!text) continue
    if (text.length > 200) text = text.slice(0, 199) + '…'
    const line = key + ': ' + text
    if (line.length > budget) break
    budget -= line.length
    parts.push(line)
  }
  return parts.join('\n') || '(none)'
}

// Keep a model answer to one clean line, or reject it and fall back.
function cleanIntent(text) {
  if (typeof text !== 'string') return null
  let line = oneLine(text)
  line = line.replace(/^[-*•]\s*/, '').replace(/^intent\s*[:\-]\s*/i, '')
  line = line.replace(/^["'`]+|["'`]+$/g, '').replace(/[.!]+$/, '')
  line = oneLine(line)
  if (line.length < 3) return null
  return short(line, DETAIL_LIMIT)
}

function engineHint(which) {
  if (which === 'local') return 'free and instant, no model calls.'
  if (which === 'model') return 'Claude phrases every call; a few tokens each.'
  return 'local lines, upgraded by Claude for edits and unknown tools.'
}

// ---------------------------------------------------------------- rendering

function bandLine(el, item, columns) {
  const { Box, Text } = el
  const mark = item.risk ? '⚠' : item.source === 'model' ? '✦' : '▸'
  const color = item.risk ? 'red' : item.source === 'model' ? 'magenta' : 'cyan'
  // The marker and a gap sit before the tool name, and another gap after it.
  const room = Math.max(16, columns - item.tool.length - 6)

  return Box({
    flexDirection: 'row',
    columnGap: 1,
    children: [
      Text({ color, children: [mark + ' ' + item.tool] }),
      Text({
        dimColor: true,
        wrap: 'truncate',
        children: [short(item.detail, room)],
      }),
    ],
  })
}

function logText() {
  if (!history.length) return 'no tool calls recorded yet.'

  return history
    .slice(-20)
    .map((item) => {
      const tick =
        item.outcome === 'denied' || item.outcome === 'failed'
          ? '✗'
          : item.outcome === 'ok'
            ? '✓'
            : '·'
      const engine = item.source === 'model' ? '✦' : '▸'
      const risk = item.risk ? '  ⚠ ' + item.risk : ''
      return (
        tick +
        ' ' +
        String(item.n).padStart(2, ' ') +
        '. ' +
        engine +
        ' ' +
        item.tool +
        ' · ' +
        item.detail +
        risk
      )
    })
    .join('\n')
}

// ---------------------------------------------------------------- heuristics

// Turn a tool call into { tool, detail, risk, source }. Pure: no mods API.
function intentOf(raw, e) {
  return {
    tool: displayTool(raw),
    detail: describe(raw, e),
    risk: riskOf(raw, e),
    source: 'local',
  }
}

function displayTool(tool) {
  if (tool.startsWith('mcp__')) {
    const rest = tool.slice(5)
    const cut = rest.indexOf('__')
    if (cut > 0) return rest.slice(0, cut) + ':' + rest.slice(cut + 2)
  }
  return tool
}

function describe(tool, e) {
  switch (tool) {
    case 'Bash': {
      const cmd = oneLine(String(e.command || ''))
      const why = typeof e.description === 'string' ? oneLine(e.description) : ''
      if (why) return short(why + ' — ' + cmd, DETAIL_LIMIT)
      return short('run ' + cmd, DETAIL_LIMIT)
    }

    case 'BashOutput':
    case 'KillBash':
    case 'KillShell':
      return 'check on a background shell'

    case 'Read': {
      const at = range(e.offset, e.limit)
      return (e.file_path ? shortPath(e.file_path) : 'a file') + at
    }

    case 'Write':
      return (
        (e.file_path ? shortPath(e.file_path) : 'a file') +
        (typeof e.content === 'string' ? ' (' + lines(lineCount(e.content)) + ')' : '')
      )

    case 'Edit':
      return (
        (e.file_path ? shortPath(e.file_path) : 'a file') +
        (typeof e.old_string === 'string' && typeof e.new_string === 'string'
          ? ' (' + lines(lineCount(e.old_string)) + ' → ' + lines(lineCount(e.new_string)) + ')'
          : '')
      )

    case 'MultiEdit':
      return (
        (e.file_path ? shortPath(e.file_path) : 'a file') +
        (Array.isArray(e.edits) ? ' (' + e.edits.length + ' changes)' : '')
      )

    case 'NotebookEdit':
      return e.notebook_path ? shortPath(e.notebook_path) : 'a notebook'

    case 'Grep': {
      const where = e.path ? ' in ' + shortPath(e.path) : ''
      return '"' + short(String(e.pattern || ''), 50) + '"' + where
    }

    case 'Glob':
      return (
        short(String(e.pattern || '*'), 60) +
        (e.path ? ' under ' + shortPath(e.path) : '')
      )

    case 'WebFetch':
      return hostOf(String(e.url || ''))
    case 'WebSearch':
      return '"' + short(String(e.query || ''), 70) + '" on the web'

    case 'Task':
    case 'Agent': {
      const kind = e.subagent_type ? e.subagent_type + ' subagent' : 'subagent'
      const why = e.description || ''
      return kind + (why ? ' — ' + short(String(why), 70) : '')
    }

    case 'TodoWrite':
      return (
        'update the task list' +
        (Array.isArray(e.todos) ? ' (' + e.todos.length + ' items)' : '')
      )

    case 'AskUserQuestion': {
      const first = Array.isArray(e.questions) && e.questions[0]
      const q = first && first.question ? String(first.question) : 'a question'
      return 'ask you: ' + short(q, 80)
    }

    case 'ExitPlanMode':
      return 'present a plan for approval'

    case 'Skill':
      return 'load the ' + (e.skill || e.command || 'requested') + ' skill'

    case 'SlashCommand':
      return 'run the ' + (e.command || 'requested') + ' command'

    case 'TaskOutput':
      return 'read a background task result'

    default:
      return generic(e)
  }
}

// For tools we don't know: name the first couple of string arguments.
function generic(e) {
  const skip = new Set(['tool', 'agentId', 'tool_use_id', 'session_id', 'description'])
  const parts = []
  for (const key of Object.keys(e)) {
    if (skip.has(key)) continue
    const value = e[key]
    if (typeof value !== 'string' || !value) continue
    parts.push(key + '=' + short(oneLine(value), 40))
    if (parts.length === 2) break
  }
  if (!parts.length && typeof e.description === 'string') {
    return short(oneLine(e.description), DETAIL_LIMIT)
  }
  return parts.length ? parts.join(' ') : 'run'
}

// Commands that can destroy work or reach outside the project. Each rule is
// tested against one command in a chain, so `rm notes.txt && echo -rf` is not
// mistaken for a recursive delete.
const RISK_RULES = [
  [
    /\brm\b(?=[^\n]*(\s-[A-Za-z]*[rR][A-Za-z]*|\s--recursive))(?=[^\n]*(\s-[A-Za-z]*[fF][A-Za-z]*|\s--force))/,
    'delete files recursively',
  ],
  [/\bgit\s+reset\s+--hard\b/, 'discard commits and uncommitted work'],
  [
    /\bgit\s+push\b[^\n]*(--force(-with-lease)?|\s-f\b|\s\+\S)/,
    'rewrite remote history',
  ],
  [/\b(DROP|TRUNCATE)\s+(TABLE|DATABASE)\b/i, 'drop database data'],
  [/\bmkfs\b|\bdd\s+if=|>\s*\/dev\/[sh]d/, 'write to a raw disk'],
  [/:\s*\(\s*\)\s*\{[^}]*\}\s*;\s*:/, 'is a fork bomb'],
  [/\bsudo\b/, 'run as root'],
  [/\bchmod\s+(-[A-Za-z]+\s+)*777/, 'make files world-writable'],
  [/\bnpm\s+publish\b|\bcargo\s+publish\b/, 'publish a package'],
]

function riskOf(tool, e) {
  if (tool !== 'Bash') return null
  const command = String(e.command || '')

  // A download is only risky across its pipe, so this one needs the whole line.
  if (/\b(curl|wget)\b[^\n]*\|\s*(sudo\s+)?(ba)?sh\b/.test(command)) {
    return 'pipe the internet into a shell'
  }

  // git clean is destructive only when forced, and never in a dry run.
  if (/\bgit\s+clean\b/.test(command)) {
    const flags = command.match(/(?:^|\s)-[A-Za-z]+/g) || []
    const forced = flags.some((flag) => flag.includes('f')) || /--force\b/.test(command)
    const dryRun = flags.some((flag) => flag.includes('n'))
    if (forced && !dryRun) return 'delete untracked files'
  }

  // Everything else is judged per command in the chain.
  for (const segment of command.split(/\s*(?:&&|\|\||;)\s*/)) {
    for (const [rule, why] of RISK_RULES) if (rule.test(segment)) return why
  }
  return null
}

// ------------------------------------------------------------------- strings

function oneLine(text) {
  return text.replace(/\s+/g, ' ').trim()
}

function short(text, limit) {
  const clean = oneLine(String(text))
  return clean.length <= limit ? clean : clean.slice(0, Math.max(1, limit - 1)) + '…'
}

function lineCount(text) {
  if (!text) return 0
  return String(text).replace(/\n$/, '').split('\n').length
}

function lines(n) {
  return n + (n === 1 ? ' line' : ' lines')
}

function range(offset, limit) {
  const hasLimit = typeof limit === 'number' && limit > 0
  if (typeof offset !== 'number' && !hasLimit) return ''
  const from = typeof offset === 'number' ? offset : 1
  const to = hasLimit ? from + limit - 1 : ''
  return ':' + from + (to ? '-' + to : '')
}

function shortPath(path) {
  const clean = String(path)
  const home = clean.indexOf('/Users/')
  if (home === 0) {
    const parts = clean.split('/')
    // /Users/<user>/rest… → ~/rest…
    return parts.length > 3 ? '~/' + parts.slice(3).join('/') : clean
  }
  if (clean.length <= 60) return clean
  const cut = clean.lastIndexOf('/')
  return '…' + clean.slice(cut >= 0 ? cut : Math.max(0, clean.length - 24))
}

function hostOf(url) {
  const match = /^[a-z]+:\/\/([^/]+)/i.exec(url)
  return match ? match[1] : short(url, 60)
}
