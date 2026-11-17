# /// script
# requires-python = ">=3.10,<3.13"
# dependencies = ["kokoro-onnx>=0.4.9", "sounddevice>=0.5", "faster-whisper>=1.1", "numpy"]
# ///
"""talkback's voice and ears: both local, loaded once and kept warm on localhost.

POST /speak (the text as the body, ?voice= and ?lang=) speaks it with Kokoro,
replacing whatever was being said. POST /stop goes quiet. POST /listen?on=1
opens the microphone: each thing the person says is transcribed with Whisper
and printed as `heard: <text>` for the mod to submit; ?on=0 closes it.
GET /health answers once the voice is loaded. Lines on standard output
(`ready`, `downloading ...`, `state: ...`, `heard: ...`) are the mod's feed.
Nothing leaves the machine after the first downloads.
"""
import collections
import re
import sys
import threading
import time
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

PORT = 47821
FILES = "https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/"
CACHE = Path.home() / ".cache" / "talkback"
MIC_RATE = 16000
BLOCK = MIC_RATE // 10
# How long a pause ends what the person is saying, in tenths of a second.
PAUSE_BLOCKS = 10

# Bumped by every /speak and /stop: a stale utterance says no further sentence.
generation = 0
is_playing = False
is_listening = False
# With headphones the microphone cannot hear the voice, so the person may talk over it.
has_headphones = False
language = "en"
# The room still rings for a moment after the voice ends.
deaf_until = 0.0
ears = None


def emit(line: str) -> None:
    print(line, flush=True)


def rest() -> None:
    emit("state: listening" if is_listening else "state: idle")


def fetch(name: str) -> str:
    path = CACHE / name
    if not path.exists():
        emit(f"downloading the voice ({name})")
        CACHE.mkdir(parents=True, exist_ok=True)
        part = path.with_suffix(".part")
        urllib.request.urlretrieve(FILES + name, part)
        part.rename(path)
    return str(path)


def say(kokoro, sounddevice, text: str, voice: str, lang: str, mine: int) -> None:
    global is_playing, deaf_until
    try:
        # One sentence at a time: the first is heard while the rest are still made.
        for sentence in re.split(r"(?<=[.!?:])\s+", text):
            if mine != generation:
                return
            if not sentence.strip():
                continue
            samples, rate = kokoro.create(sentence, voice=voice, lang=lang)
            # Written a tenth of a second at a time, on this thread alone: a stop is
            # heard at the next piece, with no call into the audio device from another.
            with sounddevice.OutputStream(samplerate=rate, channels=1, dtype="float32") as out:
                for start in range(0, len(samples), rate // 10):
                    if mine != generation:
                        out.abort()
                        return
                    out.write(samples[start : start + rate // 10])
    finally:
        if mine == generation:
            is_playing = False
            deaf_until = time.monotonic() + 0.8
            rest()


def transcribe(numpy, clip) -> str:
    global ears
    if ears is None:
        from faster_whisper import WhisperModel

        emit("downloading the ears (Whisper small, about 480 MB, once)")
        ears = WhisperModel("small", device="cpu", compute_type="int8")
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
    with sounddevice.InputStream(samplerate=MIC_RATE, channels=1, dtype="float32") as mic:
        while is_listening:
            block = mic.read(BLOCK)[0][:, 0].copy()
            if (is_playing and not has_headphones) or time.monotonic() < deaf_until:
                said, quiet = [], 0
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
                said.append(block)
                quiet = 0
            elif said:
                said.append(block)
                quiet += 1
                if quiet >= PAUSE_BLOCKS:
                    clip = numpy.concatenate(said)
                    said, quiet = [], 0
                    if len(clip) > MIC_RATE * (PAUSE_BLOCKS / 10 + 0.3):
                        emit("state: transcribing")
                        text = transcribe(numpy, clip)
                        if re.search(r"\w", text):
                            emit(f"heard: {text}")
                    rest()
            else:
                noise = 0.95 * noise + 0.05 * level
                lead.append(block)


def main() -> None:
    global generation, is_playing, is_listening, has_headphones, language
    try:
        server = ThreadingHTTPServer(("127.0.0.1", PORT), None)
    except OSError:
        emit("already running")
        return

    import sounddevice
    from kokoro_onnx import Kokoro

    kokoro = Kokoro(fetch("kokoro-v1.0.int8.onnx"), fetch("voices-v1.0.bin"))

    class Handler(BaseHTTPRequestHandler):
        def do_GET(self) -> None:
            self.answer(200 if self.path == "/health" else 404)

        def do_POST(self) -> None:
            global generation, is_playing, is_listening, has_headphones, language
            url = urlparse(self.path)
            query = {key: values[0] for key, values in parse_qs(url.query).items()}
            if url.path == "/listen":
                was_listening = is_listening
                is_listening = query.get("on") == "1"
                has_headphones = query.get("headphones") == "1"
                # Whisper names a language by its first part: en-us is en, Mandarin is zh.
                language = {"cmn": "zh"}.get(query.get("lang", "en"), query.get("lang", "en").split("-")[0])
                if is_listening and not was_listening:
                    threading.Thread(target=listen, args=(sounddevice,), daemon=True).start()
                if not is_listening:
                    rest()
                return self.answer(200)
            if url.path not in ("/speak", "/stop"):
                return self.answer(404)
            generation += 1
            is_playing = url.path == "/speak"
            if is_playing:
                text = self.rfile.read(int(self.headers.get("Content-Length", 0))).decode("utf-8")
                emit("state: speaking")
                threading.Thread(
                    target=say,
                    args=(kokoro, sounddevice, text, query.get("voice", "af_heart"), query.get("lang", "en-us"), generation),
                    daemon=True,
                ).start()
            else:
                rest()
            self.answer(200)

        def answer(self, status: int) -> None:
            self.send_response(status)
            self.send_header("Content-Length", "0")
            self.end_headers()

        def log_message(self, *args) -> None:
            pass

    server.RequestHandlerClass = Handler
    emit("ready")
    server.serve_forever()


if __name__ == "__main__":
    sys.exit(main())
