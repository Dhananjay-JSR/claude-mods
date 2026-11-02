// Runs the mod's hooks against a stubbed mods API: no session, no network,
// no model. `claude plugin test` needs a newer Claude Code, so this is plain
// Node:
//
//   node tests/intent.test.mjs

import { readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const SOURCE = new URL('../hooks/register.js', import.meta.url)
let copyCount = 0

// Load a fresh instance of the mod. A new copy means a new module scope, so
// one test's mode, history, or UI flag can never leak into the next.
async function loadMod() {
  const copy = join(tmpdir(), 'intent-lens-' + process.pid + '-' + copyCount++ + '.mjs')
  await writeFile(copy, await readFile(SOURCE, 'utf8'))
  let mod
  try {
    mod = await import(pathToFileURL(copy).href)
  } finally {
    await rm(copy, { force: true })
  }

  const hooks = new Map()
  const on = (event, a, b) => {
    const matcher = typeof a === 'function' ? null : a
    const fn = typeof a === 'function' ? a : b
    const key = event + (matcher ? JSON.stringify(matcher) : '')
    if (hooks.has(key)) throw new Error('registered twice: ' + key)
    hooks.set(key, fn)
  }
  mod.register(on)

  return {
    tool: hooks.get('tool.call'),
    render: hooks.get('ui.render{"component":"AbovePrompt"}'),
    intent: hooks.get('command.run{"command":"intent"}'),
    log: hooks.get('command.run{"command":"intent-log"}'),
    session: hooks.get('session.start'),
    turnStart: hooks.get('turn.start'),
    turnComplete: hooks.get('turn.complete'),
    promptSubmit: hooks.get('prompt.submit'),
  }
}

// Every call is recorded; nothing leaves the process.
function dollar(options = {}) {
  const answer = options.answer ?? { isAnswered: false }
  const saved = options.saved ?? {}
  const log = { toasts: [], requests: [], commands: [], invalidates: 0 }

  const $ = {
    ui: {
      invalidate: () => {
        log.invalidates += 1
      },
      toast: (text) => log.toasts.push(text),
      resolve: () => ({
        Box: (props) => ({ kind: 'box', ...props }),
        Text: (props) => ({ kind: 'text', ...props }),
      }),
    },
    model: {
      complete: async (request) => {
        log.requests.push(request)
        if (options.hang) return new Promise(() => {})
        return answer
      },
    },
    clock: {
      after:
        options.clock ??
        ((ms, fn) => {
          const timer = setTimeout(fn, 60_000)
          return { cancel: () => clearTimeout(timer) }
        }),
    },
    store: {
      get: async (key) => saved[key],
      set: async (key, value) => {
        saved[key] = value
      },
    },
    command: {
      register: async (command) => {
        log.commands.push(command)
        if (options.registerFails) throw new Error('the name is taken')
      },
    },
  }
  return { $, log, saved }
}

// Events are deeply frozen in Claude Code; catch any mutation here too.
function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const inner of Object.values(value)) deepFreeze(inner)
    Object.freeze(value)
  }
  return value
}

async function fire(mod, event, options = {}) {
  const { $, log, saved } = dollar(options)
  const result = options.result ?? { ok: true }
  let calls = 0
  const out = await mod.tool($, deepFreeze({ ...event }), async () => {
    calls += 1
    return result
  })
  return { log, saved, out, result, calls }
}

// The whole tree the band would draw right now, one line per row.
async function band(mod) {
  const { $ } = dollar()
  const tree = await mod.render(
    $,
    deepFreeze({ props: { isWorking: true, bodyColumns: 100 } }),
    async () => 'engine',
  )
  if (!tree || !tree.children) return '(nothing)'
  const lines = []
  for (const child of tree.children) {
    if (!child || typeof child !== 'object') continue
    if (child.kind === 'text') lines.push(child.children.join(''))
    else if (child.kind === 'box') {
      lines.push(child.children.map((cell) => cell.children.join('')).join(' '))
    }
  }
  return lines.join('\n')
}

let pass = 0
let fail = 0
function check(name, actual, expected) {
  if (JSON.stringify(actual) === JSON.stringify(expected)) {
    pass += 1
    return
  }
  fail += 1
  console.log(
    'FAIL ' + name +
      '\n  expected ' + JSON.stringify(expected) +
      '\n  actual   ' + JSON.stringify(actual),
  )
}

