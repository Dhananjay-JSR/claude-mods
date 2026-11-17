import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Status } from '../types'

const override = atom({ plugin: 'talkback', key: 'override' } as const, null)
// Hands-free: the microphone is open and what the person says is submitted.
const isLive = atom({ plugin: 'talkback', key: 'isLive' } as const, false)
const status = atom({ plugin: 'talkback', key: 'status' } as const, 'idle')
const download = atom({ plugin: 'talkback', key: 'download' } as const, null)

// A reply as it streams in: what has arrived and not been said yet, and where the reading stands.
type Reading = { pending: string; isInCode: boolean; isOver: boolean; hasSpoken: boolean }

type Settings = { voice: string; lang: string; length: string; hasHeadphones: boolean; pause: number }

// A listener cannot skim: past this many characters the rest stays on screen.
const SPOKEN_LIMIT = 600

// The local server: the neural voice and the ears (server/talkback_server.py).
const SERVER = 'http://127.0.0.1:47821'

const SPOKEN_REPLIES = `The person is listening, not reading: a text-to-speech voice reads the first paragraph of each of your final replies aloud, and nothing after it. Open every final reply with one short paragraph, three sentences at most, in plain spoken language that stands on its own: the outcome or the answer first, then anything the person has to decide or do. No markdown, code, file paths, URLs or lists in that paragraph. Write the details after it as usual.`

const DICTATED_PROMPTS = `The person's messages are dictated and sent as soon as they pause, so read past likely mis-hearings, and when a request to change or delete something is ambiguous, ask before acting on it.`

// A prompt that asks for the whole answer is answered in full, whatever the length setting.
const ASKS_FOR_ALL =
  /\b(complete(ly)?|entire(ly)?|whole|in full|full(y)?|everything|all of it|in detail|detailed|word for word|read it all|(not|without) (just )?a summary)\b/i

// Said while Claude is working: these go to the side, whatever they ask...
const ASKS_ASIDE = /^(by the way|btw|quick question|side question)\b[,:.]?\s*/i
// ...and these to the running task.
const TELLS_CLAUDE = /^tell claude\b[,:.]?\s*/i

const ANSWER_ASIDE = `Answer it now, from what you already know, in two or three plain spoken sentences: no markdown, code, lists or file paths.`

const SAYS_STOP = /^(stop|quiet|be quiet|enough)[.!]?$/i
// Over the voice a word or two of the voice itself may lead the transcript.
const SAYS_STOP_OVER = /^(\S+\s+){0,2}(stop|stop it|stop talking|be quiet|quiet|enough|shut up|pause)[.!?]*$/i

// Said or typed after a short reading: the last reply again, all of it.
const ASKS_FOR_MORE =
  /^(please )?((read|say|tell me|give me) (it all|the rest|everything|all of it|more|the whole thing)|continue|go on|keep going|more|read on)[.!]?$/i

const STATUS: Record<Status, string> = {
  idle: '',
  listening: '● listening',
  hearing: '● hearing you',
  transcribing: '● transcribing',
  speaking: '◆ speaking',
}

// The surfaces have no progress element: twenty cells of text are the bar.
const bar = (percent: number) => {
  const filled = Math.round(percent / 5)

  return `${'█'.repeat(filled)}${'░'.repeat(20 - filled)} ${percent}%`
}

// Prints its own process id, then becomes the voice: a stop kills that id.
const killable = (...argv: string[]) => ['sh', '-c', 'echo $$; exec "$@"', 'sh', ...argv]

