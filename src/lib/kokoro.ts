export type VoiceDefinition = {
  id: string
  label: string
  language: string
  accent: string
  description: string
}

export type DevicePreference = 'auto' | 'webgpu' | 'wasm'

export type LoadAttempt = {
  device: 'webgpu' | 'wasm'
  dtype: 'fp32' | 'q8'
  label: string
}

export const MODEL_ID = 'onnx-community/Kokoro-82M-v1.0-ONNX'
export const SAFE_CHUNK_SIZE = 320

export const VOICE_OPTIONS = [
  {
    id: 'pf_dora',
    label: 'Dora',
    language: 'Portuguese',
    accent: 'Brazilian',
    description: 'Warm Brazilian Portuguese with a steady storyteller tone.',
  },
  {
    id: 'pm_alex',
    label: 'Alex',
    language: 'Portuguese',
    accent: 'Brazilian',
    description: 'Clear Brazilian Portuguese voice with a brighter read.',
  },
  {
    id: 'af_heart',
    label: 'Heart',
    language: 'English',
    accent: 'American',
    description: 'The classic Kokoro favorite: smooth, intimate, and natural.',
  },
  {
    id: 'af_bella',
    label: 'Bella',
    language: 'English',
    accent: 'American',
    description: 'Confident American English with a polished promo feel.',
  },
  {
    id: 'am_michael',
    label: 'Michael',
    language: 'English',
    accent: 'American',
    description: 'Balanced male narration voice for long-form scripts.',
  },
  {
    id: 'bf_emma',
    label: 'Emma',
    language: 'English',
    accent: 'British',
    description: 'Soft British English with a refined delivery.',
  },
] as const satisfies readonly VoiceDefinition[]

export type VoiceId = (typeof VOICE_OPTIONS)[number]['id']

export const SAMPLE_TEXT = {
  pt: `No estúdio preto e verde-limão, cada frase vira uma faixa sonora contínua. A proposta aqui é simples: você cola um texto enorme, o navegador divide tudo em partes seguras para o Kokoro, gera cada trecho em sequência e emenda o resultado em um único fluxo. Sem backend, sem API paga, só o navegador trabalhando localmente com download progressivo e reprodução por partes.`,
  en: `Inside this black-and-lime voice lab, every paragraph becomes a continuous spoken ribbon. Drop a very long script, let the browser split it into Kokoro-safe segments, render each chunk one after another, and stitch the result into one uninterrupted export. No backend, no paid API, just a browser-first audio machine built for long-form narration.`,
} as const

export function getLoadAttempts(preference: DevicePreference): LoadAttempt[] {
  const hasWebGPU = typeof navigator !== 'undefined' && 'gpu' in navigator

  if (preference === 'webgpu') {
    return hasWebGPU
      ? [{ device: 'webgpu', dtype: 'fp32', label: 'WebGPU · fp32' }]
      : [{ device: 'wasm', dtype: 'q8', label: 'WASM fallback · q8' }]
  }

  if (preference === 'wasm') {
    return [{ device: 'wasm', dtype: 'q8', label: 'WASM · q8' }]
  }

  return hasWebGPU
    ? [
        { device: 'webgpu', dtype: 'fp32', label: 'WebGPU · fp32' },
        { device: 'wasm', dtype: 'q8', label: 'WASM fallback · q8' },
      ]
    : [{ device: 'wasm', dtype: 'q8', label: 'WASM · q8' }]
}

