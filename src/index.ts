/* -----------------------------------------------------------------------------
 * SpeechDetector – Voice Activity / Speech Onset detection for real‑time agents
 * -----------------------------------------------------------------------------
 *
 * Purpose  : Detect reliably when a caller starts speaking so that an AI voice
 *            agent can interrupt its own TTS output and listen.
 *
 * Streams  : Default input is 8 kHz µ‑law mono (Twilio media streams) but the
 *            detector accepts any sample‑rate and either µ‑law or 16‑bit PCM.
 *
 * Strategy :   1. Convert raw bytes → float32 samples in −1…1.
 *              2. Apply pre‑emphasis & Hann window to reduce spectral leakage.
 *              3. Compute three activity features per 20 ms frame:
 *                   • Speech‑band energy ratio           (300 – 3400 Hz)
 *                   • Spectral flux                      (frame‑to‑frame change)
 *                   • Zero‑crossing rate
 *              4. Fuse features into a single score.
 *              5. Compare the score against an **adaptive noise floor** (rolling
 *                 median) plus hysteresis to decide speech start / end.
 *
 * Why these choices?
 *   • Pre‑emphasis is a high-pass filter that boosts frequencies above ~800 Hz,
 *     enhancing speech formants and mitigating microphone low-frequency roll-off.
 *   • Hann window reduces spectral leakage so narrow‑band tones don't bleed.
 *   • Rolling median acts like an AGC: it continuously learns background noise
 *     without reacting to brief outliers
 *   • Hysteresis (ENTER/EXIT) prevents jitter around the threshold; we only
 *     flip state after a real change, avoiding micro‑cuts in low SNR cases.
 *   • The secondary features (flux & ZCR) rescue edge‑cases: whispers have low
 *     absolute energy but high spectral change; keyboard clicks have high ZCR
 *     but low band‑ratio, etc.
 *
 * Tweakables are grouped at the top so the detector can be tuned easily for
 * different microphones, codecs, or desired sensitivities.
 * --------------------------------------------------------------------------- */
import * as KissFFT from "kissfft-js"

const DEBUG_SPEECH = false

const debugLog = (msg: string, data?: Record<string, unknown>) => {
  if (DEBUG_SPEECH) {
    const timestamp = new Date().toISOString()
    console.log(`[SpeechDetector ${timestamp}] ${msg}`, data || "")
  }
}

/* ---------- Algorithm parameters ------------------------------------------------
   FRAME_MS   : Analysis chunk length (20 ms is standard in telephony VAD)
   PRE_EMPH   : α for first‑order pre‑emphasis: y[n] = x[n] – α·x[n−1]
   MEDIAN_WIN : Number of frames (~1 s) kept for rolling‑median noise floor
   ENTER/EXIT : Hysteresis thresholds above floor for speech start/stop
--------------------------------------------------------------------------------- */
const FRAME_MS = 20
const PRE_EMPH = 0.9
const MEDIAN_WIN = 50 // 50 × 20 ms = 1000 ms
const ENTER_HYST = 0.15
const EXIT_HYST = 0.05
const ONSET_FRAMES = 3
const MIN_ENERGY_THRESHOLD = 1e-4 // minimum energy to consider valid speech

/* ---------- µ‑law decoding ------------------------------------------------------
   Twilio sends 8‑bit ITU‑T G.711 µ‑law samples.  The following converts each
   byte to 16‑bit PCM, then to float32 (−1 … 1).  We inline it to avoid heavy
   deps like "mulaw" packages.  Constants per spec.                          */

type Encoding = "mulaw" | "pcm16"
const MU_BIAS = 0x84 // 132 decimal

const muLawDecodeSample = (uLaw: number): number => {
  uLaw = ~uLaw & 0xff // bit‑invert per standard
  const sign = uLaw & 0x80 ? -1 : 1
  let mag = (uLaw & 0x0f) << 3
  mag += MU_BIAS
  mag <<= (uLaw & 0x70) >> 4
  return sign * (mag - MU_BIAS)
}

/* pcmToFloat – convert Buffer → float[] according to encoding --------------- */
const pcmToFloat = (b: Buffer, enc: Encoding): number[] => {
  if (enc === "mulaw") return Array.from(b, (v) => muLawDecodeSample(v) / 32768)
  /* pcm16le */
  const out: number[] = []
  for (let i = 0; i < b.length - 1; i += 2) out.push(b.readInt16LE(i) / 32768)
  return out
}

/* Signal conditioning helpers --------------------------------------------------- */

// Pre‑emphasis accentuates HF content; improves SNR for speech‑band features.
const preEmphasis = (s: number[], a: number) => {
  for (let i = s.length - 1; i > 0; --i) s[i]! -= a * s[i - 1]!
}

// Hann window minimises FFT sidelobes, reducing energy leak across bands.
const applyHann = (s: number[]) => {
  const N = s.length
  for (let n = 0; n < N; ++n) s[n]! *= 0.5 * (1 - Math.cos((2 * Math.PI * n) / (N - 1)))
}