// Each reads the text on standard input, so no reply is ever taken for a flag.
// Tried in this order, and the first that speaks is kept: macOS, Linux, Windows.
// shortcut: killing spd-say leaves its daemon talking to the end of the reply; upgrade with `spd-say --stop` if Linux users hit it.
const SYSTEM_VOICES = [
  killable('say', '-f', '-'),
  killable('espeak-ng', '--stdin'),
  killable('espeak', '--stdin'),
  killable('spd-say', '--wait', '--pipe-mode'),
  [
    'powershell.exe',
    '-NoProfile',
    '-Command',
    '$PID; [Console]::InputEncoding = [Text.Encoding]::UTF8; Add-Type -AssemblyName System.Speech; (New-Object System.Speech.Synthesis.SpeechSynthesizer).Speak([Console]::In.ReadToEnd())',
  ],
]

// Markdown as a listener wants it: code is skipped, not read out symbol by symbol.
const sentences = (markdown: string) =>
  markdown
    .replace(/```[\s\S]*?(```|$)/g, '\nCode block.\n')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/https?:\/\/\S+/g, 'link')
    .replace(/^\s*[-*+]\s+/gm, '')
    .replace(/[`*]/g, '')
    .replace(/[_#>|]|^\s*[-:| ]{3,}$/gm, ' ')
    .split(/(?<=[.!?:])\s+|\n+/)
    .map(sentence => sentence.replace(/\s+/g, ' ').trim())
    .filter(sentence => /[\p{L}\p{N}]/u.test(sentence))

const spoken = (markdown: string, length: string) => {
  if (length === 'full') {
    return sentences(markdown).join(' ').slice(0, 4000)
  }

  // brief: the opening paragraph alone, the spoken summary Claude was asked for.
  const opening = markdown.split(/\n\s*\n/).find(part => sentences(part).length > 0)
  let text = ''

  for (const sentence of sentences(length === 'brief' ? (opening ?? '') : markdown)) {
    if (text !== '' && text.length + sentence.length > SPOKEN_LIMIT) {
      return length === 'brief' ? text : `${text} More on screen.`
    }

    text = `${text} ${sentence}`.trim()
  }

  return text.slice(0, SPOKEN_LIMIT * 2)
}

// Takes from a streaming reply the sentences that are finished, ready to say; the
// unfinished tail stays for the next piece. In `brief` the reading ends at the first blank line.
const finished = (reading: Reading, length: string, isEnd: boolean) => {
  const lines = reading.pending.split('\n')
  let tail = isEnd ? '' : (lines.pop() ?? '')
  const prose: string[] = []

  for (const line of lines) {
    if (reading.isOver) {
      break
    }

    if (line.trimStart().startsWith('```')) {
      reading.isInCode = !reading.isInCode

      if (reading.isInCode) {
        prose.push('Code block.')
      }
    } else if (line.trim() === '') {
      reading.isOver = length === 'brief' && (reading.hasSpoken || prose.length > 0)
    } else if (!reading.isInCode) {
      prose.push(line)
    }
  }

  // The line still arriving: the sentences of it that have ended can be said now.
  if (!reading.isInCode && !reading.isOver && !tail.trimStart().startsWith('`')) {
    const end = Math.max(...['. ', '! ', '? ', ': '].map(mark => tail.lastIndexOf(mark)))

    if (end > 0) {
      prose.push(tail.slice(0, end + 1))
      tail = tail.slice(end + 2)
    }
  }

  reading.pending = tail
  const text = sentences(prose.join('\n')).join(' ')
  reading.hasSpoken = reading.hasSpoken || text !== ''

  return text
}

const isActive = async ($: EngineInterface) =>
  (await read($, override)) ?? (await $.settings.read()).voiceEnabled === true

const isNeural = async ($: EngineInterface) => (await $.store.get('neural')) === true

