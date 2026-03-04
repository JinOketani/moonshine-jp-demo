# Moonshine Docker + WebSocket Demo

This folder runs the following components together:

- A WebSocket transcription server using `moonshine` (Python API)
- A web UI that records audio in the browser and sends audio chunks to the server
- Saving transcription results as `.txt` files
- Accuracy improvements for Japanese speech recognition:
  - `max_tokens_per_second=13.0` for non-Latin languages
  - Re-run offline inference on the full audio when recording stops to refine the final text
  - Browser-side noise suppression, mono channel, and linear resampling

## 1. Prerequisites

- Docker / Docker Compose is available
- The `moonshine` repository has been cloned locally (to satisfy requirements)
  - `../moonshine`
  - The WebSocket server itself runs using the official `moonshine-voice` package

## 2. Start

Run this in the `moonshine_ws_demo` directory:

```bash
docker compose up --build
```

After startup:

- Web UI: `http://localhost:8080`
- WebSocket: `ws://localhost:8765`

On first startup, the server may take a little time to download Moonshine models.

## Accuracy Tips

- After clicking `Stop Recording`, the server re-runs inference on the full audio and overwrites the final result.
- The recommended timing to save is when the Web UI status shows `Accuracy correction complete`.
- For better results, use a headset mic or keep the mic about 10-20 cm from your mouth.

## 3. Usage

1. Open `http://localhost:8080` in your browser
2. Click `Connect`
3. Click `Start Recording` and speak
4. Click `Stop Recording` to finalize
5. Click `Save Text` to save on the server

Saved to:

- `./server/transcripts/transcript_YYYYMMDD_HHMMSS.txt`

## 4. Stop

```bash
docker compose down
```
