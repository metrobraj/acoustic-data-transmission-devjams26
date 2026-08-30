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
    FREQ_0:     9000,
    FREQ_1:     10000,
    END_FREQ:   11500,

    BAUD_RATE: 45,
    GUARD_GAP: 35,

    // Raw Goertzel magnitude threshold. This is NOT the same scale as
    // AnalyserNode's 0-255 output. Watch the console logs on your first
    // test run and adjust this to sit clearly above your noise floor
    // and clearly below your tone peaks.
    THRESHOLD: 15,

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

        // --- PACKET ASSEMBLY: [len_hi][len_lo][...payloadBytes...][checksum] ---
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

        // 1. PREAMBLE WAKEUP
        this.playTone(this.START_FREQ, 300);
        await this.sleep(350);

        // 2. PAYLOAD DATA (Serial Bit-by-Bit)
        for (let i = 0; i < packet.length; i++) {
            const byte = packet[i];
            console.log(`[TX] Byte ${i + 1}/${packet.length}: 0x${byte.toString(16).padStart(2, '0').toUpperCase()} (${byte.toString(2).padStart(8, '0')})`);

            for (let bit = 7; bit >= 0; bit--) {
                const isOne = (byte >> bit) & 1;
                this.playTone(isOne ? this.FREQ_1 : this.FREQ_0, this.BAUD_RATE);
                await this.sleep(this.BAUD_RATE + this.GUARD_GAP);
            }
        }

        // 3. END MARKER
        await this.sleep(100);
        this.playTone(this.END_FREQ, 300);
        console.log("[TX] Transmission complete.");
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
        const k = Math.round((numSamples * targetFreq) / sampleRate);
        const omega = (2 * Math.PI * k) / numSamples;
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

    analyzeRecording: function(onDataComplete) {
        const sampleRate = this.audioCtx.sampleRate;
        const samples = this.concatenateChunks(this.recordedChunks);
        console.log(`%c[Analysis] Captured ${samples.length} samples (${(samples.length / sampleRate).toFixed(2)}s @ ${sampleRate}Hz). Decoding offline...`, "color:#3b82f6;font-weight:bold;");

        const windowSamples = Math.round(sampleRate * this.BAUD_RATE / 1000);
        const scanStepSamples = Math.round(sampleRate * 0.01); // 10ms scan resolution
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
        const gapSamples = Math.round(sampleRate * 0.350);
        let cursor = preambleEnd + gapSamples;
        const frameIntervalSamples = Math.round(sampleRate * (this.BAUD_RATE + this.GUARD_GAP) / 1000);

        console.log(`%c[RX 3/3] CLOCK LOCKED at t=${(cursor / sampleRate).toFixed(3)}s. Decoding payload...`, "color:#3b82f6;font-weight:bold;");

        // --- Decode bits at fixed sample-accurate offsets ---
        const receivedBits = [];
        let currentByteBits = [];
        let expectedLength = Infinity;
        let byteCount = 0;

        while (cursor + windowSamples < samples.length) {
            const m0   = mag(this.FREQ_0, cursor);
            const m1   = mag(this.FREQ_1, cursor);
            const mEnd = mag(this.END_FREQ, cursor);
            console.log(`[Bit] t=${(cursor / sampleRate).toFixed(3)}s F0=${m0.toFixed(2)} F1=${m1.toFixed(2)} END=${mEnd.toFixed(2)}`);

            if (mEnd > this.THRESHOLD && mEnd > m0 && mEnd > m1 && receivedBits.length >= 24) {
                console.log("[RX] End marker detected. Stopping decode.");
                break;
            }

            const bit = (m1 > m0) ? 1 : 0;
            receivedBits.push(bit);
            currentByteBits.push(bit);

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
        const testPayload = new Uint8Array([0xAA, 0xFF, 0x00, 0x55]);
        console.log("%c[TX] Sending FSK test packet...", "color:#f59e0b;font-weight:bold;");
        await this.transmitPayload(testPayload);
    }
};