// Bumped by every stop: what was being said or waiting to be said is stale.
let generation = 0
// What is waiting for the voice, and whether something is saying it.
let backlog: string[] = []
let isDraining = false
// The person silenced this turn: nothing more of it is said.
let isMuted = false
// The turn whose reply was spoken as it streamed, so its end does not say it again.
let streamedTurn = ''
// How much of this turn has been said, for the `normal` length.
let spokenChars = 0
// The system voice speaking now, by process id. Ending its stream would not
// stop it: a silent child's stream only ends when the child does.
let speaking: string | undefined
let systemVoice: readonly string[] | undefined
let isServing = false
// The reply last spoken, for "read the rest".
let lastAnswer = ''
// This turn's prompt asked for all of it.
let wantsAll = false
// Whether Claude was told to open with a spoken summary: another plugin can skip that hook,
// and then the opening paragraph is not a summary and `brief` would read too little.
let isToldToSummarize = false
// A turn of the main conversation is running: what is said now may be a side question.
let isWorking = false
// The system voice is talking: the server cannot take it out of the microphone, so the microphone is closed.
let isSystemTalking = false

const post = ($: EngineInterface, path: string, body?: string) =>
  $.http.fetch(`${SERVER}/${path}`, { method: 'POST', body }).catch(() => undefined)

// Opens or closes the microphone to match hands-free mode.
const listen = async ($: EngineInterface, { lang, hasHeadphones, pause }: Settings) => {
  const isOn = !isSystemTalking && (await read($, isLive)) && (await isActive($))

  return post(
    $,
    `listen?on=${isOn ? 1 : 0}&lang=${encodeURIComponent(lang)}&headphones=${hasHeadphones ? 1 : 0}&pause=${pause}`,
  )
}

const stop = async ($: EngineInterface) => {
  generation += 1
  backlog = []

  if (speaking !== undefined) {
    const pid = speaking
    speaking = undefined
    await $.process
      .run(['kill', pid])
      .catch(() => $.process.run(['taskkill', '/F', '/PID', pid]))
      .catch(() => undefined)
  }

  if (await isNeural($)) {
    await post($, 'stop')
  }
}

// The person's own stop: this turn stays quiet from here.
const hush = ($: EngineInterface) => {
  isMuted = true

  return stop($)
}

// Says one piece of text with the neural voice, or failing that the system's.
const voice = async ($: EngineInterface, text: string, settings: Settings, mine: number) => {
  if (await isNeural($)) {
    const query = `voice=${encodeURIComponent(settings.voice)}&lang=${encodeURIComponent(settings.lang)}`
    const said = await post($, `speak?${query}`, text)

    if (said?.ok) {
      return
    }

    // Not up yet, or gone with the session that ran it: the system voice says this one.
    void serveLater($, settings)
  }

  if (!(await read($, isLive))) {
    return voiceOfSystem($, text, mine)
  }

  isSystemTalking = true

  try {
    await listen($, settings)
    await voiceOfSystem($, text, mine)
  } finally {
    isSystemTalking = false
    await listen($, settings)
  }
}

// Says one piece of text with the first system voice this machine has.
const voiceOfSystem = async ($: EngineInterface, text: string, mine: number) => {
  for (const argv of systemVoice === undefined ? SYSTEM_VOICES : [systemVoice]) {
    try {
      const child = $.process.spawn({ argv, input: text })
      let step = await child.next()

      while (!step.done) {
        if (/^\d+\s*$/.test(step.value.text) && mine === generation) {
          speaking = step.value.text.trim()
        }

        step = await child.next()
      }

      if (mine !== generation) {
        return
      }

      // Ended on its own: its id may be another process's by the next stop.
      speaking = undefined

      if (step.value.code === 0) {
        systemVoice = argv

        return
      }
    } catch {
      // Not on this machine: the next voice.
      if (mine !== generation) {
        return
      }
    }
  }

  $.ui.toast('talkback found no system voice. On Linux, install espeak-ng.')
}

// Says `text` after whatever is already being said. Pieces that arrive while
// the system voice is busy are said together, as one run of speech.
const say = async ($: EngineInterface, text: string, settings: Settings) => {
  backlog.push(text)

  if (isDraining) {
    return
  }

  isDraining = true

  try {
    while (backlog.length > 0) {
      const run = backlog.join(' ')
      backlog = []
      await voice($, run, settings, generation)
    }
  } finally {
    isDraining = false
  }
}