/* Rolling median helpers – a cheap noise‑floor estimator ----------------------- */
const median = (arr: number[]): number => {
  const sorted = [...arr].sort((a, b) => a - b)
  const mid = sorted.length >> 1
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2
}

const updateMedian = (buf: number[], v: number, max: number) => {
  buf.push(v)
  if (buf.length > max) buf.shift()
}

/* Utility: round up to next power‑of‑two so Radix‑2 FFT is fast & cache‑friendly */
const nextPow2 = (x: number) => 1 << (32 - Math.clz32(x - 1))

/* ---------- Public API types --------------------------------------------------- */
export interface SpeechDetectionState {
  talking: boolean // current VAD state
  medianBuf: number[] // rolling history of frame scores
  prevMag: number[] | null // spectrum from previous frame (for flux)
  consec: number
}

export interface SpeechDetectorOpts {
  sampleRate?: number // e.g. 8000, 16000 …
  encoding?: Encoding // "mulaw" | "pcm16"
  medianWindowFrames?: number // frames for rolling median (default: 150)
}

/* -----------------------------------------------------------------------------
 * SpeechDetector – the class you instantiate per media stream
 * --------------------------------------------------------------------------- */
export class SpeechDetector {
  private readonly sr: number
  private readonly enc: Encoding
  private readonly frameLen: number // samples per analysis frame
  private readonly medianWin: number // frames for rolling median
  private readonly fftr: KissFFT.FFTR // FFT transformer, reused for all frames
  private readonly fftSize: number // pre-calculated FFT size
  private st: SpeechDetectionState

  constructor({
    sampleRate = 8000,
    encoding = "mulaw",
    medianWindowFrames = MEDIAN_WIN,
  }: SpeechDetectorOpts = {}) {
    this.sr = sampleRate
    this.enc = encoding
    this.frameLen = Math.round((this.sr * FRAME_MS) / 1000)
    this.medianWin = medianWindowFrames

    // Pre-calculate FFT size and create transformer once
    this.fftSize = nextPow2(this.frameLen)
    this.fftr = new KissFFT.FFTR(this.fftSize)

    /* state init */
    this.st = { talking: false, medianBuf: [], prevMag: null, consec: 0 }
  }

  /** Resets internal state (useful when a new call starts on same instance) */
  reset() {
    this.st = { talking: false, medianBuf: [], prevMag: null, consec: 0 }
  }

  /**
   * detectSpeechOnset – call once per received raw‑audio chunk.
   *   @param buf – Buffer holding either µ‑law bytes or 16‑bit PCM‑LE.
   *   @returns    – true exactly on the first frame where speech starts; false otherwise.
   *
   * Implementation notes:
   *   • Only first frameLen samples are used: extra data is ignored so the caller
   *     may pass larger packets without splitting.
   *   • For µ‑law, each byte is one sample; for PCM‑16 we multiply by two.
   */
  detectSpeechOnset(buf: Buffer): boolean {
    const bytesPerSample = this.enc === "mulaw" ? 1 : 2
    if (buf.length < this.frameLen * bytesPerSample) return false // insufficient data

    const rawFrame = buf.subarray(0, this.frameLen * bytesPerSample)
    const samples = pcmToFloat(rawFrame, this.enc)

    preEmphasis(samples, PRE_EMPH) // lift HF
    applyHann(samples) // taper edges

    /* ---- Feature extraction ------------------------------------------------- */
    const score = this.frameScore(samples)

    /* ---- Adaptive thresholding via rolling median + hysteresis ------------- */
    // Only include frames with actual audio content in noise floor calculation
    // Zero-energy frames represent silence/dropout, not background noise
    if (score > 0) {
      updateMedian(this.st.medianBuf, score, this.medianWin)
    }

    debugLog(`Median buffer update:`, {
      newScore: score.toFixed(4),
      bufferLength: this.st.medianBuf.length,
      recentValues: this.st.medianBuf.slice(-5).map((v) => v.toFixed(4)),
      scoreAdded: score > 0,
      zeroCount: this.st.medianBuf.filter((v) => v === 0).length,
    })

    // Don't detect speech until we have enough non-zero samples for a stable noise floor
    // Use a smaller threshold since we're only counting frames with actual audio content
    const minSamples = Math.min(this.medianWin, 20) // Need at least 20 non-zero samples
    if (this.st.medianBuf.length < minSamples) {
      debugLog(
        `Insufficient non-zero samples for noise floor: ${this.st.medianBuf.length}/${minSamples}`
      )
      return false
    }

    const floor = median(this.st.medianBuf) // current noise floor reference
    const norm = score - floor // how far above background?

    debugLog(`Frame analysis:`, {
      score: score.toFixed(4),
      floor: floor.toFixed(4),
      norm: norm.toFixed(4),
      talking: this.st.talking,
      consec: this.st.consec,
      bufferSize: this.st.medianBuf.length,
      medianRange: {
        min: Math.min(...this.st.medianBuf).toFixed(4),
        max: Math.max(...this.st.medianBuf).toFixed(4),
      },
    })

    if (!this.st.talking) {
      if (norm > ENTER_HYST) {
        this.st.consec++
        debugLog(
          `Speech candidate detected: consec=${this.st.consec}/${ONSET_FRAMES}, norm=${norm.toFixed(4)} > ${ENTER_HYST}`
        )
      } else {
        if (this.st.consec > 0) {
          debugLog(`Speech candidate reset: norm=${norm.toFixed(4)} <= ${ENTER_HYST}`)
        }
        this.st.consec = 0
      }
    }

    const entered = !this.st.talking && this.st.consec >= ONSET_FRAMES
    const exited = this.st.talking && norm < EXIT_HYST

    if (entered) {
      this.st.talking = true
      debugLog(`🎙️  SPEECH STARTED: norm=${norm.toFixed(4)}, consec=${this.st.consec}`)
    }
    if (exited) {
      this.st.talking = false
      this.st.consec = 0
      debugLog(`🔇 SPEECH STOPPED: norm=${norm.toFixed(4)} < ${EXIT_HYST}`)
    }

    return entered
  }

