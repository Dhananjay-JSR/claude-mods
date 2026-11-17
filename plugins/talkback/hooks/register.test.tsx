import { expect, test } from 'claude-code/testing'

const TURN = { durationMs: 1, isAborted: false, turnId: 't', reason: 'answer' } as const
// The hooks environment has timers; its typings do not declare this one.
declare const setTimeout: (run: () => void, ms: number) => unknown
const settle = () => new Promise<void>(done => setTimeout(done, 50))

test('a reply is spoken by the first voice the machine has, code skipped, only while voice is on', async ($, on) => {
  const ran: string[] = []
  let voiceEnabled = false
  let isNeural = false
  const posted: string[] = []
  on('settings.read', () => ({ value: { voiceEnabled } }))
  on('store.get', () => ({ value: isNeural }))
  on('store.set', () => ({ value: undefined }))
  on('http.fetch', (_, e) => {
    posted.push(`${e.url}: ${e.init?.body ?? ''}`)

    return { value: { status: 200, ok: true, headers: {}, text: '' } }
  })
  // A Linux machine: no `say`, espeak-ng speaks.
  on('process.spawn', async function* (_, e) {
    const name = e.argv[4] ?? e.argv[0]
    ran.push(`${name}: ${e.input}`)

    if (name === 'say') {
      throw new Error('ENOENT')
    }

    yield { stream: 'stdout' as const, text: '4242\n' }

    return { value: { code: 0, signal: null } }
  })
  const killed: string[] = []
  on('process.run', (_, e) => {
    killed.push(e.argv.join(' '))

    return { value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('turn.complete', (_, e) => ({ text: e.answer }))

  await $.turn.complete({ ...TURN, answer: 'Silent.' })
  await settle()
  expect(ran.length).toBe(0)

  voiceEnabled = true
  await $.turn.complete({
    ...TURN,
    answer: 'Fixed the **bug** in `a_b`. See [docs](https://x.y).\n\n```js\nlet x = 1\n```\nDone!',
  })
  await settle()
  expect(ran.join(' | ')).toBe(
    'say: Fixed the bug in a b. See docs. | espeak-ng: Fixed the bug in a b. See docs.',
  )

  // The voice that spoke is kept, a long reply is cut short, a subagent's answer is not the reply.
  await $.turn.complete({ ...TURN, agentId: 'a', answer: 'Report.' })
  await $.turn.complete({ ...TURN, answer: `Short. ${'Long sentence here. '.repeat(60)}` })
  await settle()
  expect(ran.length).toBe(3)
  expect(ran[2]?.startsWith('espeak-ng: Short. Long')).toBe(true)
  expect((ran[2]?.length ?? 0) < 700).toBe(true)

  // After /talkback init the warm neural voice speaks, and the system voice stays quiet.
  isNeural = true
  await $.turn.complete({ ...TURN, answer: 'Neural now.' })
  await settle()
  expect(ran.length).toBe(3)
  expect(posted.at(-1)).toBe('http://127.0.0.1:47821/speak?voice=af_heart&lang=en-us: Neural now.')

  // brief, the default: only the opening paragraph is read.
  await $.turn.complete({ ...TURN, answer: 'All twelve tests pass.\n\n## Details\n\n- `a.ts` changed' })
  await settle()
  expect(posted.at(-1)?.endsWith(': All twelve tests pass.')).toBe(true)
})

test('hands-free: what the server hears is submitted as the person, and "stop" only stops', async ($, on) => {
  const submitted: string[] = []
  const posted: string[] = []
  on('settings.read', () => ({ value: { voiceEnabled: true } }))
  on('store.get', () => ({ value: true }))
  on('store.set', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
  on('command.register', () => ({ value: { command: 'talkback' } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('http.fetch', (_, e) => {
    posted.push(e.url.replace('http://127.0.0.1:47821/', ''))

    return { value: { status: 200, ok: true, headers: {}, text: '' } }
  })
  on('prompt.submit', (_, e) => {
    submitted.push(`${e.text} (${JSON.stringify(e.origin)})`)

    return { text: e.text }
  })
  // The server's feed, a line split across two pieces as a pipe may split it.
  on('process.spawn', async function* (_, e) {
    if (e.argv[0] !== 'uv') {
      return { value: { code: 0, signal: null } }
    }

    await settle()
    yield { stream: 'stdout' as const, text: 'ready\nstate: listening\nheard: run the ' }
    yield { stream: 'stdout' as const, text: 'tests\nheard: Stop.\n' }
    await settle()

    return { value: { code: 0, signal: null } }
  })
  on('command.run', () => ({ text: '' }))

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  // Cast: a newer build's typings ask a test for the fields the engine stamps.
  await $.command.run({ command: 'talkback', args: 'live' } as Parameters<typeof $.command.run>[0])
  await settle()
  await settle()
  await settle()

  expect(submitted.length).toBe(1)
  expect(submitted[0]?.startsWith('run the tests (')).toBe(true)
  expect(submitted[0]?.includes('"asUser":true')).toBe(true)
  expect(posted.includes('listen?on=1&lang=en-us&headphones=0')).toBe(true)
  expect(posted.at(-1)).toBe('stop')
})