// Says a whole reply, in place of whatever was being said.
const speak = async ($: EngineInterface, markdown: string, settings: Settings, length: string) => {
  const text = spoken(markdown, length)
  await stop($)

  if (text !== '') {
    await say($, text, settings)
  }
}

// Says what has newly finished of a reply that is still streaming.
const utter = ($: EngineInterface, reading: Reading, settings: Settings, length: string, isEnd: boolean) => {
  let text = finished(reading, length, isEnd)

  if (text === '' || isMuted || (length === 'normal' && spokenChars >= SPOKEN_LIMIT)) {
    return
  }

  spokenChars += text.length

  if (length === 'normal' && spokenChars >= SPOKEN_LIMIT) {
    text = `${text} More on screen.`
  }

  void say($, text, settings)
}

// Said while Claude is working. One call over the conversation so far, with no tools and
// no trace in the running task, both decides and answers: an instruction for the work
// in progress goes to the task, anything else is answered aloud beside it.
const aside = async ($: EngineInterface, said: string, settings: Settings) => {
  const question = said.replace(ASKS_ASIDE, '')
  const isSurelyAside = question !== said
  const reply = await $.model.fork({
    prompt: isSurelyAside
      ? `The person asked this aloud, beside the task you are in the middle of: "${question}"\n\n${ANSWER_ASIDE}`
      : `The person said this aloud while you are in the middle of the task: "${said}"\n\nIf it is an instruction that should change, add to or stop the work in progress, reply with the single word STEER and nothing else. Otherwise: ${ANSWER_ASIDE}`,
  })

  // No answer (nothing to fork yet, an error) or an instruction: the task gets it, so nothing said is lost.
  if (!reply.isAnswered || (!isSurelyAside && /^\W*steer\W*$/i.test(reply.text))) {
    await $.prompt.submit({ text: said, asUser: true })

    return
  }

  $.ui.log(`Side question: ${question}\n${reply.text}`)
  // The running task's reply may be heard again once the aside has been said.
  isMuted = false
  await speak($, `Side note. ${reply.text}`, settings, 'full')
}

// One line of the server's feed.
const heed = async ($: EngineInterface, line: string, settings: Settings) => {
  if (line.startsWith('progress: ')) {
    const [label, percent] = line.slice(10).split('|')
    const isDone = label === undefined || percent === undefined
    await update($, download, () => (isDone ? null : { label, percent: Number(percent) || 0 }))
  } else if (line === 'ready') {
    $.ui.toast('talkback: neural voice ready')
    await listen($, settings)
  } else if (line.startsWith('state: ')) {
    const state = line.slice(7)

    if (state in STATUS) {
      await update($, status, () => state as Status)
    }
  } else if (line.startsWith('heard: ') || line.startsWith('heard-over: ')) {
    // heard-over: said over the voice, which the server has already silenced.
    const isOver = line.startsWith('heard-over: ')
    const text = line.slice(line.indexOf(': ') + 2).trim()

    if (isOver) {
      // The rest of this turn stays unspoken too: the person has taken the floor.
      await hush($)
    }

    if ((isOver ? SAYS_STOP_OVER : SAYS_STOP).test(text)) {
      await hush($)
    } else if (ASKS_FOR_MORE.test(text) && lastAnswer !== '') {
      await speak($, lastAnswer, settings, 'full')
    } else if (await read($, isLive)) {
      if (isWorking && !TELLS_CLAUDE.test(text)) {
        await aside($, text, settings)
      } else {
        await $.prompt.submit({ text: text.replace(TELLS_CLAUDE, ''), asUser: true })
      }
    }
  }
}

