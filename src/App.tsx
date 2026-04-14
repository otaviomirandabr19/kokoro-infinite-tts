import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { KokoroTTS } from 'kokoro-js'
import './App.css'
import {
  MODEL_ID,
  SAMPLE_TEXT,
  VOICE_OPTIONS,
  buildWavBlob,
  chunkTextForKokoro,
  estimateDurationSeconds,
  formatSeconds,
  getErrorMessage,
  getLoadAttempts,
  toPercent,
  type DevicePreference,
  type VoiceId,
} from './lib/kokoro'

type ModelState = 'idle' | 'loading' | 'ready' | 'error'
type RunState = 'idle' | 'generating' | 'complete' | 'stopped' | 'error'
type ChunkStatus = 'queued' | 'rendering' | 'ready' | 'error'

type ChunkRecord = {
  index: number
  text: string
  chars: number
  status: ChunkStatus
  durationSeconds?: number
  error?: string
}

const STOP_MESSAGE = '__STOP_REQUESTED__'

function App() {
  const [text, setText] = useState<string>(SAMPLE_TEXT.pt)
  const [voiceId, setVoiceId] = useState<VoiceId>('pf_dora')
  const [speed, setSpeed] = useState(1)
  const [devicePreference, setDevicePreference] =
    useState<DevicePreference>('auto')
  const [modelState, setModelState] = useState<ModelState>('idle')
  const [modelMessage, setModelMessage] = useState(
    'Model idle — first run loads weights directly in the browser.',
  )
  const [modelProgress, setModelProgress] = useState(0)
  const [modelFile, setModelFile] = useState('')
  const [engineLabel, setEngineLabel] = useState('Awaiting first load')
  const [runState, setRunState] = useState<RunState>('idle')
  const [runMessage, setRunMessage] = useState(
    'Paste a long script, then render a stitched WAV without a backend.',
  )
  const [chunks, setChunks] = useState<ChunkRecord[]>([])
  const [completedChunks, setCompletedChunks] = useState(0)
  const [totalDurationSeconds, setTotalDurationSeconds] = useState(0)
  const [downloadUrl, setDownloadUrl] = useState<string | null>(null)
  const [lastError, setLastError] = useState<string | null>(null)
  const [logs, setLogs] = useState<string[]>([
    'Browser-only pipeline ready — Kokoro model, voices, chunking, and export stay on the client.',
  ])

  const ttsRef = useRef<KokoroTTS | null>(null)
  const runTokenRef = useRef(0)
  const downloadUrlRef = useRef<string | null>(null)
  const audioContextRef = useRef<AudioContext | null>(null)
  const scheduledAtRef = useRef(0)
  const sourcesRef = useRef<AudioBufferSourceNode[]>([])

  const plannedChunks = useMemo(() => chunkTextForKokoro(text), [text])
  const estimatedDuration = useMemo(
    () => estimateDurationSeconds(text, speed),
    [text, speed],
  )
  const selectedVoice = useMemo(
    () => VOICE_OPTIONS.find((voice) => voice.id === voiceId) ?? VOICE_OPTIONS[0],
    [voiceId],
  )
  const chunkProgress = plannedChunks.length
    ? Math.round((completedChunks / plannedChunks.length) * 100)
    : 0

  const appendLog = useCallback((message: string) => {
    const timestamp = new Date().toLocaleTimeString([], {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    })

    setLogs((current) => [...current.slice(-7), `${timestamp} · ${message}`])
  }, [])

  const clearDownload = useCallback(() => {
    if (downloadUrlRef.current) {
      URL.revokeObjectURL(downloadUrlRef.current)
      downloadUrlRef.current = null
    }
    setDownloadUrl(null)
  }, [])

  const stopPlayback = useCallback(() => {
    for (const source of sourcesRef.current) {
      try {
        source.stop()
      } catch {
        // no-op
      }
    }

    sourcesRef.current = []
    scheduledAtRef.current = 0

    if (audioContextRef.current) {
      const activeContext = audioContextRef.current
      audioContextRef.current = null
      void activeContext.close().catch(() => undefined)
    }
  }, [])

  const streamChunk = useCallback(async (blob: Blob) => {
    if (typeof window === 'undefined' || typeof AudioContext === 'undefined') {
      return
    }

    let context = audioContextRef.current
    if (!context || context.state === 'closed') {
      context = new AudioContext()
      audioContextRef.current = context
      scheduledAtRef.current = context.currentTime + 0.08
    }

    await context.resume()
    const arrayBuffer = await blob.arrayBuffer()
    const audioBuffer = await context.decodeAudioData(arrayBuffer.slice(0))
    const source = context.createBufferSource()
    source.buffer = audioBuffer
    source.connect(context.destination)

    const startAt = Math.max(context.currentTime + 0.05, scheduledAtRef.current)
    source.start(startAt)
    scheduledAtRef.current = startAt + audioBuffer.duration

    sourcesRef.current.push(source)
    source.onended = () => {
      sourcesRef.current = sourcesRef.current.filter((item) => item !== source)
    }
  }, [])

  const ensureEngine = useCallback(async () => {
    if (ttsRef.current) {
      return ttsRef.current
    }

    setModelState('loading')
    setModelMessage('Loading Kokoro weights and tokenizer…')
    setModelProgress(0)
    setModelFile('Preparing download queue…')
    setLastError(null)

    const attempts = getLoadAttempts(devicePreference)
    let failure: Error | null = null

    for (const attempt of attempts) {
      try {
        appendLog(`Loading ${MODEL_ID} on ${attempt.label}.`)
        setEngineLabel(attempt.label)

        const { KokoroTTS } = await import('kokoro-js')
        const engine = await KokoroTTS.from_pretrained(MODEL_ID, {
          device: attempt.device,
          dtype: attempt.dtype,
          progress_callback: (event) => {
            const payload =
              event && typeof event === 'object'
                ? (event as Record<string, unknown>)
                : null

            const progressValue = payload?.progress
            const numericProgress =
              typeof progressValue === 'number' ? toPercent(progressValue) : 0
            const fileLabel = [payload?.status, payload?.file]
              .filter((value): value is string => typeof value === 'string')
              .join(' · ')

            setModelProgress(numericProgress)
            setModelFile(fileLabel || 'Downloading model assets…')
          },
        })

        ttsRef.current = engine
        setModelState('ready')
        setModelProgress(100)
        setModelMessage('Engine ready — subsequent runs use the cached browser assets.')
        setModelFile('Tokenizer, ONNX graph, and voice files are available.')
        appendLog(`Engine ready on ${attempt.label}.`)
        return engine
      } catch (error) {
        failure = error instanceof Error ? error : new Error('Model load failed')
        appendLog(`Load attempt failed on ${attempt.label}: ${failure.message}`)
      }
    }

    const message = failure?.message ?? 'Unable to load Kokoro in this browser.'
    setModelState('error')
    setModelMessage(message)
    setLastError(message)
    throw new Error(message)
  }, [appendLog, devicePreference])

  const stopRun = useCallback(
    (message = 'Generation stopped.') => {
      runTokenRef.current += 1
      stopPlayback()
      setRunState('stopped')
      setRunMessage(message)
    },
    [stopPlayback],
  )

  const resetEngine = useCallback(() => {
    stopRun('Engine reset. Load again to apply a new device preference.')
    ttsRef.current = null
    setModelState('idle')
    setModelMessage('Model idle — reload to apply a different device mode.')
    setModelProgress(0)
    setModelFile('')
    setEngineLabel('Awaiting first load')
    appendLog('Engine reset. Next render will re-download metadata if needed.')
  }, [appendLog, stopRun])

  const handleGenerate = useCallback(async () => {
    const nextChunks = chunkTextForKokoro(text)

    if (!nextChunks.length) {
      setRunState('error')
      setRunMessage('Add some text before generating audio.')
      setLastError('The text area is empty.')
      return
    }

    const token = runTokenRef.current + 1
    runTokenRef.current = token

    clearDownload()
    stopPlayback()
    setLastError(null)
    setCompletedChunks(0)
    setTotalDurationSeconds(0)
    setChunks(
      nextChunks.map((chunk, index) => ({
        index,
        text: chunk,
        chars: chunk.length,
        status: 'queued',
      })),
    )
    setRunState('generating')
    setRunMessage(`Rendering ${nextChunks.length} chunks with ${selectedVoice.label}.`)
    appendLog(`Run started with ${nextChunks.length} chunks and ${selectedVoice.label}.`)

    try {
      const engine = await ensureEngine()
      const renderedAudio: Float32Array[] = []
      let samplingRate = 24000

      for (const [index, chunkText] of nextChunks.entries()) {
        if (runTokenRef.current !== token) {
          throw new Error(STOP_MESSAGE)
        }

        setChunks((current) =>
          current.map((chunk) =>
            chunk.index === index ? { ...chunk, status: 'rendering' } : chunk,
          ),
        )
        setRunMessage(`Rendering chunk ${index + 1} of ${nextChunks.length}…`)

        const audio = await engine.generate(chunkText, {
          voice: voiceId as never,
          speed,
        })

        if (runTokenRef.current !== token) {
          throw new Error(STOP_MESSAGE)
        }

        const duration = audio.audio.length / audio.sampling_rate
        renderedAudio.push(audio.audio)
        samplingRate = audio.sampling_rate
        setCompletedChunks(index + 1)
        setTotalDurationSeconds((current) => current + duration)
        setChunks((current) =>
          current.map((chunk) =>
            chunk.index === index
              ? {
                  ...chunk,
                  status: 'ready',
                  durationSeconds: duration,
                }
              : chunk,
          ),
        )

        await streamChunk(audio.toBlob())
        appendLog(
          `Chunk ${index + 1}/${nextChunks.length} ready (${formatSeconds(duration)}).`,
        )
      }

      const wavBlob = buildWavBlob(renderedAudio, samplingRate)
      const objectUrl = URL.createObjectURL(wavBlob)
      downloadUrlRef.current = objectUrl
      setDownloadUrl(objectUrl)
      setRunState('complete')
      setRunMessage('Done — all chunks stitched into one downloadable WAV.')
      appendLog(`Run complete. Exported a single WAV from ${nextChunks.length} chunks.`)
    } catch (error) {
      const message = getErrorMessage(error)
      if (message === STOP_MESSAGE) {
        setRunState('stopped')
        setRunMessage('Generation stopped before finishing all chunks.')
        appendLog('Run stopped by the operator.')
        return
      }

      setRunState('error')
      setRunMessage(message)
      setLastError(message)
      appendLog(`Run failed: ${message}`)
    }
  }, [
    appendLog,
    clearDownload,
    ensureEngine,
    selectedVoice.label,
    speed,
    stopPlayback,
    text,
    streamChunk,
    voiceId,
  ])

  useEffect(() => {
    return () => {
      runTokenRef.current += 1
      stopPlayback()
      if (downloadUrlRef.current) {
        URL.revokeObjectURL(downloadUrlRef.current)
      }
    }
  }, [stopPlayback])

  return (
    <div className="app-shell">
      <div className="ambient ambient-left" aria-hidden="true" />
      <div className="ambient ambient-right" aria-hidden="true" />

      <header className="hero-panel panel">
        <div className="hero-copy">
          <p className="eyebrow">Kokoro.js · browser-first TTS studio</p>
          <h1>
            Infinite narration, <span>zero backend</span>.
          </h1>
          <p className="hero-lead">
            This interface takes very long text, splits it into Kokoro-safe chunks,
            streams each render in sequence, and exports a single stitched WAV — all
            from the browser.
          </p>

          <div className="hero-tags">
            <span>No server</span>
            <span>Portuguese + English</span>
            <span>Chunked long-form audio</span>
            <span>WebGPU / WASM fallback</span>
          </div>
        </div>

        <div className="hero-metrics">
          <article className="metric-card">
            <span className="metric-label">Characters</span>
            <strong>{text.trim().length.toLocaleString()}</strong>
            <small>Live textarea count</small>
          </article>
          <article className="metric-card">
            <span className="metric-label">Planned chunks</span>
            <strong>{plannedChunks.length}</strong>
            <small>Safe {320}-char packing</small>
          </article>
          <article className="metric-card">
            <span className="metric-label">Estimated runtime</span>
            <strong>{formatSeconds(estimatedDuration)}</strong>
            <small>Approximate speech length</small>
          </article>
        </div>
      </header>

      <main className="workspace-grid">
        <section className="panel composer-panel">
          <div className="panel-heading">
            <div>
              <p className="section-kicker">Script lab</p>
              <h2>Paste a long script</h2>
            </div>
            <div className="sample-actions">
              <button
                type="button"
                className="ghost-button"
                onClick={() => {
                  setText(SAMPLE_TEXT.pt)
                  setVoiceId('pf_dora')
                  appendLog('Loaded the Portuguese demo script.')
                }}
              >
                PT sample
              </button>
              <button
                type="button"
                className="ghost-button"
                onClick={() => {
                  setText(SAMPLE_TEXT.en)
                  setVoiceId('af_heart')
                  appendLog('Loaded the English demo script.')
                }}
              >
                EN sample
              </button>
            </div>
          </div>

          <label className="textarea-shell">
            <span className="textarea-meta">Long-form input · automatic chunk planning</span>
            <textarea
              value={text}
              onChange={(event) => setText(event.target.value)}
              placeholder="Paste one paragraph or an entire book chapter here…"
              spellCheck={false}
            />
          </label>

          <div className="chunk-preview">
            <div className="panel-heading compact">
              <div>
                <p className="section-kicker">Chunk planner</p>
                <h2>How the text will be split</h2>
              </div>
              <p className="subtle-copy">
                Sentence-first, clause-aware, then word-safe fallback.
              </p>
            </div>

            <div className="chip-grid">
              {plannedChunks.slice(0, 8).map((chunk, index) => (
                <article key={`${index}-${chunk.slice(0, 16)}`} className="chunk-chip">
                  <div>
                    <span>Chunk {index + 1}</span>
                    <strong>{chunk.length} chars</strong>
                  </div>
                  <p>{chunk}</p>
                </article>
              ))}
            </div>

            {plannedChunks.length > 8 ? (
              <p className="subtle-copy muted">
                +{plannedChunks.length - 8} more chunks hidden from preview.
              </p>
            ) : null}
          </div>
        </section>

        <section className="panel control-panel">
          <div className="panel-heading compact">
            <div>
              <p className="section-kicker">Voice rig</p>
              <h2>Render controls</h2>
            </div>
            <span className={`status-pill ${modelState}`}>{modelState}</span>
          </div>

          <div className="field-grid">
            <label className="field">
              <span>Voice</span>
              <select
                value={voiceId}
                onChange={(event) => setVoiceId(event.target.value as VoiceId)}
              >
                {VOICE_OPTIONS.map((voice) => (
                  <option key={voice.id} value={voice.id}>
                    {voice.language} · {voice.label} ({voice.accent})
                  </option>
                ))}
              </select>
            </label>

            <label className="field">
              <span>Device</span>
              <select
                value={devicePreference}
                onChange={(event) =>
                  setDevicePreference(event.target.value as DevicePreference)
                }
              >
                <option value="auto">Auto (prefer WebGPU)</option>
                <option value="webgpu">WebGPU only</option>
                <option value="wasm">WASM only</option>
              </select>
            </label>
          </div>

          <label className="field slider-field">
            <span>
              Speed <strong>{speed.toFixed(2)}x</strong>
            </span>
            <input
              type="range"
              min="0.8"
              max="1.4"
              step="0.05"
              value={speed}
              onChange={(event) => setSpeed(Number(event.target.value))}
            />
          </label>

          <article className="info-card accent">
            <p className="info-label">Selected voice</p>
            <h3>
              {selectedVoice.label} · {selectedVoice.language}
            </h3>
            <p>{selectedVoice.description}</p>
            <ul>
              <li>Accent: {selectedVoice.accent}</li>
              <li>Current engine: {engineLabel}</li>
              <li>Model cache survives future runs in the same browser.</li>
            </ul>
          </article>

          <div className="action-row">
            <button
              type="button"
              className="primary-button"
              onClick={() => {
                void handleGenerate()
              }}
              disabled={runState === 'generating'}
            >
              {runState === 'generating' ? 'Rendering…' : 'Generate infinite audio'}
            </button>
            <button
              type="button"
              className="ghost-button"
              onClick={() => {
                void ensureEngine()
              }}
              disabled={modelState === 'loading' || runState === 'generating'}
            >
              Warm model
            </button>
            <button
              type="button"
              className="ghost-button"
              onClick={() => {
                stopRun()
                appendLog('Stopped playback and generation queue.')
              }}
              disabled={runState !== 'generating'}
            >
              Stop
            </button>
            <button
              type="button"
              className="ghost-button"
              onClick={resetEngine}
              disabled={modelState === 'loading' || runState === 'generating'}
            >
              Reset engine
            </button>
          </div>

          <article className="status-card">
            <div className="status-header">
              <div>
                <p className="info-label">Model load</p>
                <h3>{modelMessage}</h3>
              </div>
              <strong>{Math.round(modelProgress)}%</strong>
            </div>
            <div className="progress-track">
              <span style={{ width: `${modelProgress}%` }} />
            </div>
            <p className="subtle-copy">{modelFile || 'No active download yet.'}</p>
          </article>

          <article className="status-card">
            <div className="status-header">
              <div>
                <p className="info-label">Generation run</p>
                <h3>{runMessage}</h3>
              </div>
              <strong>{chunkProgress}%</strong>
            </div>
            <div className="progress-track">
              <span style={{ width: `${chunkProgress}%` }} />
            </div>
            <p className="subtle-copy">
              {completedChunks}/{plannedChunks.length || 0} chunks complete ·{' '}
              {formatSeconds(totalDurationSeconds)} rendered so far
            </p>
          </article>

          {downloadUrl ? (
            <article className="info-card playback-card">
              <p className="info-label">Final stitched WAV</p>
              <h3>Replay or download the merged output</h3>
              <audio controls src={downloadUrl} className="audio-player" />
              <a className="primary-button download-link" href={downloadUrl} download="kokoro-infinite.wav">
                Download WAV
              </a>
            </article>
          ) : null}

          <article className="info-card log-card">
            <p className="info-label">Run log</p>
            <h3>Execution notes</h3>
            <ul className="log-list">
              {logs.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          </article>

          {lastError ? <p className="error-copy">{lastError}</p> : null}
        </section>

        <section className="panel queue-panel">
          <div className="panel-heading compact">
            <div>
              <p className="section-kicker">Render queue</p>
              <h2>Chunk-by-chunk status</h2>
            </div>
            <p className="subtle-copy">Each finished chunk is already streamed to the speakers.</p>
          </div>

          <div className="queue-list">
            {chunks.length ? (
              chunks.map((chunk) => (
                <article key={chunk.index} className={`queue-item ${chunk.status}`}>
                  <div className="queue-meta">
                    <span>Chunk {chunk.index + 1}</span>
                    <strong>{chunk.chars} chars</strong>
                    <em>{chunk.durationSeconds ? formatSeconds(chunk.durationSeconds) : '—'}</em>
                  </div>
                  <p>{chunk.text}</p>
                  <span className="queue-state">{chunk.status}</span>
                </article>
              ))
            ) : (
              <article className="empty-state">
                <p>
                  Your queue will appear here after the text is chunked. Paste a script,
                  choose a voice, and start rendering.
                </p>
              </article>
            )}
          </div>
        </section>
      </main>
    </div>
  )
}

export default App
