# /// script
# requires-python = ">=3.10,<3.13"
# dependencies = ["kokoro-onnx>=0.4.9", "sounddevice>=0.5", "faster-whisper>=1.1", "numpy"]
# ///
"""talkback's voice and ears: both local, loaded once and kept warm on localhost.

POST /speak (the text as the body, ?voice= and ?lang=) speaks it with Kokoro,
after whatever is already waiting to be said, so a reply can be spoken while it
is still being written. POST /stop goes quiet and drops what was waiting. POST /listen?on=1
opens the microphone: each thing the person says is transcribed with Whisper
and printed as `heard: <text>` once they have been silent for ?pause= seconds
(a shorter pause mid-sentence is waited out); ?on=0 closes it.
GET /health answers once the voice is loaded. POST /quit ends the server, and
running this script with --remove deletes the downloaded models. Lines on standard output
(`ready`, `progress: <what>|<percent>`, `state: ...`, `heard: ...`) are the mod's feed.
Nothing leaves the machine after the first downloads.
"""
import collections
import os
import queue
import re
import shutil
import sys
import threading
import time
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

PORT = 47821
VOICE = "https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/"
EARS = "https://huggingface.co/Systran/faster-whisper-small/resolve/main/"
CACHE = Path.home() / ".cache" / "talkback"
MIC_RATE = 16000
BLOCK = MIC_RATE // 10
# A pause this long, in tenths of a second, starts transcribing what was said so
# far, so the text is ready by the time the longer pause that sends it has passed.
EARLY_BLOCKS = 7

# Bumped by every /stop: what was waiting to be said is stale and stays unsaid.
generation = 0
# What is waiting to be said: (generation, text, voice, lang).
waiting = queue.Queue()
is_playing = False
is_listening = False
# With headphones the microphone cannot hear the voice, so the person may talk over it.
has_headphones = False
language = "en"
# How long a silence ends what the person is saying, in tenths of a second: long
# enough to stop and think mid-sentence.
pause_blocks = 20
# The room still rings for a moment after the voice ends.
deaf_until = 0.0
ears = None


def emit(line: str) -> None:
    print(line, flush=True)


def rest() -> None:
    emit("state: listening" if is_listening else "state: idle")


