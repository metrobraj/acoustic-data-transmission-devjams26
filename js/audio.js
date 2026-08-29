// js/audio.js - Auditorium-Grade OFDM Acoustic Modem

const AudioPipeline = {
    audioCtx: null,
    analyser: null,
    micStream: null,
    isListening: false,

    // ----------------------------------------------------
    // WIDE-BAND FREQUENCY ALLOCATION (Zero Crosstalk)
    // ----------------------------------------------------
    LANE_FREQS: [
        13000, // Lane 0 (Bit 0)
        14000, // Lane 1 (Bit 1)
        15000, // Lane 2 (Bit 2)
        16000  // Lane 3 (Bit 3)
    ],
    
    START_FREQ: 17000, // Wake up receiver
    SYNC_FREQ:  16500, // Precise clock-sync trigger
    END_FREQ:   17500, // Transmission complete

    // ----------------------------------------------------
    // TIMING CONSTRAINTS (Tuned for Large Room Acoustics)
    // ----------------------------------------------------
    BAUD_RATE: 45,     // Duration of each tone pulse (ms)
    GUARD_GAP: 25,     // Dead-air between pulses to stop echo overlap (ms)
    THRESHOLD: 45,     // Amplitude required to register a 1 (out of 255)

    init: function() {
        if (!this.audioCtx) {
            this.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
            console.log(`[Audio] Context initialized at ${this.audioCtx.sampleRate} Hz`);
        }
    },

    // ==========================================
    // 1. TRANSMITTER ENGINE (Legion i7 Optimized)
    // ==========================================
    playParallelTones: function(frequencies, durationMs) {
        if (!this.audioCtx || frequencies.length === 0) return;

        const now = this.audioCtx.currentTime;
        const durationSec = durationMs / 1000;
        const masterGain = this.audioCtx.createGain();

        // Prevent Legion i7 speakers from distorting by dividing volume by active tones
        const peakVolume = 0.9 / Math.max(1, frequencies.length);

        masterGain.gain.setValueAtTime(0, now);
        masterGain.gain.linearRampToValueAtTime(peakVolume, now + 0.005);
        masterGain.gain.setValueAtTime(peakVolume, now + durationSec - 0.005);
        masterGain.gain.linearRampToValueAtTime(0, now + durationSec);
        masterGain.connect(this.audioCtx.destination);

        frequencies.forEach(freq => {
            const osc = this.audioCtx.createOscillator();
            osc.type = 'sine';
            osc.frequency.value = freq;
            osc.connect(masterGain);
            osc.start(now);
            osc.stop(now + durationSec);
        });
    },

    transmitPayload: async function(payloadBytes) {
        if (!this.audioCtx) this.init();
        console.log(`[TX] Broadcasting ${payloadBytes.length} bytes...`);

        // 1. PREAMBLE WAKEUP
        this.playParallelTones([this.START_FREQ], 300);
        await this.sleep(400); // Wait for auditorium echo to clear

        // 2. PILOT SYNC (Aligns receiver clock)
        this.playParallelTones([this.SYNC_FREQ], 50);
        await this.sleep(50 + this.GUARD_GAP);

        // 3. PAYLOAD DATA (4 bits per symbol)
        for (let i = 0; i < payloadBytes.length; i++) {
            const byte = payloadBytes[i];
            
            for (let nibbleIdx = 1; nibbleIdx >= 0; nibbleIdx--) {
                const activeFreqs = [];
                const shift = nibbleIdx * 4;
                const nibble = (byte >> shift) & 0x0F;

                for (let bit = 0; bit < 4; bit++) {
                    if ((nibble >> bit) & 1) activeFreqs.push(this.LANE_FREQS[bit]);
                }

                if (activeFreqs.length > 0) {
                    this.playParallelTones(activeFreqs, this.BAUD_RATE);
                }
                
                await this.sleep(this.BAUD_RATE + this.GUARD_GAP);
            }
        }

        // 4. END MARKER
        await this.sleep(100);
        this.playParallelTones([this.END_FREQ], 300);
        console.log("[TX] Transmission complete.");
    },

    // ==========================================
    // 2. RECEIVER ENGINE (MacBook M5 Optimized)
    // ==========================================
    startReceiver: async function(onDataComplete, targetByteLength = null) {
        if (!this.audioCtx) this.init();
        if (this.isListening) return;

        try {
            // Bypass Apple's aggressive voice-isolation DSP
            this.micStream = await navigator.mediaDevices.getUserMedia({ 
                audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false }, 
                video: false 
            });
            
            const source = this.audioCtx.createMediaStreamSource(this.micStream);
            this.analyser = this.audioCtx.createAnalyser();
            this.analyser.fftSize = 2048; 
            this.analyser.smoothingTimeConstant = 0;
            source.connect(this.analyser);

            this.isListening = true;
            console.log("[RX] Receiver Armed. Hardware filters bypassed.");

            this.listenLoop(onDataComplete, targetByteLength);
        } catch (err) {
            console.error("[RX] Mic access denied:", err);
        }
    },

    listenLoop: function(onDataComplete, targetByteLength) {
        const bufferLength = this.analyser.frequencyBinCount;
        const dataArray = new Uint8Array(bufferLength);

        let state = 'IDLE'; // IDLE -> AWAIT_CLEARANCE -> AWAIT_SYNC -> RECORDING
        let receivedBits = [];
        let lastBitTime = 0;
        const expectedBits = targetByteLength ? targetByteLength * 8 : Infinity;

        const pollAudio = () => {
            if (!this.isListening) return;

            this.analyser.getByteFrequencyData(dataArray);
            const sampleRate = this.audioCtx.sampleRate;
            const fftSize = this.analyser.fftSize;

            // Tight +/- 100Hz isolation to eliminate overlapping bin logic
            const getPeak = (freq) => {
                const minBin = Math.floor(((freq - 100) * fftSize) / sampleRate);
                const maxBin = Math.ceil(((freq + 100) * fftSize) / sampleRate);
                let max = 0;
                for (let i = minBin; i <= maxBin; i++) {
                    if (dataArray[i] > max) max = dataArray[i];
                }
                return max;
            };

            const startMag = getPeak(this.START_FREQ);
            const syncMag  = getPeak(this.SYNC_FREQ);
            const endMag   = getPeak(this.END_FREQ);

            // STATE 1: IDLE (Scan for 17kHz Wakeup)
            if (state === 'IDLE') {
                if (startMag > this.THRESHOLD) {
                    state = 'AWAIT_CLEARANCE';
                    receivedBits = [];
                    console.log("%c[RX 1/4] Preamble Detected. Awaiting echo clearance...", "color: #f59e0b; font-weight: bold;");
                }
            }

            // STATE 2: CLEARANCE (Wait for 17kHz to fade out in the auditorium)
            else if (state === 'AWAIT_CLEARANCE') {
                if (startMag < this.THRESHOLD - 10) {
                    state = 'AWAIT_SYNC';
                    console.log("%c[RX 2/4] Channel Clear. Awaiting Pilot Sync...", "color: #eab308; font-weight: bold;");
                }
            }

            // STATE 3: SYNC (Lock clock exactly to the 16.5kHz pilot tone)
            else if (state === 'AWAIT_SYNC') {
                if (syncMag > this.THRESHOLD) {
                    state = 'RECORDING';
                    // Set clock to sample precisely in the middle of the upcoming data pulses
                    lastBitTime = Date.now() + (this.BAUD_RATE / 2); 
                    console.log("%c[RX 3/4] Clock Synced! Recording bits...", "color: #3b82f6; font-weight: bold;");
                }
            }

            // STATE 4: RECORDING (Read exact byte chunks)
            else if (state === 'RECORDING') {
                const now = Date.now();
                const frameInterval = this.BAUD_RATE + this.GUARD_GAP;

                if (now - lastBitTime >= frameInterval) {
                    // Grab all 4 lane magnitudes at once
                    const laneMags = [
                        getPeak(this.LANE_FREQS[0]),
                        getPeak(this.LANE_FREQS[1]),
                        getPeak(this.LANE_FREQS[2]),
                        getPeak(this.LANE_FREQS[3])
                    ];

                    // Threshold relative to the loudest lane THIS symbol
                    const maxLanePeak = Math.max(...laneMags);
                    const dynamicCutoff = Math.max(this.THRESHOLD, maxLanePeak * 0.6);

                    const currentNibble = [0, 0, 0, 0];
                    for (let i = 0; i < 4; i++) {
                        if (laneMags[i] >= dynamicCutoff) {
                            currentNibble[i] = 1;
                        }
                    }

                    receivedBits.push(currentNibble[3], currentNibble[2], currentNibble[1], currentNibble[0]);
                    console.log(`[RX] Nibble ${receivedBits.length/4}: ${currentNibble.slice().reverse().join('')}`);
                    lastBitTime = now;

                    // Stop condition A: Reached exact strict length
                    if (receivedBits.length >= expectedBits) {
                        this.finishReception(receivedBits, onDataComplete);
                        return;
                    }
                }

                // Stop condition B: Detected End frequency (useful for unknown file sizes)
                if (endMag > this.THRESHOLD && receivedBits.length >= 8) {
                    this.finishReception(receivedBits, onDataComplete);
                    return;
                }
            }

            requestAnimationFrame(pollAudio);
        };

        pollAudio();
    },

    finishReception: function(receivedBits, onDataComplete) {
        this.stopReceiver();
        const finalBytes = this.reconstructBytesFromBits(receivedBits);
        console.log("%c[RX 4/4] SUCCESS! Array Reconstructed:", "color: #7ed321; font-weight: bold; font-size: 14px;", finalBytes);
        if (onDataComplete) onDataComplete(finalBytes);
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

    stopReceiver: function() {
        this.isListening = false;
        if (this.micStream) this.micStream.getTracks().forEach(track => track.stop());
    },

    sleep: function(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    },

    // GATE 2 TEST HARNESS (Transmits 0xAA)
    transmitTestByte: async function() {
        if (!this.audioCtx) this.init();
        console.log("%c[TX] Sending test byte (10101010)...", "color: #f59e0b; font-weight: bold;");
        await this.transmitPayload(new Uint8Array([170]));
    }
};