// ---------------------------------------------------------------------------
// Session start: register the commands, restore settings, clear old history
// ---------------------------------------------------------------------------
{
  const mod = await loadMod()
  const { $, log } = dollar({ saved: { enabled: false, mode: 'model' } })
  await mod.session($, deepFreeze({}), async () => undefined)

  check('registers both commands', log.commands.map((c) => c.name).sort(), ['intent', 'intent-log'])
  check(
    'restores saved state',
    (await mod.intent($, { args: '' })).text,
    'intent line is off, engine model. Use /intent on, off, toggle, mode, log, or clear.',
  )

  // A resumed session reuses the process: history must not carry over
  await mod.intent(dollar().$, { args: 'on' })
  await fire(mod, { tool: 'Read', file_path: '/Users/x/a.ts' })
  await mod.session(dollar().$, deepFreeze({}), async () => undefined)
  check(
    'resets history on a new session',
    (await mod.log(dollar().$, { args: '' })).text,
    'no tool calls recorded yet.',
  )
}

// ---------------------------------------------------------------------------
// Headless: no UI has drawn, so no tokens are spent
// ---------------------------------------------------------------------------
{
  const mod = await loadMod()
  const { log } = await fire(mod, {
    tool: 'Edit',
    file_path: '/Users/x/app/src/a.ts',
    old_string: 'a',
    new_string: 'b',
  })
  check('headless never calls the model', log.requests.length, 0)
}

// ---------------------------------------------------------------------------
// auto: local for reads, the model for edits, with a bounded request
// ---------------------------------------------------------------------------
{
  const mod = await loadMod()
  await band(mod) // draw once, so the mod knows a UI exists

  let run = await fire(mod, {
    tool: 'Read',
    file_path: '/Users/x/app/src/auth.ts',
    offset: 10,
    limit: 11,
  })
  check('read stays local', run.log.requests.length, 0)
  check('read band', await band(mod), '▸ Read ~/app/src/auth.ts:10-20')

  run = await fire(
    mod,
    { tool: 'Edit', file_path: '/Users/x/app/src/a.ts', old_string: 'a\nb\nc', new_string: 'a\nb\nc\nd\ne' },
    { answer: '"Add a null guard to the token parser."\n' },
  )
  check('edit asks the model once', run.log.requests.length, 1)
  check('model name', run.log.requests[0].model, 'haiku')
  check('max tokens', run.log.requests[0].maxTokens, 60)
  check('request keys', Object.keys(run.log.requests[0]).sort(), ['maxTokens', 'model', 'prompt'])
  check('prompt names the tool', run.log.requests[0].prompt.includes('Tool: Edit'), true)
  check('prompt carries the draft', run.log.requests[0].prompt.includes('Draft: '), true)
  check('edit band', await band(mod), '✦ Edit Add a null guard to the token parser')

  // A model that does not answer falls back to the local line
  run = await fire(
    mod,
    { tool: 'Edit', file_path: '/Users/x/app/src/a.ts', old_string: 'a\nb\nc', new_string: 'x' },
    { answer: { isAnswered: false, reason: 'timeout' } },
  )
  check('fallback tried the model', run.log.requests.length, 1)
  check('fallback band', await band(mod), '▸ Edit ~/app/src/a.ts (3 lines → 1 line)')

  // Newer builds resolve to { isAnswered, text }; both contracts are read
  run = await fire(
    mod,
    { tool: 'Write', file_path: '/Users/x/app/src/b.ts', content: 'x' },
    { answer: { isAnswered: true, text: 'Write the migration stub' } },
  )
  check('accepts the object contract', await band(mod), '✦ Write Write the migration stub')
}

// ---------------------------------------------------------------------------
// The call passes through untouched, and the outcome reaches the log
// ---------------------------------------------------------------------------
{
  const mod = await loadMod()
  await band(mod)

  const sentinel = { result: 'boom', text: 'boom', isError: true }
  const run = await fire(mod, { tool: 'Bash', command: 'ls' }, { result: sentinel })
  check('next called once', run.calls, 1)
  check('result identity preserved', run.out === sentinel, true)
  check('failed call logged', (await mod.log(dollar().$, { args: '' })).text, '✗  1. ▸ Bash · run ls')

  await fire(mod, { tool: 'Bash', command: 'rm -rf build' }, { result: { deny: 'no' } })
  check('second line in the log', (await mod.log(dollar().$, { args: '' })).text.split('\n').length, 2)
}

// ---------------------------------------------------------------------------
// Risk is never delegated to the model, and never silenced by /intent off
// ---------------------------------------------------------------------------
{
  const mod = await loadMod()
  await band(mod)
  await mod.intent(dollar().$, { args: 'mode model' })

  const run = await fire(mod, {
    tool: 'Bash',
    command: 'rm -rf ~/projects/old',
    description: 'clean up',
  })
  check('risk skips the model', run.log.requests.length, 0)
  check('risk toast', run.log.toasts, ['⚠ Bash will delete files recursively'])
  check('risk band', await band(mod), '⚠ Bash clean up')
}

