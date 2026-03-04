const wsUrlInput = document.getElementById("wsUrl");
const languageInput = document.getElementById("language");
const connectBtn = document.getElementById("connectBtn");
const startBtn = document.getElementById("startBtn");
const stopBtn = document.getElementById("stopBtn");
const saveBtn = document.getElementById("saveBtn");
const resetBtn = document.getElementById("resetBtn");
const statusEl = document.getElementById("status");
const interimEl = document.getElementById("interim");
const finalTextEl = document.getElementById("finalText");

let ws = null;
let audioContext = null;
let mediaStream = null;
let sourceNode = null;
let processorNode = null;
let isRecording = false;
const TARGET_SAMPLE_RATE = 16000;
const SEND_FRAME_SAMPLES = 1600;
const MAX_WS_BUFFER_BYTES = 1_000_000;
let sendBuffer = new Float32Array(0);

function setStatus(text) {
  statusEl.textContent = text;
}

function updateButtons(connected) {
  connectBtn.disabled = connected;
  startBtn.disabled = !connected || isRecording;
  stopBtn.disabled = !connected || !isRecording;
  saveBtn.disabled = !connected;
  resetBtn.disabled = !connected;
}

function appendFinalLine(text) {
  if (!text) return;
  finalTextEl.value = finalTextEl.value ? `${finalTextEl.value}\n${text}` : text;
}

function concatFloat32(a, b) {
  const out = new Float32Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

function linearResample(input, inputRate, outputRate) {
  if (inputRate === outputRate) {
    return new Float32Array(input);
  }
  const outputLength = Math.floor((input.length * outputRate) / inputRate);
  const output = new Float32Array(outputLength);
  const ratio = inputRate / outputRate;
  for (let i = 0; i < outputLength; i += 1) {
    const idx = i * ratio;
    const idx0 = Math.floor(idx);
    const idx1 = Math.min(idx0 + 1, input.length - 1);
    const frac = idx - idx0;
    output[i] = input[idx0] * (1 - frac) + input[idx1] * frac;
  }
  return output;
}

function noiseGate(samples) {
  let energy = 0;
  for (let i = 0; i < samples.length; i += 1) {
    energy += samples[i] * samples[i];
  }
  const rms = Math.sqrt(energy / Math.max(1, samples.length));
  if (rms < 0.006) {
    return new Float32Array(samples.length);
  }
  return samples;
}

function sendPcmToServer(floatSamples) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  if (ws.bufferedAmount > MAX_WS_BUFFER_BYTES) return;
  ws.send(floatSamples.buffer);
}

function processAndQueue(input) {
  const resampled = linearResample(input, audioContext.sampleRate, TARGET_SAMPLE_RATE);
  const cleaned = noiseGate(resampled);
  sendBuffer = concatFloat32(sendBuffer, cleaned);

  while (sendBuffer.length >= SEND_FRAME_SAMPLES) {
    const frame = sendBuffer.slice(0, SEND_FRAME_SAMPLES);
    sendPcmToServer(frame);
    sendBuffer = sendBuffer.slice(SEND_FRAME_SAMPLES);
  }
}

function connect() {
  const url = wsUrlInput.value.trim();
  if (!url) {
    setStatus("WebSocket URLを入力してください");
    return;
  }

  ws = new WebSocket(url);

  ws.onopen = () => {
    setStatus("接続済み");
    updateButtons(true);
  };

  ws.onmessage = (event) => {
    let payload;
    try {
      payload = JSON.parse(event.data);
    } catch {
      return;
    }

    if (payload.type === "ready") {
      setStatus(`接続済み: ${payload.message}`);
      return;
    }

    if (payload.type === "started") {
      setStatus("文字起こし開始");
      return;
    }

    if (payload.type === "stopped") {
      setStatus("文字起こし停止");
      return;
    }

    if (payload.type === "interim") {
      interimEl.textContent = payload.text || "";
      return;
    }

    if (payload.type === "final") {
      interimEl.textContent = "";
      appendFinalLine(payload.text || "");
      return;
    }

    if (payload.type === "saved") {
      setStatus(`保存完了: ${payload.path}`);
      return;
    }

    if (payload.type === "refined") {
      finalTextEl.value = payload.all || "";
      setStatus(`精度補正完了: ${payload.lineCount}行`);
      return;
    }

    if (payload.type === "reset") {
      finalTextEl.value = "";
      interimEl.textContent = "";
      setStatus("テキストをクリアしました");
      return;
    }

    if (payload.type === "error") {
      setStatus(`エラー: ${payload.message}`);
    }
  };

  ws.onclose = () => {
    setStatus("接続が切断されました");
    ws = null;
    isRecording = false;
    updateButtons(false);
  };

  ws.onerror = () => {
    setStatus("WebSocketエラー");
  };
}

async function startRecording() {
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    setStatus("先に接続してください");
    return;
  }

  ws.send(
    JSON.stringify({
      type: "start",
      language: languageInput.value.trim() || "ja",
    }),
  );

  sendBuffer = new Float32Array(0);
  mediaStream = await navigator.mediaDevices.getUserMedia({
    audio: {
      channelCount: 1,
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    },
    video: false,
  });
  audioContext = new AudioContext({
    sampleRate: 48000,
    latencyHint: "interactive",
  });
  sourceNode = audioContext.createMediaStreamSource(mediaStream);
  processorNode = audioContext.createScriptProcessor(4096, 1, 1);

  processorNode.onaudioprocess = (event) => {
    if (!isRecording || !ws || ws.readyState !== WebSocket.OPEN) {
      return;
    }

    const input = event.inputBuffer.getChannelData(0);
    processAndQueue(input);
  };

  sourceNode.connect(processorNode);
  processorNode.connect(audioContext.destination);

  isRecording = true;
  updateButtons(true);
}

async function stopRecording() {
  if (!isRecording) return;

  isRecording = false;
  updateButtons(true);

  if (ws && ws.readyState === WebSocket.OPEN) {
    if (sendBuffer.length > 0) {
      sendPcmToServer(sendBuffer);
      sendBuffer = new Float32Array(0);
    }
    ws.send(JSON.stringify({ type: "stop" }));
  }

  if (processorNode) {
    processorNode.disconnect();
    processorNode.onaudioprocess = null;
    processorNode = null;
  }

  if (sourceNode) {
    sourceNode.disconnect();
    sourceNode = null;
  }

  if (mediaStream) {
    mediaStream.getTracks().forEach((track) => track.stop());
    mediaStream = null;
  }

  if (audioContext) {
    await audioContext.close();
    audioContext = null;
  }
}

connectBtn.addEventListener("click", connect);

startBtn.addEventListener("click", async () => {
  try {
    await startRecording();
  } catch (err) {
    setStatus(`録音開始失敗: ${err.message}`);
    isRecording = false;
    updateButtons(true);
  }
});

stopBtn.addEventListener("click", async () => {
  await stopRecording();
});

saveBtn.addEventListener("click", () => {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify({ type: "save" }));
});

resetBtn.addEventListener("click", () => {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify({ type: "reset" }));
  finalTextEl.value = "";
  interimEl.textContent = "";
});