  /* ------------------------------------------------------------------------- */
  /**
   * frameScore – combine three instantaneous features into a single scalar.
   *              Returns a non‑normalised score (higher ⇒ more speech‑like).
   */
  private frameScore(samples: number[]): number {
    // Pad samples to FFT size if needed
    const padded =
      samples.length === this.fftSize
        ? samples
        : [...samples, ...new Array(this.fftSize - samples.length).fill(0)]

    // Reuse the pre-created FFT transformer
    const complex = this.fftr.forward(new Float32Array(padded))

    // Convert interleaved complex data to magnitudes
    const mags: number[] = []
    for (let i = 0; i < complex.length; i += 2) {
      const real = complex[i]!
      const imag = complex[i + 1]!
      mags.push(Math.sqrt(real * real + imag * imag))
    }

    // Generate frequency bins manually
    const freqs: number[] = []
    for (let i = 0; i < mags.length; i++) {
      freqs.push((i * this.sr) / (2 * mags.length))
    }

    /* --- Feature 1: Speech‑band energy ratio -------------------------------- */
    let speechE = 0,
      totalE = 0,
      weightedSpeechE = 0

    for (let i = 0; i < mags.length; ++i) {
      const f = freqs[i]
      const e2 = mags[i]! ** 2 // power = mag²
      totalE += e2
      if (f && f >= 300 && f <= 3400) {
        speechE += e2 // unweighted speech energy
        /* overweight 1–2 kHz (formants) to sharpen contrast */
        const weight = f >= 1000 && f <= 2000 ? 1.5 : 1
        weightedSpeechE += e2 * weight
      }
    }
    // Use weighted speech energy but normalize properly to keep ratio <= 1.0
    const bandRatio = totalE ? Math.min(1.0, weightedSpeechE / totalE) : 0

    /* --- Feature 2: Spectral flux ------------------------------------------ */
    let flux = 0
    if (this.st.prevMag) {
      for (let i = 0; i < mags.length; ++i) {
        const diff = mags[i]! - this.st.prevMag[i]!
        if (diff > 0) flux += diff // only positive changes (onset‑sensitive)
      }
    }
    this.st.prevMag = mags // save for next frame
    const normFlux = flux / (flux + 1) // squashing keeps value in 0…1

    /* --- Feature 3: Zero‑crossing rate ------------------------------------- */
    let zc = 0
    for (let i = 1; i < samples.length; ++i)
      if (Math.sign(samples[i]!) !== Math.sign(samples[i - 1]!)) zc++
    const zcr = zc / samples.length // normalise 0…1

    /* --- Linear fusion (weights tuned empirically on call centre corpora) --- */
    const score = 0.6 * bandRatio + 0.3 * normFlux + 0.1 * zcr

    // Reject frames with very low energy (likely silence or very weak noise)
    const finalScore = totalE < MIN_ENERGY_THRESHOLD ? 0 : score

    if (finalScore === 0) {
      debugLog(`❌ ZERO SCORE:`, {
        rawScore: score.toFixed(4),
        totalE: totalE.toFixed(6),
        energyThreshold: MIN_ENERGY_THRESHOLD,
        reason: totalE < MIN_ENERGY_THRESHOLD ? "energy_too_low" : "raw_score_zero",
      })
    }

    debugLog(`Features:`, {
      bandRatio: bandRatio.toFixed(4),
      normFlux: normFlux.toFixed(4),
      zcr: zcr.toFixed(4),
      rawScore: score.toFixed(4),
      finalScore: finalScore.toFixed(4),
      speechE: speechE.toFixed(6),
      totalE: totalE.toFixed(6),
      energyThreshold: MIN_ENERGY_THRESHOLD,
      energyThresholdMet: totalE >= MIN_ENERGY_THRESHOLD,
    })

    return finalScore
  }
}
