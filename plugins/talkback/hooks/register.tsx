import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Status } from '../types'

const override = atom({ plugin: 'talkback', key: 'override' } as const, null)
// Hands-free: the microphone is open and what the person says is submitted.
const isLive = atom({ plugin: 'talkback', key: 'isLive' } as const, false)
const status = atom({ plugin: 'talkback', key: 'status' } as const, 'idle')

type Settings = { voice: string; lang: string; length: string; hasHeadphones: boolean; pause: number }

// A listener cannot skim: past this many characters the rest stays on screen.
const SPOKEN_LIMIT = 600

// The local server: the neural voice and the ears (server/talkback_server.py).
const SERVER = 'http://127.0.0.1:47821'

const SPOKEN_REPLIES = `The person is listening, not reading: a text-to-speech voice reads the first paragraph of each of your final replies aloud, and nothing after it. Open every final reply with one short paragraph, three sentences at most, in plain spoken language that stands on its own: the outcome or the answer first, then anything the person has to decide or do. No markdown, code, file paths, URLs or lists in that paragraph. Write the details after it as usual.`

const DICTATED_PROMPTS = `The person's messages are dictated and sent as soon as they pause, so read past likely mis-hearings, and when a request to change or delete something is ambiguous, ask before acting on it.`

const STATUS: Record<Status, string> = {
  idle: '',
  listening: '● listening',
  hearing: '● hearing you',
  transcribing: '● transcribing',
  speaking: '◆ speaking',
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

const isActive = async ($: EngineInterface) =>
  (await read($, override)) ?? (await $.settings.read()).voiceEnabled === true

const isNeural = async ($: EngineInterface) => (await $.store.get('neural')) === true

// Bumped by every new utterance and every stop: a stale one tries no further voice.
let generation = 0
// The system voice speaking now, by process id. Ending its stream would not
// stop it: a silent child's stream only ends when the child does.
let speaking: string | undefined
let systemVoice: readonly string[] | undefined
let isServing = false

const post = ($: EngineInterface, path: string, body?: string) =>
  $.http.fetch(`${SERVER}/${path}`, { method: 'POST', body }).catch(() => undefined)

// Opens or closes the microphone to match hands-free mode.
const listen = async ($: EngineInterface, { lang, hasHeadphones, pause }: Settings) => {
  const isOn = (await read($, isLive)) && (await isActive($))

  return post(
    $,
    `listen?on=${isOn ? 1 : 0}&lang=${encodeURIComponent(lang)}&headphones=${hasHeadphones ? 1 : 0}&pause=${pause}`,
  )
}

const stop = async ($: EngineInterface) => {
  generation += 1

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

// One line of the server's feed.
const heed = async ($: EngineInterface, line: string, settings: Settings) => {
  if (line.startsWith('downloading')) {
    $.ui.toast(`talkback is ${line}`)
  } else if (line === 'ready') {
    $.ui.toast('talkback: neural voice ready')
    await listen($, settings)
  } else if (line.startsWith('state: ')) {
    const state = line.slice(7)

    if (state in STATUS) {
      await update($, status, () => state as Status)
    }
  } else if (line.startsWith('heard: ')) {
    const text = line.slice(7).trim()

    if (/^(stop|quiet|be quiet|enough)[.!]?$/i.test(text)) {
      await stop($)
    } else if (await read($, isLive)) {
      await $.prompt.submit({ text, asUser: true })
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
  }
}

const speak = async ($: EngineInterface, markdown: string, settings: Settings, length: string) => {
  const text = spoken(markdown, length)
  await stop($)

  if (text === '') {
    return
  }

  if (await isNeural($)) {
    const query = `voice=${encodeURIComponent(settings.voice)}&lang=${encodeURIComponent(settings.lang)}`
    const said = await post($, `speak?${query}`, text)

    if (said?.ok) {
      return
    }

    // Not up yet, or gone with the session that ran it: the system voice says this one.
    void serve($, settings)
  }

  const mine = generation

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
        'Toggle spoken replies. "live": hands-free, your speech is sent as prompts. "init": the neural voice. "system": the system voice. "stop": quiet now',
    })

    if (await isNeural($)) {
      void serve($, settings)
    }

    return next(e)
  })

  on('command.run', { command: 'talkback' }, async ($, e) => {
    const choice = e.args.trim()

    if (choice === 'stop') {
      await stop($)

      return { text: 'Quiet.' }
    }

    if (choice === 'live') {
      const isOn = !(await read($, isLive))
      await goLive($, isOn, settings)

      return {
        text: isOn
          ? 'Hands-free on: speak, pause, and it is sent. The first time, the ears take a minute to download.'
          : 'Hands-free off: the microphone is closed.',
      }
    }

    if (choice === 'init') {
      await $.store.set('neural', true)
      void serve($, settings)

      return { text: 'Neural voice on: it is loading, and the system voice speaks until it is ready.' }
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

    return next(e)
  })

  // Claude is told it is being heard, so the reply opens with something worth hearing.
  on('prompt.compose', async ($, e, next) => {
    const composed = await next(e)

    if (settings.length !== 'brief' || !(await isActive($))) {
      return composed
    }

    const text = (await read($, isLive)) ? `${SPOKEN_REPLIES}\n\n${DICTATED_PROMPTS}` : SPOKEN_REPLIES

    return {
      sections: [...composed.sections, { id: 'talkback:spoken-replies', text, scope: 'session' }],
    }
  })

  on('turn.complete', async ($, e, next) => {
    const isMainAnswer = e.agentId === undefined && e.reason === 'answer'

    if (isMainAnswer && (await isActive($))) {
      // Not awaited: the turn ends now, the speech runs on.
      void speak($, e.answer, settings, settings.length)
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

    return (
      <Box>
        <Text dimColor>🎙 Voice replies on {STATUS[await read($, status)]} </Text>
        <Button key="stop" label="Stop" onPress={() => stop($)} />
        <Button
          key="live"
          label={isHandsFree ? 'Mic on: hands-free' : 'Mic off: go hands-free'}
          onPress={() => goLive($, !isHandsFree, settings)}
        />
      </Box>
    )
  })
}
