import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { KokoroTTS } from 'kokoro-js'
import './App.css'
import {
  DEFAULT_VOICE_ID,
  MODEL_ID,
  SAMPLE_TEXT,
  VOICE_OPTIONS,
  VOICE_SUPPORT_NOTE,
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
const SCRIPT_STORAGE_KEY = 'kokoro-infinite-tts:script-draft'
const REMOVED_SAMPLE_PREFIXES = [
  'No estúdio preto e verde-limão, cada frase vira uma faixa sonora contínua.',
]

const MODEL_STATE_LABELS = {
  idle: 'Idle',
  loading: 'Loading',
  ready: 'Ready',
  error: 'Error',
} satisfies Record<ModelState, string>

const CHUNK_STATUS_LABELS = {
  queued: 'Queued',
  rendering: 'Generating',
  ready: 'Ready',
  error: 'Error',
} satisfies Record<ChunkStatus, string>

function getInitialText() {
  if (typeof window === 'undefined') {
    return SAMPLE_TEXT.en
  }

  try {
    const savedDraft = window.localStorage.getItem(SCRIPT_STORAGE_KEY)

    if (savedDraft === null) {
      return SAMPLE_TEXT.en
    }

    if (REMOVED_SAMPLE_PREFIXES.some((prefix) => savedDraft.startsWith(prefix))) {
      window.localStorage.setItem(SCRIPT_STORAGE_KEY, SAMPLE_TEXT.en)
      return SAMPLE_TEXT.en
    }

    return savedDraft
  } catch {
    return SAMPLE_TEXT.en
  }
}

function App() {
  const [text, setText] = useState<string>(() => getInitialText())
  const [voiceId, setVoiceId] = useState<VoiceId>(DEFAULT_VOICE_ID)
  const [speed, setSpeed] = useState(1)
  const [devicePreference, setDevicePreference] =
    useState<DevicePreference>('auto')
  const [modelState, setModelState] = useState<ModelState>('idle')
  const [modelMessage, setModelMessage] = useState(
    'Load the engine once, then render long scripts in this browser.',
  )
  const [modelProgress, setModelProgress] = useState(0)
  const [modelFile, setModelFile] = useState('')
  const [engineLabel, setEngineLabel] = useState('Awaiting first load')
  const [runState, setRunState] = useState<RunState>('idle')
  const [runMessage, setRunMessage] = useState(
    'Paste a script, choose a voice, and generate a single downloadable WAV.',
  )
  const [chunks, setChunks] = useState<ChunkRecord[]>([])
  const [completedChunks, setCompletedChunks] = useState(0)
  const [totalDurationSeconds, setTotalDurationSeconds] = useState(0)
  const [downloadUrl, setDownloadUrl] = useState<string | null>(null)
  const [lastError, setLastError] = useState<string | null>(null)
  const [logs, setLogs] = useState<string[]>([
    'Ready for long-form text-to-speech with local chunking, voice rendering, and WAV export.',
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
    setModelMessage('Loading voices and model files…')
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
            setModelFile(fileLabel || 'Downloading voice and model assets…')
          },
        })

        ttsRef.current = engine
        setModelState('ready')
        setModelProgress(100)
        setModelMessage('Engine ready — future runs can reuse cached browser assets.')
        setModelFile('Voice files, tokenizer, and model graph are ready.')
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
    stopRun('Engine reset. Load it again to apply a different performance mode.')
    ttsRef.current = null
    setModelState('idle')
    setModelMessage('Engine idle — load it again to use the selected performance mode.')
    setModelProgress(0)
    setModelFile('')
    setEngineLabel('Awaiting first load')
    setLastError(null)
    appendLog('Engine reset. The next render will reload the selected performance mode.')
  }, [appendLog, stopRun])

  const handleGenerate = useCallback(async () => {
    const nextChunks = chunkTextForKokoro(text)

    if (!nextChunks.length) {
      setRunState('error')
      setRunMessage('Add a script before generating audio.')
      setLastError('The script area is empty.')
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
    setRunMessage(`Generating ${nextChunks.length} parts with ${selectedVoice.label}.`)
    appendLog(`Run started with ${nextChunks.length} parts and ${selectedVoice.label}.`)

    let activeChunkIndex = -1

    try {
      const engine = await ensureEngine()
      const renderedAudio: Float32Array[] = []
      let samplingRate = 24000

      for (const [index, chunkText] of nextChunks.entries()) {
        if (runTokenRef.current !== token) {
          throw new Error(STOP_MESSAGE)
        }

        activeChunkIndex = index
        setChunks((current) =>
          current.map((chunk) =>
            chunk.index === index
              ? { ...chunk, status: 'rendering', error: undefined }
              : chunk,
          ),
        )
        setRunMessage(`Generating part ${index + 1} of ${nextChunks.length}…`)

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
                  error: undefined,
                }
              : chunk,
          ),
        )

        await streamChunk(audio.toBlob())
        appendLog(
          `Part ${index + 1}/${nextChunks.length} ready (${formatSeconds(duration)}).`,
        )
      }

      const wavBlob = buildWavBlob(renderedAudio, samplingRate)
      const objectUrl = URL.createObjectURL(wavBlob)
      downloadUrlRef.current = objectUrl
      setDownloadUrl(objectUrl)
      setRunState('complete')
      setRunMessage('Done — your full script is ready as one WAV download.')
      appendLog(`Run complete. Exported one WAV from ${nextChunks.length} parts.`)
    } catch (error) {
      const message = getErrorMessage(error)

      if (message === STOP_MESSAGE) {
        if (activeChunkIndex >= 0) {
          setChunks((current) =>
            current.map((chunk) =>
              chunk.index === activeChunkIndex && chunk.status === 'rendering'
                ? { ...chunk, status: 'queued' }
                : chunk,
            ),
          )
        }

        setRunState('stopped')
        setRunMessage('Generation stopped before the full script finished.')
        appendLog('Run stopped before the current part finished.')
        return
      }

      if (activeChunkIndex >= 0) {
        setChunks((current) =>
          current.map((chunk) =>
            chunk.index === activeChunkIndex
              ? { ...chunk, status: 'error', error: message }
              : chunk,
          ),
        )
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
    if (typeof window === 'undefined') {
      return
    }

    try {
      window.localStorage.setItem(SCRIPT_STORAGE_KEY, text)
    } catch {
      // Ignore storage failures.
    }
  }, [text])

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
          <p className="eyebrow">Long-form text to speech</p>
          <h1>
            Long-form text to speech, <span>right in your browser.</span>
          </h1>
          <p className="hero-lead">
            Paste a script, choose from the current Kokoro voice set, and
            generate a single downloadable WAV with no backend or paid API.
          </p>

          <div className="hero-tags">
            <span>No backend</span>
            <span>No paid API</span>
            <span>{VOICE_OPTIONS.length} available voices</span>
            <span>Single WAV download</span>
          </div>
        </div>

        <div className="hero-metrics">
          <article className="metric-card">
            <span className="metric-label">Script length</span>
            <strong>{text.trim().length.toLocaleString()}</strong>
            <small>Characters in your current draft</small>
          </article>
          <article className="metric-card">
            <span className="metric-label">Render plan</span>
            <strong>{plannedChunks.length}</strong>
            <small>Automatic sentence and clause grouping</small>
          </article>
          <article className="metric-card">
            <span className="metric-label">Estimated audio</span>
            <strong>{formatSeconds(estimatedDuration)}</strong>
            <small>Approximate speech length</small>
          </article>
        </div>
      </header>

      <main className="workspace-grid">
        <section className="panel composer-panel">
          <div className="panel-heading">
            <div>
              <p className="section-kicker">Script</p>
              <h2>Paste a long script</h2>
            </div>
            <div className="sample-actions">
              <button
                type="button"
                className="ghost-button"
                onClick={() => {
                  setText(SAMPLE_TEXT.en)
                  setVoiceId(DEFAULT_VOICE_ID)
                  appendLog('Loaded the sample script.')
                }}
              >
                Load sample
              </button>
              <button
                type="button"
                className="ghost-button"
                onClick={() => {
                  setText('')
                  appendLog('Cleared the current draft.')
                }}
                disabled={!text.length}
              >
                Clear script
              </button>
            </div>
          </div>

          <label className="textarea-shell">
            <span className="textarea-meta">
              Long script input · autosaves in this browser
            </span>
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
                <p className="section-kicker">Render plan</p>
                <h2>Preview the flow</h2>
              </div>
              <p className="subtle-copy">
                Automatic sentence and clause grouping for long scripts.
              </p>
            </div>

            <div className="chip-grid">
              {plannedChunks.slice(0, 8).map((chunk, index) => (
                <article key={`${index}-${chunk.slice(0, 16)}`} className="chunk-chip">
                  <div>
                    <span>Part {index + 1}</span>
                    <strong>{chunk.length} chars</strong>
                  </div>
                  <p>{chunk}</p>
                </article>
              ))}
            </div>

            {plannedChunks.length > 8 ? (
              <p className="subtle-copy muted">
                +{plannedChunks.length - 8} more parts hidden from preview.
              </p>
            ) : null}
          </div>
        </section>

        <section className="panel control-panel">
          <div className="panel-heading compact">
            <div>
              <p className="section-kicker">Voice &amp; output</p>
              <h2>Choose voice and generate</h2>
            </div>
            <span className={`status-pill ${modelState}`}>
              {MODEL_STATE_LABELS[modelState]}
            </span>
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
              <span>Performance mode</span>
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
              <li>Current engine mode: {engineLabel}</li>
              <li>Model cache stays available for future runs in this browser tab.</li>
            </ul>
          </article>

          <p className="subtle-copy support-note">{VOICE_SUPPORT_NOTE}</p>

          <div className="action-row">
            <button
              type="button"
              className="primary-button"
              onClick={() => {
                void handleGenerate()
              }}
              disabled={runState === 'generating'}
            >
              {runState === 'generating' ? 'Generating…' : 'Generate audio'}
            </button>
            <button
              type="button"
              className="ghost-button"
              onClick={() => {
                void ensureEngine()
              }}
              disabled={modelState === 'loading' || runState === 'generating'}
            >
              Load engine
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
                <p className="info-label">Engine status</p>
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
                <p className="info-label">Audio render</p>
                <h3>{runMessage}</h3>
              </div>
              <strong>{chunkProgress}%</strong>
            </div>
            <div className="progress-track">
              <span style={{ width: `${chunkProgress}%` }} />
            </div>
            <p className="subtle-copy">
              {completedChunks}/{plannedChunks.length || 0} parts complete ·{' '}
              {formatSeconds(totalDurationSeconds)} rendered so far
            </p>
          </article>

          {downloadUrl ? (
            <article className="info-card playback-card">
              <p className="info-label">Your WAV export</p>
              <h3>Replay it or download the finished file</h3>
              <audio controls src={downloadUrl} className="audio-player" />
              <a
                className="primary-button download-link"
                href={downloadUrl}
                download="kokoro-infinite.wav"
              >
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
              <p className="section-kicker">Generation progress</p>
              <h2>Track each rendered part</h2>
            </div>
            <p className="subtle-copy">
              Finished parts start playing as soon as they are ready.
            </p>
          </div>

          <div className="queue-list">
            {chunks.length ? (
              chunks.map((chunk) => (
                <article key={chunk.index} className={`queue-item ${chunk.status}`}>
                  <div className="queue-meta">
                    <span>Part {chunk.index + 1}</span>
                    <strong>{chunk.chars} chars</strong>
                    <em>
                      {chunk.durationSeconds ? formatSeconds(chunk.durationSeconds) : '—'}
                    </em>
                  </div>
                  <p>{chunk.text}</p>
                  <span className="queue-state">
                    {CHUNK_STATUS_LABELS[chunk.status]}
                  </span>
                  {chunk.error ? <p className="queue-error">{chunk.error}</p> : null}
                </article>
              ))
            ) : (
              <article className="empty-state">
                <p>
                  Your generation queue appears here after you split the script.
                  Paste text, choose a voice, and start rendering.
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
