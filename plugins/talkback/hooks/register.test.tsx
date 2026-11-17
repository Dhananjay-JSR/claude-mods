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
  on('prompt.compose', () => ({ sections: [] }))
  on('prompt.submit', (_, e) => ({ text: e.text }))
  on('command.run', () => ({ text: '' }))

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
    // Claude was never told to open with a summary here, so more than the opening is read.
    'say: Fixed the bug in a b. See docs. Code block. Done! | espeak-ng: Fixed the bug in a b. See docs. Code block. Done!',
  )

  // The voice that spoke is kept, a long reply is cut short, a subagent's answer is not the reply.
  await $.turn.complete({ ...TURN, agentId: 'a', answer: 'Report.' })
  await $.turn.complete({ ...TURN, answer: `Short. ${'Long sentence here. '.repeat(60)}` })
  await settle()
  expect(ran.length).toBe(3)
  expect(ran[2]?.startsWith('espeak-ng: Short. Long')).toBe(true)
  expect(ran[2]?.endsWith('More on screen.')).toBe(true)
  expect((ran[2]?.length ?? 0) < 700).toBe(true)

  // After /talkback init the warm neural voice speaks, and the system voice stays quiet.
  isNeural = true
  await $.turn.complete({ ...TURN, answer: 'Neural now.' })
  await settle()
  expect(ran.length).toBe(3)
  expect(posted.at(-1)).toBe('http://127.0.0.1:47821/speak?voice=af_heart&lang=en-us: Neural now.')

  // brief, the default: once Claude has been told to open with a spoken summary, only that is read.
  await $.prompt.compose({
    model: 'model',
    promptModel: 'model',
    surfaces: ['terminal'],
    tools: [],
    outputStyle: { name: 'default', isKeepingCodingInstructions: true },
    traits: [],
  } as Parameters<typeof $.prompt.compose>[0])
  const reply = 'All twelve tests pass.\n\n## Details\n\n- `a.ts` changed'
  await $.turn.complete({ ...TURN, answer: reply })
  await settle()
  expect(posted.at(-1)?.endsWith(': All twelve tests pass.')).toBe(true)

  // A prompt that asks for all of it gets all of it, for that turn.
  await $.prompt.submit({ text: 'Explain it completely, not just a summary' } as Parameters<typeof $.prompt.submit>[0])
  await $.turn.complete({ ...TURN, answer: reply })
  await settle()
  expect(posted.at(-1)?.endsWith(': All twelve tests pass. Details a.ts changed')).toBe(true)

  // And /talkback more reads the last reply in full after a brief reading.
  await $.prompt.submit({ text: 'thanks' } as Parameters<typeof $.prompt.submit>[0])
  await $.turn.complete({ ...TURN, answer: reply })
  await settle()
  expect(posted.at(-1)?.endsWith(': All twelve tests pass.')).toBe(true)
  await $.command.run({ command: 'talkback', args: 'more' } as Parameters<typeof $.command.run>[0])
  await settle()
  expect(posted.at(-1)?.endsWith(': All twelve tests pass. Details a.ts changed')).toBe(true)
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
  let finish = () => {}
  const downloaded = new Promise<void>(done => {
    finish = done
  })
  // The server's feed, a line split across two pieces as a pipe may split it.
  on('process.spawn', async function* (_, e) {
    if (e.argv[0] !== 'uv') {
      return { value: { code: 0, signal: null } }
    }

    await settle()
    yield { stream: 'stdout' as const, text: 'progress: the ears (480 MB)|42\n' }
    await downloaded
    yield { stream: 'stdout' as const, text: 'progress: done\nready\nstate: listening\nheard: run the ' }
    yield { stream: 'stdout' as const, text: 'tests\nheard: Stop.\n' }
    await settle()

    return { value: { code: 0, signal: null } }
  })
  const ran: string[] = []
  on('process.run', (_, e) => {
    ran.push(e.argv.join(' '))

    return { value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('command.run', () => ({ text: '' }))

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  // Cast: a newer build's typings ask a test for the fields the engine stamps.
  await $.command.run({ command: 'talkback', args: 'live' } as Parameters<typeof $.command.run>[0])
  await settle()
  await settle()

  // While a model comes down, the row above the prompt is its progress bar.
  const band = await $.ui.mount({
    plugin: 'talkback',
    component: 'AbovePrompt',
    surface: 'terminal',
    props: { hasSurvey: false, isWorking: false, maxRows: 10 },
  } as Parameters<typeof $.ui.mount>[0])
  expect((await band.find({ type: 'Text' }))?.text).toBe(
    '🎙 Downloading the ears (480 MB) ████████░░░░░░░░░░░░ 42%',
  )
  await band.unmount()
  finish()
  await settle()
  await settle()
  await settle()

  expect(submitted.length).toBe(1)
  expect(submitted[0]?.startsWith('run the tests (')).toBe(true)
  expect(submitted[0]?.includes('"asUser":true')).toBe(true)
  expect(posted.includes('listen?on=1&lang=en-us&headphones=0&pause=2')).toBe(true)
  expect(posted.at(-1)).toBe('stop')

  // Removing the models closes the microphone, ends the server, then deletes them.
  await $.command.run({ command: 'talkback', args: 'remove' } as Parameters<typeof $.command.run>[0])
  expect(posted.slice(-2).join(' ')).toBe('listen?on=0&lang=en-us&headphones=0&pause=2 quit')
  expect(ran.at(-1)?.endsWith('talkback_server.py --remove')).toBe(true)
})

test('a reply is spoken while it streams, sentence by sentence, and not again when the turn ends', async ($, on) => {
  const posted: string[] = []
  on('settings.read', () => ({ value: { voiceEnabled: true } }))
  on('store.get', () => ({ value: true }))
  on('http.fetch', (_, e) => {
    posted.push(`${e.url.replace(/^.*\/(\w+).*$/, '$1')}: ${e.init?.body ?? ''}`)

    return { value: { status: 200, ok: true, headers: {}, text: '' } }
  })
  on('turn.complete', (_, e) => ({ text: e.answer }))
  // The model's reply, in the pieces it arrives in: a sentence ends mid-piece, code is skipped.
  on('turn.step', async function* (_, e) {
    for (const text of ['The tests ', 'pass. I chan', 'ged one file.\n\n```ts\nlet x = 1\n', '```\nDone', '!']) {
      yield { kind: 'text' as const, index: 0, text }
      await settle()
    }

    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn' as const, usage: null }
  })

  const step = { turnId: 'streamed', index: 0, model: 'model', messageCount: 1 }
  const seen: string[] = []

  for await (const chunk of $.turn.step(step as Parameters<typeof $.turn.step>[0])) {
    if (chunk.kind === 'text') {
      seen.push(chunk.text)
    }
  }

  await settle()
  // Every piece still reaches the screen, and each sentence was sent to the voice as it ended.
  expect(seen.join('')).toBe('The tests pass. I changed one file.\n\n```ts\nlet x = 1\n```\nDone!')
  expect(posted.filter(line => line.startsWith('speak')).join(' | ')).toBe(
    'speak: The tests pass. | speak: I changed one file. Code block. | speak: Done!',
  )

  const said = posted.length
  await $.turn.complete({ ...TURN, turnId: 'streamed', answer: 'The tests pass.' })
  await settle()
  expect(posted.length).toBe(said)
})