{
  const mod = await loadMod()
  await band(mod)
  await mod.intent(dollar().$, { args: 'off' })

  const run = await fire(mod, { tool: 'Bash', command: 'git reset --hard HEAD~1' })
  check('off still warns', run.log.toasts.length, 1)
  check('off hides the band', await band(mod), '(nothing)')
}

// ---------------------------------------------------------------------------
// The engine switch
// ---------------------------------------------------------------------------
{
  const mod = await loadMod()
  await band(mod)

  await mod.intent(dollar().$, { args: 'mode local' })
  let run = await fire(mod, { tool: 'Edit', file_path: '/Users/x/a.ts', old_string: 'a', new_string: 'b' })
  check('local mode never calls the model', run.log.requests.length, 0)

  await mod.intent(dollar().$, { args: 'mode model' })
  run = await fire(
    mod,
    { tool: 'Read', file_path: '/Users/x/app/src/c.ts' },
    { answer: 'Check how the cache key is built' },
  )
  check('model mode phrases a read', run.log.requests.length, 1)
  check('model mode band', await band(mod), '✦ Read Check how the cache key is built')

  const bad = await mod.intent(dollar().$, { args: 'mode fastest' })
  check('unknown engine refused', bad.text, 'engine is model. Use /intent mode local, auto, or model.')
}

// ---------------------------------------------------------------------------
// Risk patterns: forms a reviewer flagged, plus dry runs that must stay quiet
// ---------------------------------------------------------------------------
{
  const mod = await loadMod()
  const flagged = [
    'rm -r -f dist',
    'rm --recursive --force dist',
    'git push origin +main',
    'chmod 777 -R .',
    "find . -name '*.tmp' -delete",
  ]
  for (const command of flagged) {
    const run = await fire(mod, { tool: 'Bash', command })
    check('flags: ' + command, run.log.toasts.length, 1)
  }

  const quiet = ['rm -i file', 'git clean -nd', 'git push origin main', 'rm notes.txt && echo -rf']
  for (const command of quiet) {
    const run = await fire(mod, { tool: 'Bash', command })
    check('ignores: ' + command, run.log.toasts.length, 0)
  }
}

// ---------------------------------------------------------------------------
// A slow model loses to the local line instead of holding the tool open
// ---------------------------------------------------------------------------
{
  const mod = await loadMod()
  await band(mod)
  const run = await fire(
    mod,
    { tool: 'Edit', file_path: '/Users/x/a.ts', old_string: 'a', new_string: 'b' },
    {
      hang: true,
      clock: (ms, fn) => {
        const timer = setTimeout(fn, 0)
        return { cancel: () => clearTimeout(timer) }
      },
    },
  )
  check('slow model asked once', run.log.requests.length, 1)
  check('slow model falls back', await band(mod), '▸ Edit ~/a.ts (1 line → 1 line)')
}

// ---------------------------------------------------------------------------
// A taken command name must not abort the rest of session start
// ---------------------------------------------------------------------------
{
  const mod = await loadMod()
  const { $, log } = dollar({ saved: { enabled: false }, registerFails: true })
  await mod.session($, deepFreeze({}), async () => undefined)
  check('tried both commands', log.commands.map((c) => c.name), ['intent', 'intent-log'])
  check(
    'restored state after a failed registration',
    (await mod.intent($, { args: '' })).text,
    'intent line is off, engine auto. Use /intent on, off, toggle, mode, log, or clear.',
  )
}

// ---------------------------------------------------------------------------
// A described shell command shows its intent, not the pipeline
// ---------------------------------------------------------------------------
{
  const mod = await loadMod()
  await band(mod)

  const described = await fire(mod, {
    tool: 'Bash',
    command:
      'curl -s "https://api.github.com/users/x/repos?per_page=100" | jq -r ".[].language // empty" | sort | uniq -c | sort -rn | head -5',
    description: 'Count the top five languages across your public repos',
  })
  check(
    'bash shows only the description',
    (await band(mod)).split('\n')[0],
    '▸ Bash Count the top five languages across your public repos',
  )
  check('a described command skips the model', described.log.requests.length, 0)

  const bare = await fire(mod, { tool: 'Bash', command: 'ls -la | wc -l' }, { answer: 'Count the files here' })
  check('an undescribed command asks the model', bare.log.requests.length, 1)
  check('the model words the undescribed command', (await band(mod)).split('\n')[0], '✦ Bash Count the files here')
}

