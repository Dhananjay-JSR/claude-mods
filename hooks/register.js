/**
 * intent-lens — a Claude Mod that shows the intent of a tool call.
 *
 * Claude Code calls `register` once when the plugin loads and passes `on`.
 * Every hook receives ($, e, next): the mods API, the frozen event, and the
 * continuation.
 */

// Longest detail shown in the band, before the terminal width trims it further
const DETAIL_LIMIT = 110

let lastIntent = null

export function register(on) {
  // Fires for every tool, including subagent and MCP calls. Observing only:
  // it runs before the tool, then passes the event on unchanged.
  on('tool.call', async ($, e, next) => {
    const item = intentOf(e)
    lastIntent = item

    // Ask for a redraw so the band shows this intent before the tool runs.
    try {
      $.ui.invalidate('ui.render')
    } catch {
      // No UI (claude -p, headless): nothing to draw.
    }

    // Warn about calls that can destroy work. Best effort: a missing toast
    // API must not stop the tool.
    if (item.risk) {
      try {
        $.ui.toast('⚠ ' + item.tool + ' will ' + item.risk, { timeoutMs: 6000 })
      } catch {
        // Toast unavailable.
      }
    }

    return next(e)
  })

  // The band directly above the prompt. Drawn only while Claude is working.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const working = !e.props || e.props.isWorking !== false
    if (!lastIntent || !working) return next(e)

    const columns = (e.props && e.props.bodyColumns) || 80

    // Keep Claude Code's own band content below ours.
    const theirs = await next(e)

    return Box({
      flexDirection: 'column',
      children: [bandLine($, e, lastIntent, columns), theirs],
    })
  })
}

function bandLine($, e, item, columns) {
  const { Box, Text } = $.ui.resolve(e)
  const mark = item.risk ? '⚠' : '▸'
  const color = item.risk ? 'red' : 'cyan'
  const room = Math.max(16, columns - item.tool.length - 4)

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

// ---------------------------------------------------------------- heuristics

// Turn a tool call into { tool, detail, risk }. Pure: no mods API, no I/O.
function intentOf(e) {
  const tool = String(e.tool || 'Tool')
  return {
    tool: displayTool(tool),
    detail: describe(tool, e),
    risk: riskOf(tool, e),
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
        'write ' +
        (e.file_path ? shortPath(e.file_path) : 'a file') +
        (typeof e.content === 'string' ? ' (' + lineCount(e.content) + ' lines)' : '')
      )

    case 'Edit':
      return (
        'edit ' +
        (e.file_path ? shortPath(e.file_path) : 'a file') +
        (typeof e.old_string === 'string' && typeof e.new_string === 'string'
          ? ' (' + lineCount(e.old_string) + ' → ' + lineCount(e.new_string) + ' lines)'
          : '')
      )

    case 'MultiEdit':
      return (
        'edit ' +
        (e.file_path ? shortPath(e.file_path) : 'a file') +
        (Array.isArray(e.edits) ? ' (' + e.edits.length + ' changes)' : '')
      )

    case 'NotebookEdit':
      return 'edit notebook ' + (e.notebook_path ? shortPath(e.notebook_path) : '')

    case 'Grep': {
      const where = e.path ? ' in ' + shortPath(e.path) : ''
      return 'search for "' + short(String(e.pattern || ''), 50) + '"' + where
    }

    case 'Glob':
      return (
        'find files matching ' +
        short(String(e.pattern || '*'), 60) +
        (e.path ? ' under ' + shortPath(e.path) : '')
      )

    case 'WebFetch':
      return 'fetch ' + hostOf(String(e.url || ''))
    case 'WebSearch':
      return 'search the web for "' + short(String(e.query || ''), 70) + '"'

    case 'Task':
    case 'Agent': {
      const kind = e.subagent_type ? e.subagent_type + ' subagent' : 'subagent'
      const why = e.description || ''
      return 'start a ' + kind + (why ? ' — ' + short(String(why), 70) : '')
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

// Commands that can destroy work or reach outside the project.
const RISK_RULES = [
  [/\brm\s+-[A-Za-z]*r[A-Za-z]*f|\brm\s+-[A-Za-z]*f[A-Za-z]*r/, 'delete files recursively'],
  [/\bgit\s+reset\s+--hard\b/, 'discard commits and uncommitted work'],
  [/\bgit\s+clean\s+-[A-Za-z]*[fd]/, 'delete untracked files'],
  [/\bgit\s+push\b[^\n]*(--force|--force-with-lease|\s-f\b)/, 'rewrite remote history'],
  [/\b(DROP|TRUNCATE)\s+(TABLE|DATABASE)\b/i, 'drop database data'],
  [/\bmkfs\b|\bdd\s+if=|>\s*\/dev\/[sh]d/, 'write to a raw disk'],
  [/:\s*\(\s*\)\s*\{[^}]*\}\s*;\s*:/, 'is a fork bomb'],
  [/\b(curl|wget)\b[^\n]*\|\s*(sudo\s+)?(ba)?sh\b/, 'pipe the internet into a shell'],
  [/\bsudo\b/, 'run as root'],
  [/\bchmod\s+-R\s+777/, 'make files world-writable'],
  [/\bnpm\s+publish\b|\bcargo\s+publish\b/, 'publish a package'],
]

function riskOf(tool, e) {
  if (tool !== 'Bash') return null
  const cmd = String(e.command || '')
  for (const [re, why] of RISK_RULES) if (re.test(cmd)) return why
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
  return String(text).split('\n').length
}

function range(offset, limit) {
  if (typeof offset !== 'number' && typeof limit !== 'number') return ''
  const from = typeof offset === 'number' ? offset : 1
  const to = typeof limit === 'number' ? from + limit - 1 : ''
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
  const cwd = clean.lastIndexOf('/')
  return clean.length > 60 ? '…' + clean.slice(cwd) : clean
}

function hostOf(url) {
  const match = /^[a-z]+:\/\/([^/]+)/i.exec(url)
  return match ? match[1] : short(url, 60)
}