def fetch(url: str, name: str, label: str) -> str:
    """Downloads a model file once, telling the mod how far along it is."""
    path = CACHE / name
    if not path.exists():
        path.parent.mkdir(parents=True, exist_ok=True)
        part = path.with_suffix(path.suffix + ".part")
        seen = -1

        def report(blocks: int, size: int, total: int) -> None:
            nonlocal seen
            percent = min(100, blocks * size * 100 // total) if total > 0 else 0
            if percent != seen:
                seen = percent
                emit(f"progress: {label}|{percent}")

        urllib.request.urlretrieve(url + name.rsplit("/", 1)[-1], part, report)
        part.rename(path)
        emit("progress: done")
    return str(path)


def say(kokoro, sounddevice) -> None:
    """Says what is waiting, in order, for as long as the server lives."""
    global is_playing, deaf_until
    while True:
        mine, text, voice, lang = waiting.get()
        # One sentence at a time: the first is heard while the rest are still made.
        for sentence in re.split(r"(?<=[.!?:])\s+", text):
            if mine != generation:
                break
            if not sentence.strip():
                continue
            samples, rate = kokoro.create(sentence, voice=voice, lang=lang)
            # Written a tenth of a second at a time, on this thread alone: a stop is
            # heard at the next piece, with no call into the audio device from another.
            with sounddevice.OutputStream(samplerate=rate, channels=1, dtype="float32") as out:
                for start in range(0, len(samples), rate // 10):
                    if mine != generation:
                        out.abort()
                        break
                    out.write(samples[start : start + rate // 10])
        if mine == generation and waiting.empty():
            is_playing = False
            deaf_until = time.monotonic() + 0.8
            rest()


def transcribe(numpy, clip) -> str:
    global ears
    if ears is None:
        from faster_whisper import WhisperModel

        # The small files first: the bar then runs once, over the model itself.
        for name in ("config.json", "tokenizer.json", "vocabulary.txt", "model.bin"):
            fetch(EARS, f"whisper-small/{name}", "the ears (480 MB)")
        ears = WhisperModel(str(CACHE / "whisper-small"), device="cpu", compute_type="int8")
    # vad_filter drops a clip that was a door or a cough, not words.
    segments, _ = ears.transcribe(clip, language=language, vad_filter=True, beam_size=1)
    return " ".join(s.text.strip() for s in segments if s.no_speech_prob < 0.6).strip()


def listen(sounddevice) -> None:
    # shortcut: loudness against the room's own noise decides what is speech; upgrade to a
    # trained voice detector (Silero) if music or a fan keeps opening the microphone.
    global generation, is_playing
    import numpy

    transcribe(numpy, numpy.zeros(MIC_RATE, dtype="float32"))
    rest()
    noise = 0.01
    lead = collections.deque(maxlen=3)
    said = []
    quiet = 0
    # The transcription begun at the short pause: its thread and where its text lands.
    early = None
    with sounddevice.InputStream(samplerate=MIC_RATE, channels=1, dtype="float32") as mic:
        while is_listening:
            block = mic.read(BLOCK)[0][:, 0].copy()
            if (is_playing and not has_headphones) or time.monotonic() < deaf_until:
                said, quiet, early = [], 0, None
                continue
            level = float(numpy.sqrt(numpy.mean(block**2)))
            is_speech = level > max(0.012, noise * 3)
            if is_speech:
                if not said:
                    said = list(lead)
                    emit("state: hearing")
                    if is_playing:
                        # Talked over: the voice yields.
                        generation += 1
                        is_playing = False
                elif early:
                    # The person went on after a pause: that text was only the first half.
                    early = None
                    emit("state: hearing")
                said.append(block)
                quiet = 0
            elif said:
                said.append(block)
                quiet += 1
                if quiet == EARLY_BLOCKS and len(said) > EARLY_BLOCKS + 3:
                    emit("state: transcribing")
                    result = []
                    clip = numpy.concatenate(said)
                    thread = threading.Thread(target=lambda: result.append(transcribe(numpy, clip)), daemon=True)
                    thread.start()
                    early = (thread, result)
                if quiet >= pause_blocks:
                    said, quiet = [], 0
                    if early:
                        thread, result = early
                        early = None
                        thread.join()
                        if result and re.search(r"\w", result[0]):
                            emit(f"heard: {result[0]}")
                    rest()
            else:
                noise = 0.95 * noise + 0.05 * level
                lead.append(block)


def main() -> None:
    global generation, is_playing, is_listening, has_headphones, language
    if "--remove" in sys.argv:
        shutil.rmtree(CACHE, ignore_errors=True)
        return
    try:
        server = ThreadingHTTPServer(("127.0.0.1", PORT), None)
    except OSError:
        emit("already running")
        return

    import sounddevice
    from kokoro_onnx import Kokoro

    kokoro = Kokoro(
        fetch(VOICE, "kokoro-v1.0.int8.onnx", "the voice, 1 of 2 (90 MB)"),
        fetch(VOICE, "voices-v1.0.bin", "the voice, 2 of 2 (30 MB)"),
    )

    class Handler(BaseHTTPRequestHandler):
        def do_GET(self) -> None:
            self.answer(200 if self.path == "/health" else 404)

        def do_POST(self) -> None:
            global generation, is_playing, is_listening, has_headphones, language, pause_blocks
            url = urlparse(self.path)
            query = {key: values[0] for key, values in parse_qs(url.query).items()}
            if url.path == "/listen":
                was_listening = is_listening
                is_listening = query.get("on") == "1"
                has_headphones = query.get("headphones") == "1"
                pause_blocks = max(EARLY_BLOCKS + 1, min(60, round(float(query.get("pause", "2")) * 10)))
                # Whisper names a language by its first part: en-us is en, Mandarin is zh.
                language = {"cmn": "zh"}.get(query.get("lang", "en"), query.get("lang", "en").split("-")[0])
                if is_listening and not was_listening:
                    threading.Thread(target=listen, args=(sounddevice,), daemon=True).start()
                if not is_listening:
                    rest()
                return self.answer(200)
            if url.path == "/quit":
                self.answer(200)
                os._exit(0)
            if url.path not in ("/speak", "/stop"):
                return self.answer(404)
            if url.path == "/speak":
                text = self.rfile.read(int(self.headers.get("Content-Length", 0))).decode("utf-8")
                if not is_playing:
                    emit("state: speaking")
                is_playing = True
                waiting.put((generation, text, query.get("voice", "af_heart"), query.get("lang", "en-us")))
            else:
                generation += 1
                is_playing = False
                rest()
            self.answer(200)

        def answer(self, status: int) -> None:
            self.send_response(status)
            self.send_header("Content-Length", "0")
            self.end_headers()

        def log_message(self, *args) -> None:
            pass

    server.RequestHandlerClass = Handler
    threading.Thread(target=say, args=(kokoro, sounddevice), daemon=True).start()
    emit("ready")
    server.serve_forever()


if __name__ == "__main__":
    sys.exit(main())