// ---------------------------------------------------------------------------
// A pipeline is decoded into the verbs of its stages
// ---------------------------------------------------------------------------
{
  const mod = await loadMod()
  await band(mod)

  await fire(mod, {
    tool: 'Bash',
    command:
      'curl -s "https://api.github.com/users/x/repos?per_page=100" | jq -r ".[].language // empty" | sort | uniq -c | sort -rn | head -5',
    description: 'Count the top five languages across your repos',
  })
  check(
    'the stage line follows the description',
    await band(mod),
    [
      '▸ Bash Count the top five languages across your repos',
      '       6 steps · fetch → pick fields → sort → count → rank → top 5',
    ].join('\n'),
  )

  // A pipe inside a quoted jq program is not a new stage
  await fire(mod, {
    tool: 'Bash',
    command: `curl -s https://example.com/data.json | jq -r '.[] | .name' | head -3`,
    description: 'List names',
  })
  check(
    'quoted pipes are not stages',
    (await band(mod)).split('\n')[1],
    '       3 steps · fetch → pick fields → top 3',
  )
}

// ---------------------------------------------------------------------------
// More tools, and quieter output
// ---------------------------------------------------------------------------
{
  const mod = await loadMod()
  await band(mod)

  // A subagent's calls do not take over the main line
  await fire(mod, { tool: 'Bash', command: 'ls', description: 'list files', agentId: 'a1' })
  check('subagent calls are ignored', await band(mod), '(nothing)')

  // A two-stage pipe reads fine without a decode
  await fire(mod, { tool: 'Bash', command: 'ps aux | grep node', description: 'Find the dev server' })
  check('two-stage pipes stay one line', await band(mod), '▸ Bash Find the dev server')

  // New stage verbs, and a jq program read for what it does
  await fire(mod, {
    tool: 'Bash',
    command: `gh pr list --json number,title | jq -r '.[] | select(.number > 10) | .title' | sort | head -5`,
    description: 'List recent PR titles',
  })
  check(
    'gh and jq are decoded',
    (await band(mod)).split('\n')[1],
    '       4 steps · query GitHub → filter → sort → top 5',
  )

  // More tools get their own phrasing
  await fire(mod, { tool: 'PowerShell', command: 'Get-ChildItem', description: 'list the folder' })
  check('PowerShell reads like Bash', await band(mod), '▸ PowerShell list the folder')

  await fire(mod, {
    tool: 'WebFetch',
    url: 'https://example.com/docs',
    prompt: 'extract the rate limit table',
  })
  check('WebFetch says why', await band(mod), '▸ WebFetch example.com — extract the rate limit table')

  await fire(mod, { tool: 'TaskCreate', subject: 'write the migration' })
  check('TaskCreate is named', await band(mod), '▸ TaskCreate add a task: write the migration')
}

// ---------------------------------------------------------------------------
// An intent never outlives its turn
// ---------------------------------------------------------------------------
{
  const mod = await loadMod()
  await band(mod)

  await fire(mod, { tool: 'Bash', command: 'ls' })
  check('intent shows while the turn runs', await band(mod), '▸ Bash run ls')

  await mod.turnComplete(dollar().$, deepFreeze({}), async () => undefined)
  check('a finished turn clears the band', await band(mod), '(nothing)')

  await fire(mod, { tool: 'Bash', command: 'pwd' })
  await mod.turnComplete(dollar().$, deepFreeze({ agentId: 'agent-1' }), async () => undefined)
  check('a subagent turn leaves it alone', await band(mod), '▸ Bash run pwd')

  await fire(mod, { tool: 'Bash', command: 'date' })
  await mod.promptSubmit(dollar().$, deepFreeze({ text: 'hi' }), async () => undefined)
  check('a new prompt clears the band', await band(mod), '(nothing)')

  await fire(mod, { tool: 'Bash', command: 'whoami' })
  await mod.turnStart(dollar().$, deepFreeze({ turnId: 't1' }), async () => undefined)
  check('a new turn clears the band', await band(mod), '(nothing)')
}

// ---------------------------------------------------------------------------
// Formatting details
// ---------------------------------------------------------------------------
{
  const mod = await loadMod()
  await band(mod)
  await fire(mod, { tool: 'Write', file_path: '/Users/x/app/src/a.ts', content: 'a\nb\n' })
  check('trailing newline is not a line', await band(mod), '▸ Write ~/app/src/a.ts (2 lines)')
}

console.log(pass + ' pass, ' + fail + ' fail')
process.exit(fail ? 1 : 0)
