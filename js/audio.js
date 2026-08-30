// js/audio.js - Batch-Analyzed FSK Acoustic Modem (no real-time polling)

const AudioPipeline = {
    audioCtx: null,
    micStream: null,
    processorNode: null,
    isListening: false,
    recordedChunks: [],
    _recordTimeout: null,

    // ----------------------------------------------------
    // LOW-BAND FSK ALLOCATION (8-12kHz)
    // ----------------------------------------------------
    START_FREQ: 8000,
    LANE_FREQS: [8300, 9500, 10700, 11700],
    END_FREQ:   12000,

    BAUD_RATE: 45,
    GUARD_GAP: 55,

    // Raw Goertzel magnitude threshold. This is NOT the same scale as
    // AnalyserNode's 0-255 output. Watch the console logs on your first
    // test run and adjust this to sit clearly above your noise floor
    // and clearly below your tone peaks.
    THRESHOLD: 15,
    LANE_FLOOR: 3,
    LANE_THRESHOLDS: [0.08, 0.08, 0.08, 0.08],
    PREAMBLE_GAP_SEC: 0.45,
    SYMBOL_ANALYSIS_MS: 25,   // narrower window than BAUD_RATE, avoids the 5ms fade-in/out ramps
    SYMBOL_OFFSET_MS: 10,      // skip past the fade-in before sampling

    RECORD_DURATION_MS: 12000, // max listening window before auto-analyzing

    init: function() {
        if (!this.audioCtx) {
            this.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
            console.log(`[Audio] Context initialized at ${this.audioCtx.sampleRate} Hz`);
        }
    },

    // ==========================================
    // 1. TRANSMITTER ENGINE
    // ==========================================
    playTone: function(frequency, durationMs) {
        if (!this.audioCtx) return;

        const now = this.audioCtx.currentTime;
        const durationSec = durationMs / 1000;
        const masterGain = this.audioCtx.createGain();
        const peakVolume = 0.9;

        masterGain.gain.setValueAtTime(0, now);
        masterGain.gain.linearRampToValueAtTime(peakVolume, now + 0.005);
        masterGain.gain.setValueAtTime(peakVolume, now + durationSec - 0.005);
        masterGain.gain.linearRampToValueAtTime(0, now + durationSec);
        masterGain.connect(this.audioCtx.destination);

        const osc = this.audioCtx.createOscillator();
        osc.type = 'sine';
        osc.frequency.value = frequency;
        osc.connect(masterGain);
        osc.start(now);
        osc.stop(now + durationSec);
    },

    transmitPayload: async function(payloadBytes) {
    if (!this.audioCtx) this.init();

    const length = payloadBytes.length;
    const lengthHigh = (length >> 8) & 0xFF;
    const lengthLow  = length & 0xFF;
    let checksum = 0;
    for (let i = 0; i < payloadBytes.length; i++) checksum ^= payloadBytes[i];

    const packet = new Uint8Array(payloadBytes.length + 3);
    packet[0] = lengthHigh;
    packet[1] = lengthLow;
    packet.set(payloadBytes, 2);
    packet[packet.length - 1] = checksum;

    console.log(`[TX] Packet created: length=${length}B, checksum=0x${checksum.toString(16).toUpperCase()}`);

    const frameInterval = (this.BAUD_RATE + this.GUARD_GAP) / 1000; // seconds
    const baudSec = this.BAUD_RATE / 1000;
    let t = this.audioCtx.currentTime + 0.1; // small safety lead-in

    // Preamble
    this.scheduleTone(this.START_FREQ, t, 0.3);
    t += this.PREAMBLE_GAP_SEC;

    // Payload — 4 bits (one nibble) per symbol, scheduled from a single
    // fixed origin so no per-symbol timing error can accumulate.
    for (let i = 0; i < packet.length; i++) {
        const byte = packet[i];
        for (let nibbleIdx = 1; nibbleIdx >= 0; nibbleIdx--) {
            const nibble = (byte >> (nibbleIdx * 4)) & 0x0F;
            const activeFreqs = [];
            for (let bit = 0; bit < 4; bit++) {
                if ((nibble >> bit) & 1) activeFreqs.push(this.LANE_FREQS[bit]);
            }

            console.log(
            `[TX SYMBOL] byte=${i} nibble=${nibble.toString(2).padStart(4, '0')} ` + `freqs=${activeFreqs.join(',') || 'NONE'}`
            );
            this.scheduleTones(activeFreqs, t, baudSec);
            t += frameInterval;
        }
    }

    // End marker
    t += 0.1;
    this.scheduleTone(this.END_FREQ, t, 0.3);
    const totalDurationMs = (t + 0.3 - this.audioCtx.currentTime) * 1000;

    console.log(`[TX] All ${packet.length} bytes scheduled on audio clock. Total duration ~${(totalDurationMs/1000).toFixed(2)}s`);
    await this.sleep(totalDurationMs); // just for the UI/button state, not for pacing
    console.log("[TX] Transmission complete.");
},

// Same as playTone but takes an explicit start time instead of "now"
scheduleTone: function(frequency, startTime, durationSec) {
    const masterGain = this.audioCtx.createGain();
    const peakVolume = 0.9;

    masterGain.gain.setValueAtTime(0, startTime);
    masterGain.gain.linearRampToValueAtTime(peakVolume, startTime + 0.005);
    masterGain.gain.setValueAtTime(peakVolume, startTime + durationSec - 0.005);
    masterGain.gain.linearRampToValueAtTime(0, startTime + durationSec);
    masterGain.connect(this.audioCtx.destination);

    const osc = this.audioCtx.createOscillator();
    osc.type = 'sine';
    osc.frequency.value = frequency;
    osc.connect(masterGain);
    osc.start(startTime);
    osc.stop(startTime + durationSec);
},

// Schedules MULTIPLE simultaneous tones (one symbol = one nibble = up to 4 tones)
scheduleTones: function(frequencies, startTime, durationSec) {
    if (!frequencies.length) return;
    const masterGain = this.audioCtx.createGain();
    const peakVolume = 0.22 // prevent clipping when several tones overlap

    masterGain.gain.setValueAtTime(0, startTime);
    masterGain.gain.linearRampToValueAtTime(peakVolume, startTime + 0.005);
    masterGain.gain.setValueAtTime(peakVolume, startTime + durationSec - 0.005);
    masterGain.gain.linearRampToValueAtTime(0, startTime + durationSec);
    masterGain.connect(this.audioCtx.destination);

    frequencies.forEach(freq => {
        const osc = this.audioCtx.createOscillator();
        osc.type = 'sine';
        osc.frequency.value = freq;
        osc.connect(masterGain);
        osc.start(startTime);
        osc.stop(startTime + durationSec);
    });
},

    // ==========================================
    // 2. RECEIVER: COLLECTION PHASE (no analysis)
    // ==========================================
    startReceiver: async function(onDataComplete) {
        if (!this.audioCtx) this.init();
        if (this.isListening) return;

        try {
            this.micStream = await navigator.mediaDevices.getUserMedia({
                audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
                video: false
            });

            const source = this.audioCtx.createMediaStreamSource(this.micStream);
            this.processorNode = this.audioCtx.createScriptProcessor(4096, 1, 1);
            this.recordedChunks = [];

            this.processorNode.onaudioprocess = (e) => {
                const input = e.inputBuffer.getChannelData(0);
                this.recordedChunks.push(new Float32Array(input)); // copy, buffer gets reused
            };

            // Must connect to destination (through silent gain) for onaudioprocess to fire
            const silentGain = this.audioCtx.createGain();
            silentGain.gain.value = 0;
            source.connect(this.processorNode);
            this.processorNode.connect(silentGain);
            silentGain.connect(this.audioCtx.destination);

            this.isListening = true;
            console.log(`%c[RX] Recording raw audio. Auto-analyzing in ${this.RECORD_DURATION_MS}ms.`, "color:#7ed321;font-weight:bold;");

            this._recordTimeout = setTimeout(() => {
                this.stopReceiver();
                this.analyzeRecording(onDataComplete);
            }, this.RECORD_DURATION_MS);

        } catch (err) {
            console.error("[RX] Mic access denied:", err);
        }
    },

    stopReceiver: function() {
        this.isListening = false;
        if (this._recordTimeout) { clearTimeout(this._recordTimeout); this._recordTimeout = null; }
        if (this.processorNode) {
            this.processorNode.disconnect();
            this.processorNode.onaudioprocess = null;
            this.processorNode = null;
        }
        if (this.micStream) {
            this.micStream.getTracks().forEach(track => track.stop());
            this.micStream = null;
        }
    },

    // ==========================================
    // 3. RECEIVER: OFFLINE ANALYSIS PHASE
    // ==========================================
    concatenateChunks: function(chunks) {
        let total = 0;
        for (const c of chunks) total += c.length;
        const result = new Float32Array(total);
        let offset = 0;
        for (const c of chunks) { result.set(c, offset); offset += c.length; }
        return result;
    },

    // Goertzel algorithm: magnitude of a single target frequency over a
    // fixed sample window. This is what replaces getByteFrequencyData() -
    // it can be computed at ANY sample offset after the fact.
    goertzelMagnitude: function(samples, startIdx, numSamples, targetFreq, sampleRate) {
        const omega = (2 * Math.PI * targetFreq) / sampleRate;
        const cosine = Math.cos(omega);
        const coeff = 2 * cosine;

        let q0 = 0, q1 = 0, q2 = 0;
        for (let i = 0; i < numSamples; i++) {
            const sample = samples[startIdx + i] || 0;
            q0 = coeff * q1 - q2 + sample;
            q2 = q1;
            q1 = q0;
        }
        const real = q1 - q2 * cosine;
        const imag = q2 * Math.sin(omega);
        return Math.sqrt(real * real + imag * imag);
    },
    // Same as goertzelMagnitude but applies a Hann window first, which
    // suppresses spectral leakage into neighboring frequency bins.
    // Use this specifically for closely-spaced parallel data lanes.
    goertzelMagnitudeWindowed: function(samples, startIdx, numSamples, targetFreq, sampleRate) {
        const omega = (2 * Math.PI * targetFreq) / sampleRate;
        const cosine = Math.cos(omega);
        const coeff = 2 * cosine;

        let q0 = 0, q1 = 0, q2 = 0;
        for (let i = 0; i < numSamples; i++) {
            const w = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (numSamples - 1)); // Hann taper
            const sample = (samples[startIdx + i] || 0) * w;
            q0 = coeff * q1 - q2 + sample;
            q2 = q1;
            q1 = q0;
        }
        const real = q1 - q2 * cosine;
        const imag = q2 * Math.sin(omega);
        return Math.sqrt(real * real + imag * imag);
    },

    analyzeRecording: function(onDataComplete) {
        const sampleRate = this.audioCtx.sampleRate;
        const samples = this.concatenateChunks(this.recordedChunks);
        console.log(`%c[Analysis] Captured ${samples.length} samples (${(samples.length / sampleRate).toFixed(2)}s @ ${sampleRate}Hz). Decoding offline...`, "color:#3b82f6;font-weight:bold;");

        const windowSamples = Math.round(sampleRate * this.BAUD_RATE / 1000);
        const scanStepSamples = Math.round(sampleRate * 0.002); // 2ms scan resolution
        const mag = (freq, idx) => this.goertzelMagnitude(samples, idx, windowSamples, freq, sampleRate);

        // --- Locate preamble onset ---
        let preambleStart = -1;
        for (let idx = 0; idx + windowSamples < samples.length; idx += scanStepSamples) {
            const m = mag(this.START_FREQ, idx);
            console.log(`[Scan] t=${(idx / sampleRate).toFixed(3)}s START(${this.START_FREQ}Hz) mag=${m.toFixed(2)}`);
            if (m > this.THRESHOLD) { preambleStart = idx; break; }
        }
        if (preambleStart === -1) {
            console.error("[RX] No preamble detected in recording.");
            if (onDataComplete) onDataComplete(null);
            return;
        }
        console.log(`%c[RX 1/3] Preamble located at t=${(preambleStart / sampleRate).toFixed(3)}s`, "color:#f59e0b;font-weight:bold;");

        // --- Locate preamble end ---
        let idx = preambleStart;
        while (idx + windowSamples < samples.length && mag(this.START_FREQ, idx) > this.THRESHOLD) {
            idx += scanStepSamples;
        }
        const preambleEnd = idx;
        console.log(`%c[RX 2/3] Preamble ends at t=${(preambleEnd / sampleRate).toFixed(3)}s`, "color:#eab308;font-weight:bold;");

        // --- Lock clock: skip transmitter's fixed 350ms gap ---
        // TX: 300ms preamble followed by fixed 450ms offset to first payload symbol.
        const gapSamples = Math.round(sampleRate * this.PREAMBLE_GAP_SEC);
        let cursor = preambleStart + gapSamples;
        const frameIntervalSamples = Math.round(sampleRate * (this.BAUD_RATE + this.GUARD_GAP) / 1000);

        console.log(`%c[RX 3/3] CLOCK LOCKED at t=${(cursor / sampleRate).toFixed(3)}s. Decoding payload...`, "color:#3b82f6;font-weight:bold;");

        // --- Decode bits at fixed sample-accurate offsets ---
        const receivedBits = [];
        let currentByteBits = [];
        let expectedLength = Infinity;
        let byteCount = 0;

        const symbolWindowSamples = Math.round(sampleRate * this.SYMBOL_ANALYSIS_MS / 1000);
        const symbolOffsetSamples = Math.round(sampleRate * this.SYMBOL_OFFSET_MS / 1000);
        const symbolMag = (freq, idx) => this.goertzelMagnitudeWindowed(samples, idx + symbolOffsetSamples, symbolWindowSamples, freq, sampleRate);

        while (cursor + windowSamples < samples.length) {
            const laneMags = this.LANE_FREQS.map(f => symbolMag(f, cursor));
            const mEnd = symbolMag(this.END_FREQ, cursor);
            console.log(`[Symbol] t=${(cursor / sampleRate).toFixed(3)}s lanes=[${laneMags.map(m => m.toFixed(2)).join(', ')}] END=${mEnd.toFixed(2)}`);

            if (mEnd > this.THRESHOLD && mEnd > Math.max(...laneMags) && receivedBits.length >= 24) {
                console.log("[RX] End marker detected. Stopping decode.");
                break;
            }

            // Independent threshold per lane.
            // Do NOT compare lanes against the strongest lane.
            // A 0000 symbol is valid and contains only noise.
            const laneThresholds = this.LANE_THRESHOLDS || [8, 8, 8, 8];

            const nibbleBits = laneMags.map((m, i) => {
                return m >= laneThresholds[i] ? 1 : 0;
            });

            // Push MSB -> LSB (Lane 3 -> Lane 0), same order transmitter used
            receivedBits.push(nibbleBits[3], nibbleBits[2], nibbleBits[1], nibbleBits[0]);
            currentByteBits.push(nibbleBits[3], nibbleBits[2], nibbleBits[1], nibbleBits[0]);

            if (currentByteBits.length === 8) {
                const byteVal = parseInt(currentByteBits.join(''), 2);
                byteCount++;
                console.log(`[RX] Byte ${byteCount}: 0x${byteVal.toString(16).padStart(2, '0').toUpperCase()} (${currentByteBits.join('')})`);
                currentByteBits = [];

                if (receivedBits.length === 16) {
                    const headerBytes = this.reconstructBytesFromBits(receivedBits);
                    expectedLength = (headerBytes[0] << 8) | headerBytes[1];
                    console.log(`[RX] Header parsed: expecting ${expectedLength} payload bytes.`);
                }
            }

            const totalExpectedBits = (2 + expectedLength + 1) * 8;
            if (expectedLength !== Infinity && receivedBits.length >= totalExpectedBits) break;

            cursor += frameIntervalSamples;
        }

        this.finishReception(receivedBits, onDataComplete);
    },

    finishReception: function(receivedBits, onDataComplete) {
        const rawBytes = this.reconstructBytesFromBits(receivedBits);

        if (rawBytes.length < 3) {
            console.error("[RX] Packet too short to contain header+checksum.");
            if (onDataComplete) onDataComplete(null);
            return;
        }

        const expectedLength = (rawBytes[0] << 8) | rawBytes[1];
        const payload = rawBytes.slice(2, 2 + expectedLength);
        const receivedChecksum = rawBytes[2 + expectedLength];

        let computedChecksum = 0;
        for (let i = 0; i < payload.length; i++) computedChecksum ^= payload[i];

        if (computedChecksum !== receivedChecksum) {
            console.error(`%c[RX] CHECKSUM MISMATCH! Expected 0x${receivedChecksum?.toString(16)}, got 0x${computedChecksum.toString(16)}.`, "color:red;font-weight:bold;");
            if (onDataComplete) onDataComplete(null);
            return;
        }

        console.log("%c[RX] SUCCESS! Checksum verified. Payload:", "color:#7ed321;font-weight:bold;font-size:14px;", payload);
        if (onDataComplete) onDataComplete(payload);
    },

    reconstructBytesFromBits: function(bits) {
        const bytes = [];
        for (let i = 0; i < bits.length; i += 8) {
            if (i + 8 <= bits.length) {
                let byte = 0;
                for (let b = 0; b < 8; b++) byte = (byte << 1) | bits[i + b];
                bytes.push(byte);
            }
        }
        return new Uint8Array(bytes);
    },

    sleep: function(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    },

    transmitTestByte: async function() {
        if (!this.audioCtx) this.init();
        const testPayload = new Uint8Array([0x11,0x22,0x44,0x88]);
        console.log("%c[TX] Sending FSK test packet...", "color:#f59e0b;font-weight:bold;");
        await this.transmitPayload(testPayload);
    }
};