// Keeps the voice and the ears warm for as long as this module lives. A second
// session finds the first one's server, speaks through it, and its own child
// exits at once: the microphone belongs to the session that started the server.
const serve = async ($: EngineInterface, settings: Settings) => {
  if (isServing) {
    return
  }

  isServing = true

  try {
    const server = $.process.spawn({
      argv: ['uv', 'run', `${$.plugin.root}/server/talkback_server.py`],
    })
    let pending = ''

    for await (const { stream, text } of server) {
      if (stream !== 'stdout') {
        continue
      }

      const lines = `${pending}${text}`.split('\n')
      pending = lines.pop() ?? ''

      for (const line of lines) {
        await heed($, line.trim(), settings).catch(() => undefined)
      }
    }
  } catch {
    $.ui.toast('talkback needs uv for the neural voice: https://docs.astral.sh/uv')
  } finally {
    isServing = false
    await update($, status, () => 'idle')
    await update($, download, () => null)
  }
}

// speak comes before serve in this file and serve after it: this is how the first reaches the second.
function serveLater($: EngineInterface, settings: Settings) {
  return serve($, settings)
}

// Hands-free on or off: the ears need the server, so going live starts it.
const goLive = async ($: EngineInterface, isOn: boolean, settings: Settings) => {
  await update($, isLive, () => isOn)

  if (isOn) {
    await update($, override, () => true)
    await $.store.set('neural', true)
    void serve($, settings)
  }

  await listen($, settings)
}

// Deletes the downloaded models and goes back to the system voice.
const remove = async ($: EngineInterface, settings: Settings) => {
  await goLive($, false, settings)
  await $.store.set('neural', false)
  // The server first: a model file it holds open cannot be deleted on Windows.
  await post($, 'quit')
  const removed = await $.process
    .run(['uv', 'run', `${$.plugin.root}/server/talkback_server.py`, '--remove'], { timeoutMs: 120000 })
    .catch(() => undefined)

  return removed?.exitCode === 0
}

