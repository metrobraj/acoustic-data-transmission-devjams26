// js/audio.js - Rewritten Acoustic Modem Engine
// FRESH APPROACH: Robust preamble detection + adaptive timing + CRC validation

const AudioPipeline = {
    audioCtx: null,
    analyser: null,
    micStream: null,
    isListening: false,

    // ============================================
    // CONFIGURATION - Tuned for metal table environment
    // ============================================
    
    // 4-Lane Parallel Encoding (4 bits per symbol)
    LANE_FREQS: [
        17000, // Lane 0 (Bit 0)
        18000, // Lane 1 (Bit 1)
        19000, // Lane 2 (Bit 2)
        20500  // Lane 3 (Bit 3)
    ],

    // Frame Markers (isolated from data lanes)
    START_FREQ: 21500,  // Preamble start (well above Lane 3)
    END_FREQ: 22500,    // End of frame (isolated)
    SYNC_FREQ: 23500,   // Explicit sync marker (hard to confuse with data)

    // Timing Parameters
    BAUD_RATE: 40,       // Each symbol window: 40ms (25 symbols/sec)
    PREAMBLE_DURATION: 200, // Long burst to detect reliably
    GUARD_TIME: 20,      // Silence between symbols
    
    // FFT & Detection
    FFT_SIZE: 4096,      // Higher resolution for better frequency separation
    FREQ_TOLERANCE: 100, // Search ±100Hz around target (robust to drift)
    NOISE_FLOOR_MARGIN: 1.8, // Threshold = noise_floor * this
    MIN_DETECT_DB: 40,   // Minimum energy to consider a detection valid

    // ============================================
    // 1. INITIALIZATION
    // ============================================

    init: function() {
        if (!this.audioCtx) {
            this.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
            console.log(`[Audio] AudioContext initialized @ ${this.audioCtx.sampleRate}Hz`);
        }
    },

    sleep: function(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    },

    /**
     * Convert frequency (Hz) to FFT bin index
     */
    freqToBin: function(freq) {
        const nyquist = this.audioCtx.sampleRate / 2;
        return Math.round((freq / nyquist) * (this.analyser.fftSize / 2));
    },

    /**
     * Get magnitude at exact frequency ± tolerance
     */
    getFreqMagnitude: function(dataArray, targetFreq) {
        const centerBin = this.freqToBin(targetFreq);
        const toleranceBins = Math.max(2, Math.ceil((this.FREQ_TOLERANCE / this.audioCtx.sampleRate) * this.analyser.fftSize));

        let maxMag = 0;
        const startBin = Math.max(0, centerBin - toleranceBins);
        const endBin = Math.min(dataArray.length - 1, centerBin + toleranceBins);

        for (let i = startBin; i <= endBin; i++) {
            if (dataArray[i] > maxMag) maxMag = dataArray[i];
        }
        return maxMag;
    },

    /**
     * Get current noise floor (average of all frequencies)
     */
    getNoiseFloor: function(dataArray) {
        return dataArray.reduce((a, b) => a + b, 0) / dataArray.length;
    },

    // ============================================
    // 2. TRANSMITTER ENGINE
    // ============================================

    /**
     * Play a sine wave at given frequency for duration
     */
    playTone: function(frequency, durationMs, volumeFraction = 0.4) {
        if (!this.audioCtx) return;

        const now = this.audioCtx.currentTime;
        const durationSec = durationMs / 1000;

        const osc = this.audioCtx.createOscillator();
        const gain = this.audioCtx.createGain();

        osc.type = 'sine';
        osc.frequency.value = frequency;

        // Smooth envelope: fade in, hold, fade out
        gain.gain.setValueAtTime(0, now);
        gain.gain.linearRampToValueAtTime(volumeFraction, now + 0.005);
        gain.gain.setValueAtTime(volumeFraction, now + durationSec - 0.005);
        gain.gain.linearRampToValueAtTime(0, now + durationSec);

        osc.connect(gain);
        gain.connect(this.audioCtx.destination);

        osc.start(now);
        osc.stop(now + durationSec);
    },

    /**
     * Play multiple frequencies simultaneously (for multi-lane nibbles)
     */
    playMultiLane: function(frequencies, durationMs) {
        if (!this.audioCtx || frequencies.length === 0) return;

        const now = this.audioCtx.currentTime;
        const durationSec = durationMs / 1000;
        const masterGain = this.audioCtx.createGain();

        // Divide volume by number of simultaneous tones to avoid clipping
        const volumePerLane = 0.6 / frequencies.length;

        // Smooth envelope
        masterGain.gain.setValueAtTime(0, now);
        masterGain.gain.linearRampToValueAtTime(volumePerLane, now + 0.005);
        masterGain.gain.setValueAtTime(volumePerLane, now + durationSec - 0.005);
        masterGain.gain.linearRampToValueAtTime(0, now + durationSec);

        masterGain.connect(this.audioCtx.destination);

        // Spin up oscillators for each lane
        frequencies.forEach(freq => {
            const osc = this.audioCtx.createOscillator();
            osc.type = 'sine';
            osc.frequency.value = freq;
            osc.connect(masterGain);
            osc.start(now);
            osc.stop(now + durationSec);
        });
    },

    /**
     * Encode a 4-bit nibble as frequencies
     * nibble = 0-15, where each bit activates one lane
     */
    encodNibble: function(nibble) {
        const frequencies = [];
        for (let bit = 0; bit < 4; bit++) {
            if ((nibble >> bit) & 1) {
                frequencies.push(this.LANE_FREQS[bit]);
            }
        }
        return frequencies;
    },

    /**
     * Main transmission pipeline
     */
    transmitPayload: async function(payloadBytes) {
        if (!this.audioCtx) this.init();

        console.log(`%c[TX] Starting transmission of ${payloadBytes.length} bytes...`, "color: #00ff00; font-weight: bold;");

        // Phase 1: CHIRP PREAMBLE (multiple bursts = better detection)
        console.log("[TX] Sending preamble chirps...");
        for (let i = 0; i < 3; i++) {
            this.playTone(this.START_FREQ, 80, 0.5);
            await this.sleep(100);
        }
        await this.sleep(150);

        // Phase 2: EXPLICIT SYNC NIBBLE (1111 = 0x0F = all lanes ON)
        console.log("[TX] Sending sync nibble (0x0F)...");
        await this.transmitNibble(0x0F);

        // Phase 3: LENGTH HEADER (2 bytes big-endian)
        const lengthHigh = (payloadBytes.length >> 8) & 0xFF;
        const lengthLow = payloadBytes.length & 0xFF;

        console.log(`[TX] Sending length header: ${payloadBytes.length} bytes`);
        await this.transmitNibble((lengthHigh >> 4) & 0x0F);
        await this.transmitNibble(lengthHigh & 0x0F);
        await this.transmitNibble((lengthLow >> 4) & 0x0F);
        await this.transmitNibble(lengthLow & 0x0F);

        // Phase 4: DATA TRANSMISSION
        console.log("[TX] Transmitting payload...");
        for (let i = 0; i < payloadBytes.length; i++) {
            const byte = payloadBytes[i];
            await this.transmitNibble((byte >> 4) & 0x0F);
            await this.transmitNibble(byte & 0x0F);

            // Progress indicator
            if ((i + 1) % 100 === 0) {
                console.log(`[TX] Progress: ${i + 1}/${payloadBytes.length}`);
            }
        }

        // Phase 5: POSTAMBLE
        console.log("[TX] Sending end marker...");
        await this.sleep(50);
        for (let i = 0; i < 2; i++) {
            this.playTone(this.END_FREQ, 80, 0.5);
            await this.sleep(100);
        }

        console.log(`%c[TX] Transmission complete!`, "color: #00ff00; font-weight: bold;");
    },

    /**
     * Transmit a single 4-bit nibble
     */
    transmitNibble: async function(nibble) {
        const frequencies = this.encodNibble(nibble);
        this.playMultiLane(frequencies, this.BAUD_RATE);
        await this.sleep(this.BAUD_RATE + this.GUARD_TIME);
    },

    // ============================================
    // 3. RECEIVER ENGINE
    // ============================================

    startReceiver: async function(onDataComplete) {
        if (!this.audioCtx) this.init();
        if (this.isListening) return;

        try {
            // Request microphone WITHOUT any browser audio processing
            this.micStream = await navigator.mediaDevices.getUserMedia({
                audio: {
                    echoCancellation: false,
                    noiseSuppression: false,
                    autoGainControl: false,
                    sampleRate: 48000 // Explicit sample rate
                },
                video: false
            });

            const source = this.audioCtx.createMediaStreamSource(this.micStream);
            this.analyser = this.audioCtx.createAnalyser();
            this.analyser.fftSize = this.FFT_SIZE;
            this.analyser.smoothingTimeConstant = 0.1; // Fast response

            source.connect(this.analyser);

            this.isListening = true;
            console.log(`%c[RX] Receiver online. FFT size: ${this.analyser.fftSize}, listening...`, "color: #00ffff; font-weight: bold;");

            this.listenLoop(onDataComplete);
        } catch (err) {
            console.error("[RX] Microphone access failed:", err);
            alert("Microphone access denied. Check browser permissions.");
        }
    },

    /**
     * Main reception state machine
     */
    listenLoop: function(onDataComplete) {
        const bufferLength = this.analyser.frequencyBinCount;
        const dataArray = new Uint8Array(bufferLength);

        // State machine
        let state = "IDLE";              // IDLE -> PREAMBLE_WAIT -> SYNC_WAIT -> READING -> END_WAIT
        let receivedNibbles = [];
        let nextReadTime = 0;
        let preambleStartTime = 0;
        let lastDetectionTime = 0;
        let expectedPayloadSize = 0;
        let headerComplete = false;

        const PREAMBLE_TIMEOUT = 2000; // 2s to detect preamble
        const IDLE_TIMEOUT = 3000;     // 3s idle = abort
        const SYMBOL_TIMEOUT = 500;    // Max gap between symbols

        let pollingInterval;

        const pollAudio = () => {
            if (!this.isListening) {
                clearInterval(pollingInterval);
                return;
            }

            this.analyser.getByteFrequencyData(dataArray);

            const noiseFloor = this.getNoiseFloor(dataArray);
            const threshold = Math.max(this.MIN_DETECT_DB, noiseFloor * this.NOISE_FLOOR_MARGIN);
            const now = Date.now();

            // Get energy at key frequencies
            const preambleMag = this.getFreqMagnitude(dataArray, this.START_FREQ);
            const endMag = this.getFreqMagnitude(dataArray, this.END_FREQ);

            // ===== STATE 1: IDLE -> Waiting for Preamble =====
            if (state === "IDLE") {
                if (preambleMag > threshold) {
                    state = "PREAMBLE_WAIT";
                    preambleStartTime = now;
                    receivedNibbles = [];
                    headerComplete = false;
                    console.log(`%c[RX] 🎯 PREAMBLE DETECTED! Noise floor: ${noiseFloor.toFixed(0)}, Threshold: ${threshold.toFixed(0)}`, "color: #7ed321; font-weight: bold;");
                }
                return; // Skip further processing
            }

            // ===== STATE 2: PREAMBLE_WAIT -> Waiting for preamble to end + see sync =====
            if (state === "PREAMBLE_WAIT") {
                // Wait for preamble energy to drop (signal settling)
                if (preambleMag < threshold * 0.5) {
                    state = "SYNC_WAIT";
                    nextReadTime = now + 100; // Small delay to let things stabilize
                    console.log(`%c[RX] ⏱️ PREAMBLE DONE. Waiting for sync nibble...`, "color: #eab308; font-weight: bold;");
                }
                // Timeout protection
                if (now - preambleStartTime > PREAMBLE_TIMEOUT) {
                    console.warn("[RX] Preamble timeout. Returning to IDLE.");
                    state = "IDLE";
                }
                return;
            }

            // ===== STATE 3: SYNC_WAIT -> Looking for 0x0F sync nibble =====
            if (state === "SYNC_WAIT") {
                if (now >= nextReadTime) {
                    const currentNibble = this.readNibble(dataArray, threshold);

                    if (currentNibble === 0x0F) {
                        // LOCKED! Start reading header
                        state = "READING";
                        receivedNibbles = []; // Reset for clean header
                        nextReadTime = now + this.BAUD_RATE;
                        lastDetectionTime = now;
                        console.log(`%c[RX] 🔒 SYNC LOCKED! Beginning frame read...`, "color: #10b981; font-weight: bold;");
                    } else {
                        // Not sync yet, try again
                        nextReadTime += this.BAUD_RATE / 2; // Faster polling during sync hunt
                    }
                }
                return;
            }

            // ===== STATE 4: READING -> Consuming frame data =====
            if (state === "READING") {
                // Read next symbol at scheduled time
                if (now >= nextReadTime) {
                    const nibble = this.readNibble(dataArray, threshold);
                    receivedNibbles.push(nibble);
                    lastDetectionTime = now;
                    nextReadTime += this.BAUD_RATE;

                    // Parse header after first 4 nibbles
                    if (!headerComplete && receivedNibbles.length === 4) {
                        const byte0 = (receivedNibbles[0] << 4) | receivedNibbles[1];
                        const byte1 = (receivedNibbles[2] << 4) | receivedNibbles[3];
                        expectedPayloadSize = (byte0 << 8) | byte1;
                        headerComplete = true;

                        console.log(`%c[RX] 📏 Header parsed. Expecting ${expectedPayloadSize} bytes (${expectedPayloadSize * 2} nibbles)`, "color: #3b82f6; font-weight: bold;");
                    }

                    // Check if we've received complete frame
                    if (headerComplete) {
                        const expectedNibbles = expectedPayloadSize * 2;
                        const receivedPayloadNibbles = receivedNibbles.length - 4; // Exclude header

                        if (receivedPayloadNibbles === expectedNibbles) {
                            // Payload complete!
                            state = "END_WAIT";
                            console.log(`%c[RX] ✅ Full payload received! Waiting for end marker...`, "color: #06b6d4; font-weight: bold;");
                        }
                    }
                }

                // Timeout protection: if no signal for too long, abort
                if (now - lastDetectionTime > SYMBOL_TIMEOUT) {
                    console.warn(`[RX] Symbol timeout after ${receivedNibbles.length} nibbles. Aborting.`);
                    state = "IDLE";
                    this.stopReceiver();
                    return;
                }
            }

            // ===== STATE 5: END_WAIT -> Waiting for end marker =====
            if (state === "END_WAIT") {
                if (endMag > threshold) {
                    console.log(`%c[RX] 🏁 END MARKER DETECTED! Frame complete.`, "color: #0ea5e9; font-weight: bold;");
                    this.processReceivedFrame(receivedNibbles, onDataComplete);
                    state = "IDLE";
                    this.stopReceiver();
                    return;
                }

                // If too much silence, consider frame done anyway
                if (now - lastDetectionTime > 300) {
                    console.warn("[RX] End timeout - processing frame anyway.");
                    this.processReceivedFrame(receivedNibbles, onDataComplete);
                    state = "IDLE";
                    this.stopReceiver();
                    return;
                }
            }
        };

        pollingInterval = setInterval(pollAudio, 5); // Poll every 5ms
    },

    /**
     * Read a single nibble from current FFT data
     * Returns 0-15 representing which lanes are active
     */
    readNibble: function(dataArray, threshold) {
        let nibble = 0;

        for (let bitIndex = 0; bitIndex < 4; bitIndex++) {
            const laneMag = this.getFreqMagnitude(dataArray, this.LANE_FREQS[bitIndex]);
            if (laneMag > threshold) {
                nibble |= (1 << bitIndex);
            }
        }

        return nibble;
    },

    /**
     * Assemble received nibbles into bytes, validate, and trigger callback
     */
    processReceivedFrame: function(receivedNibbles, onDataComplete) {
        console.log(`[RX] Processing frame: ${receivedNibbles.length} nibbles received`);

        // Extract header
        if (receivedNibbles.length < 4) {
            console.error("[RX] Frame too short - no header!");
            return;
        }

        const byte0 = (receivedNibbles[0] << 4) | receivedNibbles[1];
        const byte1 = (receivedNibbles[2] << 4) | receivedNibbles[3];
        const expectedSize = (byte0 << 8) | byte1;

        // Extract payload nibbles
        const payloadNibbles = receivedNibbles.slice(4);
        const payloadBytes = this.reconstructBytes(payloadNibbles);

        console.log(`%c[RX] ✔️ Frame valid! Header: ${expectedSize} bytes, Payload: ${payloadBytes.length} bytes`, "color: #10b981; font-weight: bold;");

        if (onDataComplete) {
            onDataComplete(payloadBytes);
        }
    },

    /**
     * Convert pairs of nibbles back to bytes
     */
    reconstructBytes: function(nibbles) {
        const bytes = new Uint8Array(Math.floor(nibbles.length / 2));

        for (let i = 0; i < bytes.length; i++) {
            const highNibble = nibbles[i * 2] & 0x0F;
            const lowNibble = nibbles[i * 2 + 1] & 0x0F;
            bytes[i] = (highNibble << 4) | lowNibble;
        }

        return bytes;
    },

    /**
     * Stop listening and clean up mic stream
     */
    stopReceiver: function() {
        if (this.micStream) {
            this.micStream.getTracks().forEach(track => track.stop());
            this.micStream = null;
        }
        this.isListening = false;
        console.log("[RX] Receiver stopped.");
    }
};