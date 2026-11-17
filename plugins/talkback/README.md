<h1 align="center">talkback</h1>

<p align="center"><em>Claude Code that talks back, and listens. All speech runs on your machine.</em></p>

<p align="center"><sub>Part of the <a href="https://github.com/Dhananjay-JSR/claude-mods">claude-mods</a> marketplace.</sub></p>

A **Claude Mod** that speaks Claude's replies aloud and, in hands-free mode, sends what you say as the next prompt.

Claude Code's `/voice` is dictation only: you can talk, but the reply is text. talkback is the other half. Turn `/voice` on and replies are spoken, with nothing else to set up.

## What it does

- **Speaks each reply as it is written:** every sentence is said as soon as it is finished, so the voice starts with the first words and not when the turn ends. That includes what Claude says between tool calls; tool output and a subagent's report are never read. Code blocks, links and markdown symbols are skipped.
- **Follows `/voice`.** Spoken replies are on whenever `/voice` is on. `/talkback` flips them for the session.
- **Speaks permission prompts and idle nudges,** so you hear from across the room when Claude needs you.
- **Stops when you take over:** the `Stop` button above the prompt, a new prompt, or `/talkback stop` cuts the voice mid-word.
- **Hands-free mode** (optional): the microphone stays open, and what you say is transcribed locally and submitted once you have been silent for two seconds. Then Claude answers aloud.
- **Talk over it.** In hands-free mode the voice's own echo is cancelled out of the microphone, so you can interrupt through speakers: say "stop" and it stops, say anything else and that becomes the next prompt.

## Side questions

In hands-free mode, what you say while Claude is working does not have to interrupt the work. One tool-less call over the conversation so far (the same mechanism as `/btw`) decides and answers:

- **A question beside the task** ("what does that flag do?") is answered aloud, starting "Side note", and shown in the transcript. The running task never sees it.
- **An instruction for the task** ("use tabs, not spaces") is sent to the task as a message.
- **You can decide yourself:** start with "by the way" or "quick question" for the side, or "tell Claude" for the task.

The side answer comes from what is already in the conversation: it cannot run tools. If the call fails, what you said goes to the task, so nothing is lost. It is one extra model call for each thing said while Claude works.

## Install

```
/plugin marketplace add Dhananjay-JSR/claude-mods
/plugin install talkback@claude-mods
```

## Voices

| | Engine | Setup |
| --- | --- | --- |
| **System voice** (default) | `say` on macOS; `espeak-ng`, `espeak` or `spd-say` on Linux; PowerShell speech on Windows | none on macOS and Windows; on Linux, install `espeak-ng` |
| **Neural voice** (`/talkback init`) | [Kokoro](https://github.com/thewh1teagle/kokoro-onnx), kept warm by a small local server | needs [uv](https://docs.astral.sh/uv); downloads about 120 MB once |
| **Ears** (`/talkback live`) | [Whisper small](https://github.com/SYSTRAN/faster-whisper) and WebRTC echo cancelling (from the [LiveKit](https://github.com/livekit/python-sdks) package, used offline), in the same server | downloads about 480 MB once |

A progress bar above the prompt shows each download. After the first download nothing leaves the machine: the server listens on `127.0.0.1` only. The models are kept in `~/.cache/talkback`. `/talkback remove` deletes them; the Python packages `uv` installed stay in uv's own cache (`uv cache clean`).

## Commands

| Command | Does |
| --- | --- |
| `/talkback` | Toggle spoken replies for this session |
| `/talkback live` | Toggle hands-free mode (also the mic button above the prompt) |
| `/talkback init` | Use the neural voice, downloading and warming it |
| `/talkback system` | Go back to the system voice |
| `/talkback remove` | Delete the downloaded models (about 600 MB) and go back to the system voice; also a button above the prompt |
| `/talkback more` | Read the last reply again, in full |
| `/talkback stop` | Quiet now |

Whatever the Spoken length, a prompt that asks for all of it ("explain it completely", "in detail", "not just a summary") is read in full, and after a short reading, saying "read the rest" or "continue" in hands-free mode reads the last reply in full.

## Options

Set in `/config`:

| Option | Default | |
| --- | --- | --- |
| Spoken length | `brief` | `brief`: Claude is asked to open each reply with a short spoken paragraph, and only that is read. `normal`: the first 600 characters. `full`: everything |
| Neural voice | `af_heart` | Any Kokoro voice (`am_michael`, `bf_emma`, `hf_alpha` for Hindi, ...) |
| Neural language | `en-us` | Also the language the ears expect (`hi`, `es`, `fr-fr`, `ja`, ...) |
| Pause before sending | `2` | Hands-free: seconds of silence that end what you are saying. A shorter pause mid-sentence is waited out |
| Headphones | off | On: talking over Claude stops the voice at once. Off: the voice pauses, and stops only if words are heard |

## Limits

- **Permission prompts are spoken, not answerable by voice.** A misheard "yes" could approve a destructive command, so approving stays on the keyboard.
- **Hands-free submits what it hears.** Claude is told the prompts are dictated and to ask before acting on an ambiguous request, but read the transcript when it matters.
- **Speech detection is by loudness** against the room's noise. A fan or music can open the microphone.
- **One session owns the microphone:** the one that started the server. Others speak through it but get no transcripts. The server stops with that session.
- **Verified on macOS only.** The Linux and Windows voice commands have not been run on real machines; on Linux the neural voice also needs the PortAudio library (`libportaudio2`).
- **A mod cannot** hide the prompt box, drive `/voice`'s own key, or play audio on a phone over Remote Control.
- Another plugin seated above talkback can skip its hooks; the system-prompt hook behind `brief` and the notification hook are the two most often refused.

## How it works

`hooks/register.tsx` is the whole mod: a `turn.step` hook speaks the reply as it streams (and a `turn.complete` hook speaks it whole where that one is skipped), a `prompt.submit` hook stops it, a `prompt.compose` hook asks for the spoken opening, and a `ui.render` hook draws the row above the prompt. `server/talkback_server.py` is the optional local server, run with `uv`; the mod reads its standard output for what the microphone heard.

```bash
claude plugin validate plugins/talkback
claude plugin test plugins/talkback
```

## License

MIT.
