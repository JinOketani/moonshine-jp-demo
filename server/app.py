import asyncio
import json
import os
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from typing import Optional

import numpy as np
import websockets
from moonshine_voice import Transcriber, TranscriptEventListener, get_model_for_language

HOST = os.getenv("HOST", "0.0.0.0")
PORT = int(os.getenv("PORT", "8765"))
DEFAULT_LANGUAGE = os.getenv("DEFAULT_LANGUAGE", "ja")
DEFAULT_MODEL_ARCH = os.getenv("DEFAULT_MODEL_ARCH")
TRANSCRIPTS_DIR = Path(os.getenv("TRANSCRIPTS_DIR", "/app/transcripts"))
NON_LATIN_MAX_TOKENS_PER_SECOND = os.getenv("NON_LATIN_MAX_TOKENS_PER_SECOND", "13.0")
TRANSCRIPTION_INTERVAL = os.getenv("TRANSCRIPTION_INTERVAL", "0.2")
VAD_THRESHOLD = os.getenv("VAD_THRESHOLD")


@dataclass
class SessionState:
    ws: websockets.WebSocketServerProtocol
    transcriber: Optional[Transcriber] = None
    final_lines: list[str] = field(default_factory=list)
    audio_buffer: list[float] = field(default_factory=list)
    last_interim: str = ""
    started: bool = False
    language: str = DEFAULT_LANGUAGE


class WsTranscriptListener(TranscriptEventListener):
    def __init__(self, state: SessionState):
        self.state = state
        self.loop = asyncio.get_running_loop()

    def _send(self, payload: dict):
        self.loop.create_task(self.state.ws.send(json.dumps(payload, ensure_ascii=False)))

    def on_line_text_changed(self, event):
        self.state.last_interim = event.line.text
        self._send({"type": "interim", "text": event.line.text})

    def on_line_completed(self, event):
        text = event.line.text.strip()
        if text:
            self.state.final_lines.append(text)
        self.state.last_interim = ""
        self._send({"type": "final", "text": text, "all": "\n".join(self.state.final_lines)})

    def on_error(self, event):
        self._send({"type": "error", "message": str(event.error)})


async def send_json(ws: websockets.WebSocketServerProtocol, payload: dict):
    await ws.send(json.dumps(payload, ensure_ascii=False))


def parse_model_arch() -> Optional[int]:
    if DEFAULT_MODEL_ARCH is None or DEFAULT_MODEL_ARCH == "":
        return None
    return int(DEFAULT_MODEL_ARCH)


def build_transcriber_options(language: str) -> dict[str, str]:
    options = {"transcription_interval": TRANSCRIPTION_INTERVAL}
    if language not in {"en", "es"}:
        options["max_tokens_per_second"] = NON_LATIN_MAX_TOKENS_PER_SECOND
    if VAD_THRESHOLD:
        options["vad_threshold"] = VAD_THRESHOLD
    return options


def cleanup_lines(lines: list[str]) -> list[str]:
    return [line.strip() for line in lines if line and line.strip()]


async def start_transcriber(state: SessionState, language: str):
    state.final_lines.clear()
    state.audio_buffer.clear()
    state.language = language
    model_path, model_arch = get_model_for_language(
        wanted_language=language, wanted_model_arch=parse_model_arch()
    )
    transcriber = Transcriber(
        model_path=model_path,
        model_arch=model_arch,
        update_interval=0.2,
        options=build_transcriber_options(language),
    )
    transcriber.add_listener(WsTranscriptListener(state))
    transcriber.start()
    state.transcriber = transcriber
    state.started = True
    await send_json(
        state.ws,
        {
            "type": "started",
            "language": language,
            "sampleRate": 16000,
            "message": "Transcriber started",
        },
    )


async def stop_transcriber(state: SessionState):
    if state.transcriber is None:
        return
    state.transcriber.stop()
    if state.audio_buffer:
        refined_transcript = state.transcriber.transcribe_without_streaming(
            state.audio_buffer, sample_rate=16000, flags=0
        )
        refined_lines = cleanup_lines([line.text for line in refined_transcript.lines])
        if refined_lines:
            state.final_lines = refined_lines
            await send_json(
                state.ws,
                {
                    "type": "refined",
                    "all": "\n".join(state.final_lines),
                    "lineCount": len(state.final_lines),
                },
            )
    state.transcriber.close()
    state.transcriber = None
    state.started = False
    await send_json(state.ws, {"type": "stopped", "message": "Transcriber stopped"})


async def save_transcript(state: SessionState, filename: Optional[str] = None):
    TRANSCRIPTS_DIR.mkdir(parents=True, exist_ok=True)
    if not filename:
        filename = datetime.now().strftime("transcript_%Y%m%d_%H%M%S.txt")
    safe_name = "".join(ch for ch in filename if ch.isalnum() or ch in ("-", "_", "."))
    if not safe_name.endswith(".txt"):
        safe_name = f"{safe_name}.txt"

    output_path = TRANSCRIPTS_DIR / safe_name
    output_path.write_text("\n".join(state.final_lines).strip() + "\n", encoding="utf-8")

    await send_json(
        state.ws,
        {
            "type": "saved",
            "path": str(output_path),
            "lineCount": len(state.final_lines),
        },
    )


async def handle_client(ws: websockets.WebSocketServerProtocol):
    state = SessionState(ws=ws)
    await send_json(
        ws,
        {
            "type": "ready",
            "message": "Connected. Send {type:start} before audio chunks.",
            "defaultLanguage": DEFAULT_LANGUAGE,
            "expectedAudio": "float32 mono PCM @ 16000Hz",
        },
    )

    try:
        async for message in ws:
            if isinstance(message, bytes):
                if state.transcriber is None:
                    await send_json(ws, {"type": "error", "message": "Send start first"})
                    continue

                if len(message) % 4 != 0:
                    await send_json(ws, {"type": "error", "message": "Invalid float32 audio payload"})
                    continue

                audio_chunk = np.frombuffer(message, dtype=np.float32)
                state.audio_buffer.extend(audio_chunk.tolist())
                state.transcriber.add_audio(audio_chunk.tolist(), sample_rate=16000)
                continue

            try:
                payload = json.loads(message)
            except json.JSONDecodeError:
                await send_json(ws, {"type": "error", "message": "Invalid JSON"})
                continue

            msg_type = payload.get("type")
            if msg_type == "start":
                language = payload.get("language", DEFAULT_LANGUAGE)
                if state.started:
                    await send_json(ws, {"type": "error", "message": "Already started"})
                    continue
                await start_transcriber(state, language)
            elif msg_type == "stop":
                await stop_transcriber(state)
            elif msg_type == "save":
                await save_transcript(state, payload.get("filename"))
            elif msg_type == "reset":
                state.final_lines.clear()
                state.audio_buffer.clear()
                state.last_interim = ""
                await send_json(ws, {"type": "reset", "message": "Transcript cleared"})
            elif msg_type == "ping":
                await send_json(ws, {"type": "pong"})
            else:
                await send_json(ws, {"type": "error", "message": f"Unknown type: {msg_type}"})
    finally:
        if state.transcriber is not None:
            state.transcriber.stop()
            state.transcriber.close()


async def main():
    print(f"Starting Moonshine WebSocket server on ws://{HOST}:{PORT}")
    async with websockets.serve(handle_client, HOST, PORT, max_size=8 * 1024 * 1024):
        await asyncio.Future()


if __name__ == "__main__":
    asyncio.run(main())