export const register: Register = (on, options) => {
  const settings: Settings = {
    voice: typeof options.voice === 'string' ? options.voice : 'af_heart',
    lang: typeof options.lang === 'string' ? options.lang : 'en-us',
    length: typeof options.length === 'string' ? options.length : 'brief',
    hasHeadphones: options.headphones === true,
    pause: typeof options.pause === 'number' ? options.pause : 2,
  }

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'talkback',
      description:
        'Toggle spoken replies. "live": hands-free, your speech is sent as prompts. "init": the neural voice. "system": the system voice. "more": read the last reply in full. "remove": delete the downloaded models. "stop": quiet now',
    })

    if (await isNeural($)) {
      void serve($, settings)
    }

    return next(e)
  })

  on('command.run', { command: 'talkback' }, async ($, e) => {
    const choice = e.args.trim()

    if (choice === 'more') {
      void speak($, lastAnswer, settings, 'full')

      return { text: lastAnswer === '' ? 'Nothing to read yet.' : 'Reading the last reply in full.' }
    }

    if (choice === 'stop') {
      await hush($)

      return { text: 'Quiet.' }
    }

    if (choice === 'live') {
      const isOn = !(await read($, isLive))
      await goLive($, isOn, settings)

      return {
        text: isOn
          ? 'Hands-free on: speak, pause, and it is sent. The first time, the ears download first.'
          : 'Hands-free off: the microphone is closed.',
      }
    }

    if (choice === 'init') {
      await $.store.set('neural', true)
      void serve($, settings)

      return { text: 'Neural voice on: it is loading, and the system voice speaks until it is ready.' }
    }

    if (choice === 'remove') {
      return {
        text: (await remove($, settings))
          ? 'Models removed (about 600 MB freed). The system voice speaks from here.'
          : 'Could not remove the models: delete ~/.cache/talkback by hand.',
      }
    }

    if (choice === 'system') {
      await stop($)
      await goLive($, false, settings)
      await $.store.set('neural', false)

      return { text: 'Back to the system voice; hands-free is off.' }
    }

    const isOn = !(await isActive($))
    await update($, override, () => isOn)
    await listen($, settings)

    if (!isOn) {
      await stop($)
    }

    return { text: isOn ? 'Spoken replies on.' : 'Spoken replies off.' }
  })

  // The person has the floor again: Claude stops talking.
  on('prompt.submit', async ($, e, next) => {
    await stop($)
    wantsAll = ASKS_FOR_ALL.test(e.text)

    return next(e)
  })

  // Claude is told it is being heard, so the reply opens with something worth hearing.
  on('prompt.compose', async ($, e, next) => {
    const composed = await next(e)

    if (settings.length !== 'brief' || !(await isActive($))) {
      return composed
    }

    isToldToSummarize = true

    const text = (await read($, isLive)) ? `${SPOKEN_REPLIES}\n\n${DICTATED_PROMPTS}` : SPOKEN_REPLIES

    return {
      sections: [...composed.sections, { id: 'talkback:spoken-replies', text, scope: 'session' }],
    }
  })

  on('turn.start', ($, e, next) => {
    isWorking = isWorking || e.agentId === undefined

    return next(e)
  })

  // The reply is spoken while it is still being written: each sentence as it is finished.
  on('turn.step', async function* ($, e, next) {
    const isHeard = e.agentId === undefined && (await isActive($))

    if (isHeard && e.index === 0) {
      isMuted = false
      spokenChars = 0
    }

    const length = wantsAll ? 'full' : settings.length === 'brief' && !isToldToSummarize ? 'normal' : settings.length
    const reading: Reading = { pending: '', isInCode: false, isOver: false, hasSpoken: false }

    for await (const chunk of next(e)) {
      if (isHeard && chunk.kind === 'text') {
        streamedTurn = e.turnId
        reading.pending += chunk.text
        utter($, reading, settings, length, false)
      }

      yield chunk
    }

    if (isHeard) {
      utter($, reading, settings, length, true)
    }
  })

  on('turn.complete', async ($, e, next) => {
    const isMainAnswer = e.agentId === undefined && e.reason === 'answer'
    isWorking = isWorking && e.agentId !== undefined

    if (isMainAnswer && (await isActive($))) {
      lastAnswer = e.answer

      // Only when the reply was not heard as it streamed (another plugin can skip that hook).
      if (streamedTurn !== e.turnId) {
        const length = wantsAll ? 'full' : settings.length === 'brief' && !isToldToSummarize ? 'normal' : settings.length
        // Not awaited: the turn ends now, the speech runs on.
        void speak($, e.answer, settings, length)
      }
    }

    return next(e)
  })

  // A permission prompt or an idle nudge, heard from across the room.
  on('classic.Notification', async ($, e, next) => {
    if (await isActive($)) {
      void speak($, e.message, settings, 'full')
    }

    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey || !(await isActive($))) {
      return next(e)
    }

    const { Box, Button, Text } = $.ui.resolve(e)
    const isHandsFree = await read($, isLive)
    const coming = await read($, download)

    if (coming !== null) {
      return (
        <Box>
          <Text dimColor>
            🎙 Downloading {coming.label} {bar(coming.percent)}
          </Text>
        </Box>
      )
    }

    return (
      <Box>
        <Text dimColor>🎙 Voice replies on {STATUS[await read($, status)]} </Text>
        <Button key="stop" label="Stop" onPress={() => hush($)} />
        <Button
          key="live"
          label={isHandsFree ? 'Mic on: hands-free' : 'Mic off: go hands-free'}
          onPress={() => goLive($, !isHandsFree, settings)}
        />
        {(await isNeural($)) && (
          <Button
            key="remove"
            label="Remove models"
            onPress={async () => {
              const isRemoved = await remove($, settings)
              $.ui.toast(isRemoved ? 'talkback: models removed' : 'talkback: could not remove the models')
            }}
          />
        )}
      </Box>
    )
  })
}
