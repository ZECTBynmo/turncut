# TurnCut 🎙️

A real-time speech interruption detection library designed specifically for LLM voice agents and phone call applications. TurnCut enables AI assistants to detect when a caller starts speaking so they can immediately stop their own text-to-speech output and listen.

## 🎯 Purpose

In conversational AI systems, especially phone-based voice agents, natural conversation requires the ability to detect when a human user begins speaking during the AI's response. This "barge-in" or interruption detection is crucial for:

- **Natural conversation flow**: Users expect to be able to interrupt the AI just like they would interrupt a human
- **Reduced latency**: Immediate response to user speech instead of waiting for AI to finish speaking
- **Better user experience**: Prevents the AI from talking over the user
- **Efficient bandwidth usage**: Stops unnecessary TTS audio transmission

## 🚀 Features

- **Real-time detection**: Optimized for 20ms audio frames (telephony standard)
- **Twilio-ready**: Native support for 8kHz μ-law encoded audio streams
- **Adaptive noise floor**: Automatically adjusts to background noise using rolling median
- **Multi-feature fusion**: Combines speech-band energy, spectral flux, and zero-crossing rate
- **Hysteresis thresholding**: Prevents false positives from brief noise spikes
- **Low CPU overhead**: Efficient FFT-based processing with minimal memory allocation
- **Configurable**: Tunable parameters for different environments and sensitivity requirements

## 📦 Installation

```bash
# Using Bun (recommended)
bun add turncut

# Using npm
npm install turncut

# Using yarn
yarn add turncut
```

## 🏗️ Quick Start

### Basic Usage with Twilio Media Streams

```typescript
import { SpeechDetector } from 'turncut'

// Initialize detector for Twilio's default format (8kHz μ-law)
const detector = new SpeechDetector({
  sampleRate: 8000,
  encoding: 'mulaw'
})

// Handle incoming audio chunks from Twilio
ws.on('message', (data) => {
  const message = JSON.parse(data)
  
  if (message.event === 'media') {
    // Decode base64 audio data
    const audioBuffer = Buffer.from(message.media.payload, 'base64')
    
    // Detect speech onset
    const speechStarted = detector.detectSpeechOnset(audioBuffer)
    
    if (speechStarted) {
      console.log('🎙️ User started speaking - stopping TTS')
      // Stop your TTS output here
      stopTextToSpeech()
      // Optionally clear audio output buffer
      clearAudioBuffer()
    }
  }
})
```

### Advanced Configuration

```typescript
import { SpeechDetector } from 'turncut'

const detector = new SpeechDetector({
  sampleRate: 16000,        // Higher quality audio
  encoding: 'pcm16',        // 16-bit PCM instead of μ-law
  medianWindowFrames: 75    // 1.5 second noise floor window
})

// Reset detector state for new calls
detector.reset()

// Process audio in a loop
while (audioStream.isActive) {
  const audioChunk = await audioStream.read()
  const interrupted = detector.detectSpeechOnset(audioChunk)
  
  if (interrupted) {
    await handleUserInterruption()
  }
}
```

## 🔧 API Reference

### `SpeechDetector`

The main class for speech detection.

#### Constructor Options

```typescript
interface SpeechDetectorOpts {
  sampleRate?: number        // Audio sample rate (default: 8000)
  encoding?: 'mulaw' | 'pcm16'  // Audio encoding (default: 'mulaw')
  medianWindowFrames?: number   // Frames for noise floor calculation (default: 50)
}
```

#### Methods

##### `detectSpeechOnset(buffer: Buffer): boolean`

Processes an audio chunk and returns `true` exactly when speech begins.

- **Parameters**:
  - `buffer`: Raw audio data (μ-law bytes or 16-bit PCM-LE)
- **Returns**: `true` on speech onset, `false` otherwise
- **Notes**: 
  - Only processes the first frame worth of data
  - Requires at least 20ms of audio data
  - Returns `true` only once per speech segment

##### `reset(): void`

Resets the detector's internal state. Use this when starting a new call or conversation.

### Audio Format Support

| Format | Sample Rate | Encoding | Use Case |
|--------|-------------|----------|----------|
| Twilio Default | 8kHz | μ-law | Phone calls via Twilio |
| High Quality | 16kHz | PCM-16 | Local/high-quality audio |
| Custom | Any | μ-law/PCM-16 | Custom telephony systems |

## 🧠 How It Works

TurnCut uses a sophisticated multi-feature approach to detect speech onset:

### 1. Signal Preprocessing
- **Pre-emphasis**: Boosts high-frequency content (1-4kHz) where speech intelligibility lives
- **Windowing**: Applies Hann window to reduce spectral leakage
- **FFT**: Converts time-domain signal to frequency domain for analysis

### 2. Feature Extraction
- **Speech-band Energy Ratio**: Measures energy in 300-3400Hz range vs. total energy
- **Spectral Flux**: Detects frame-to-frame changes in spectrum (onset-sensitive)
- **Zero-crossing Rate**: Captures high-frequency activity patterns

### 3. Adaptive Thresholding
- **Rolling Median**: Continuously estimates background noise floor
- **Hysteresis**: Uses separate thresholds for speech start/stop to prevent jitter
- **Onset Confirmation**: Requires multiple consecutive frames before triggering

### 4. Decision Logic
```
Speech Score = 0.6 × Band Ratio + 0.3 × Spectral Flux + 0.1 × ZCR
Speech Detected = Score > (Noise Floor + Hysteresis Threshold)
```

## 📊 Performance Characteristics

- **Latency**: 20-60ms (1-3 frames) detection delay
- **CPU Usage**: ~1-2% on modern hardware for 8kHz audio
- **Memory**: <1MB working set per detector instance (with default window size)

## 🛠️ Integration Examples

### Express.js + WebSocket Server

```typescript
import express from 'express'
import WebSocket from 'ws'
import { SpeechDetector } from 'turncut'

const app = express()
const wss = new WebSocket.Server({ port: 8080 })

wss.on('connection', (ws) => {
  const detector = new SpeechDetector()
  
  ws.on('message', (data) => {
    const audioBuffer = Buffer.from(data)
    const speechStarted = detector.detectSpeechOnset(audioBuffer)
    
    if (speechStarted) {
      ws.send(JSON.stringify({ 
        event: 'speech_detected',
        timestamp: Date.now()
      }))
    }
  })
})
```

### Node.js Twilio Function

```typescript
import { SpeechDetector } from 'turncut'

const detector = new SpeechDetector({
  sampleRate: 8000,
  encoding: 'mulaw'
})

export const handler = (context, event, callback) => {
  const audioData = Buffer.from(event.media.payload, 'base64')
  
  if (detector.detectSpeechOnset(audioData)) {
    // Interrupt current TTS
    return callback(null, {
      event: 'interrupt',
      streamSid: event.streamSid
    })
  }
  
  callback(null, { event: 'continue' })
}
```

## 🔍 Troubleshooting

### Common Issues

**No speech detected despite audio input**
- Verify audio format matches detector configuration
- Check if audio volume is sufficient (>40dB SNR)
- Ensure audio chunks are at least 20ms worth of data

**Too many false positives**
- Increase `medianWindowFrames` for longer noise floor averaging
- Add additional pre-filtering for known noise sources
- Consider adjusting hysteresis thresholds

### Debug Mode

Enable debug logging to see internal detector state:

```typescript
process.env.DEBUG_SPEECH = true
```

## 📄 License

This project is licensed under the MIT License

Built with ❤️ by Mike Vegeto