export function normalizeText(input: string): string {
  return input
    .replace(/\r\n/g, '\n')
    .replace(/[\t ]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

export function chunkTextForKokoro(input: string, maxChars = SAFE_CHUNK_SIZE): string[] {
  const normalized = normalizeText(input)

  if (!normalized) {
    return []
  }

  const paragraphs = normalized.split(/\n{2,}/).map((paragraph) => paragraph.trim())
  const sentenceLikeSegments = paragraphs.flatMap((paragraph) =>
    paragraph
      .split(/(?<=[.!?…])\s+/)
      .map((segment) => segment.trim())
      .filter(Boolean),
  )

  const safeSegments = sentenceLikeSegments.flatMap((segment) =>
    splitOversizedSegment(segment, maxChars),
  )

  const chunks: string[] = []
  let current = ''

  for (const segment of safeSegments) {
    if (!current) {
      current = segment
      continue
    }

    const candidate = `${current} ${segment}`

    if (candidate.length <= maxChars) {
      current = candidate
    } else {
      chunks.push(current)
      current = segment
    }
  }

  if (current) {
    chunks.push(current)
  }

  return chunks
}

function splitOversizedSegment(segment: string, maxChars: number): string[] {
  if (segment.length <= maxChars) {
    return [segment]
  }

  const clauses = segment
    .split(/(?<=[,;:—-])\s+/)
    .map((part) => part.trim())
    .filter(Boolean)

  if (clauses.length > 1) {
    const collected: string[] = []
    let current = ''

    for (const clause of clauses) {
      if (clause.length > maxChars) {
        if (current) {
          collected.push(current)
          current = ''
        }
        collected.push(...splitByWords(clause, maxChars))
        continue
      }

      if (!current) {
        current = clause
        continue
      }

      const candidate = `${current} ${clause}`
      if (candidate.length <= maxChars) {
        current = candidate
      } else {
        collected.push(current)
        current = clause
      }
    }

    if (current) {
      collected.push(current)
    }

    return collected
  }

  return splitByWords(segment, maxChars)
}

function splitByWords(segment: string, maxChars: number): string[] {
  const words = segment.split(/\s+/).filter(Boolean)
  const chunks: string[] = []
  let current = ''

  for (const word of words) {
    if (word.length > maxChars) {
      if (current) {
        chunks.push(current)
        current = ''
      }

      for (let index = 0; index < word.length; index += maxChars) {
        chunks.push(word.slice(index, index + maxChars))
      }
      continue
    }

    if (!current) {
      current = word
      continue
    }

    const candidate = `${current} ${word}`
    if (candidate.length <= maxChars) {
      current = candidate
    } else {
      chunks.push(current)
      current = word
    }
  }

  if (current) {
    chunks.push(current)
  }

  return chunks
}

export function estimateDurationSeconds(text: string, speed: number): number {
  const words = normalizeText(text).split(/\s+/).filter(Boolean).length
  const baselineWordsPerSecond = 2.7
  return words / (baselineWordsPerSecond * Math.max(speed, 0.5))
}

export function formatSeconds(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) {
    return '0:00'
  }

  const minutes = Math.floor(seconds / 60)
  const remainder = Math.round(seconds % 60)
  return `${minutes}:${String(remainder).padStart(2, '0')}`
}

export function toPercent(value: number): number {
  const scaled = value <= 1 ? value * 100 : value
  return Math.max(0, Math.min(100, scaled))
}

export function buildWavBlob(chunks: Float32Array[], sampleRate: number): Blob {
  const totalLength = chunks.reduce((sum, chunk) => sum + chunk.length, 0)
  const merged = new Float32Array(totalLength)
  let offset = 0

  for (const chunk of chunks) {
    merged.set(chunk, offset)
    offset += chunk.length
  }

  const bytesPerSample = 2
  const blockAlign = bytesPerSample
  const buffer = new ArrayBuffer(44 + merged.length * bytesPerSample)
  const view = new DataView(buffer)

  writeAscii(view, 0, 'RIFF')
  view.setUint32(4, 36 + merged.length * bytesPerSample, true)
  writeAscii(view, 8, 'WAVE')
  writeAscii(view, 12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, 1, true)
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * blockAlign, true)
  view.setUint16(32, blockAlign, true)
  view.setUint16(34, 16, true)
  writeAscii(view, 36, 'data')
  view.setUint32(40, merged.length * bytesPerSample, true)

  let pointer = 44
  for (const sample of merged) {
    const clamped = Math.max(-1, Math.min(1, sample))
    view.setInt16(pointer, clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff, true)
    pointer += bytesPerSample
  }

  return new Blob([buffer], { type: 'audio/wav' })
}

function writeAscii(view: DataView, offset: number, value: string) {
  for (let index = 0; index < value.length; index += 1) {
    view.setUint8(offset + index, value.charCodeAt(index))
  }
}

export function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message
  }

  return 'Unknown error'
}
