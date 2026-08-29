// js/audio.js - Auditorium-Grade OFDM Acoustic Modem (Differential MFSK)

const AudioPipeline = {
    audioCtx: null,
    analyser: null,
    micStream: null,
    isListening: false,
    animationId: null,

    // ----------------------------------------------------
    // DIFFERENTIAL FREQUENCY ALLOCATION (14kHz to 21kHz)
    // ----------------------------------------------------
    // For each bit, either a ZERO freq or a ONE freq is played.
    ZERO_FREQS: [14000, 16000, 18000, 20000], // Frequencies for bit = 0
    ONE_FREQS:  [15000, 17000, 19000, 21000], // Frequencies for bit = 1
    
    // Shifted control frequencies down to avoid colliding with the 14k-21k data band
    START_FREQ: 12000, // Wake up receiver
    END_FREQ:   13000, // Transmission complete

    // ----------------------------------------------------
    // TIMING CONSTRAINTS
    // ----------------------------------------------------
    BAUD_RATE: 45,     // Duration of each tone pulse (ms)
    GUARD_GAP: 35,     // Dead-air between pulses to stop echo overlap (ms)
    THRESHOLD: 35,     // Absolute amplitude required for markers/sync

    init: function() {
        if (!this.audioCtx) {
            this.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
            console.log(`[Audio] Context initialized at ${this.audioCtx.sampleRate} Hz`);
        }
    },

    // ==========================================
    // 1. TRANSMITTER ENGINE
    // ==========================================
    playParallelTones: function(frequencies, durationMs) {
        if (!this.audioCtx || frequencies.length === 0) return;

        if (!this.analyser) {
            this.analyser = this.audioCtx.createAnalyser();
            this.analyser.fftSize = 2048;
        }

        const now = this.audioCtx.currentTime;
        const durationSec = durationMs / 1000;
        const masterGain = this.audioCtx.createGain();

        const peakVolume = 0.9 / Math.max(1, frequencies.length);

        masterGain.gain.setValueAtTime(0, now);
        masterGain.gain.linearRampToValueAtTime(peakVolume, now + 0.005);
        masterGain.gain.setValueAtTime(peakVolume, now + durationSec - 0.005);
        masterGain.gain.linearRampToValueAtTime(0, now + durationSec);
        
        masterGain.connect(this.analyser);
        this.analyser.connect(this.audioCtx.destination);

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
        
        // --- PACKET ASSEMBLY: [len_hi][len_lo][...payloadBytes...][checksum] ---
        const length = payloadBytes.length;
        const lengthHigh = (length >> 8) & 0xFF;
        const lengthLow  = length & 0xFF;

        let checksum = 0;
        for (let i = 0; i < payloadBytes.length; i++) {
            checksum ^= payloadBytes[i];
        }

        const packet = new Uint8Array(payloadBytes.length + 3);
        packet[0] = lengthHigh;
        packet[1] = lengthLow;
        packet.set(payloadBytes, 2);
        packet[packet.length - 1] = checksum;

        console.log(`[TX] Packet ready: length=${length}B checksum=${checksum}`);
        console.log(`[TX] Initiating transmission sequence for ${packet.length} bytes...`);

        // 1. PREAMBLE WAKEUP (12kHz for 300ms)
        this.playParallelTones([this.START_FREQ], 300);
        await this.sleep(350); 

        // 2. SYNC FRAME (All 4 bits ON -> Plays ONE_FREQS)
        console.log("[TX] Sending 1111 Sync Frame...");
        this.playParallelTones(this.ONE_FREQS, this.BAUD_RATE); 
        await this.sleep(this.BAUD_RATE + this.GUARD_GAP);

        // 3. DIFFERENTIAL PAYLOAD DATA (4 bits per symbol)
        console.log("[TX] Streaming payload...");
        for (let i = 0; i < packet.length; i++) {
            const byte = packet[i];
            
            for (let nibbleIdx = 1; nibbleIdx >= 0; nibbleIdx--) {
                const activeFreqs = [];
                const shift = nibbleIdx * 4;
                const nibble = (byte >> shift) & 0x0F;

                // Map bits to either ZERO frequency or ONE frequency
                for (let bit = 0; bit < 4; bit++) {
                    const isBitHigh = (nibble >> bit) & 1;
                    if (isBitHigh) {
                        activeFreqs.push(this.ONE_FREQS[bit]);
                    } else {
                        activeFreqs.push(this.ZERO_FREQS[bit]);
                    }
                }

                // Play exactly 4 frequencies (Constant Energy)
                this.playParallelTones(activeFreqs, this.BAUD_RATE);
                await this.sleep(this.BAUD_RATE + this.GUARD_GAP);
            }
        }

        // 4. END MARKER (13kHz)
        await this.sleep(100);
        this.playParallelTones([this.END_FREQ], 300);
        console.log("[TX] Transmission complete.");
    },

    // ==========================================
    // 2. RECEIVER ENGINE 
    // ==========================================
    startReceiver: async function(onDataComplete, targetByteLength = null) {
        if (!this.audioCtx) this.init();
        if (this.isListening) return;

        try {
            this.micStream = await navigator.mediaDevices.getUserMedia({ 
                audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false }, 
                video: false 
            });
            
            const source = this.audioCtx.createMediaStreamSource(this.micStream);
            this.analyser = this.audioCtx.createAnalyser();
            this.analyser.fftSize = 2048; 
            source.connect(this.analyser);

            this.isListening = true;
            console.log("[RX] Receiver Armed. Hardware filters bypassed.");

            this.listenLoop(onDataComplete, targetByteLength);
        } catch (err) {
            console.error("[RX] Mic access denied:", err);
        }
    },

    listenLoop: function(onDataComplete, targetByteLength = null) {
        const bufferLength = this.analyser.frequencyBinCount;
        const dataArray = new Uint8Array(bufferLength);

        let state = 'IDLE'; 
        let receivedBits = [];
        let lastBitTime = 0;
        const expectedBits = targetByteLength ? targetByteLength * 8 : Infinity;

        const pollAudio = () => {
            if (!this.isListening) return;

            this.analyser.getByteFrequencyData(dataArray);
            const sampleRate = this.audioCtx.sampleRate;
            const fftSize = this.analyser.fftSize;

            const getPeak = (freq) => {
                const minBin = Math.floor(((freq - 40) * fftSize) / sampleRate);
                const maxBin = Math.ceil(((freq + 40) * fftSize) / sampleRate);
                let max = 0;
                for (let i = minBin; i <= maxBin; i++) {
                    if (dataArray[i] > max) max = dataArray[i];
                }
                return max;
            };

            const startMag = getPeak(this.START_FREQ);
            const endMag   = getPeak(this.END_FREQ);
            
            // Extract magnitudes for 0s and 1s separately
            const zeroMags = [
                getPeak(this.ZERO_FREQS[0]),
                getPeak(this.ZERO_FREQS[1]),
                getPeak(this.ZERO_FREQS[2]),
                getPeak(this.ZERO_FREQS[3])
            ];
            
            const oneMags = [
                getPeak(this.ONE_FREQS[0]),
                getPeak(this.ONE_FREQS[1]),
                getPeak(this.ONE_FREQS[2]),
                getPeak(this.ONE_FREQS[3])
            ];

            // STATE 1: IDLE
            if (state === 'IDLE') {
                if (startMag > this.THRESHOLD) {
                    state = 'AWAIT_CLEARANCE';
                    receivedBits = [];
                    console.log("%c[RX 1/4] Preamble Detected.", "color: #f59e0b; font-weight: bold;");
                }
            }

            // STATE 2: AWAIT_CLEARANCE
            else if (state === 'AWAIT_CLEARANCE') {
                if (startMag < this.THRESHOLD - 10) {
                    state = 'AWAIT_SYNC';
                    console.log("%c[RX 2/4] Awaiting 1111 Sync Frame...", "color: #eab308; font-weight: bold;");
                }
            }

            // STATE 3: AWAIT_SYNC
            else if (state === 'AWAIT_SYNC') {
                // Ensure the '1' frequency is louder than the '0' frequency for all 4 lanes, AND above background threshold
                const is1111 = oneMags.every((mag, i) => (mag > zeroMags[i]) && (mag >= this.THRESHOLD));
                
                if (is1111) {
                    state = 'RECORDING';
                    lastBitTime = Date.now(); 
                    console.log("%c[RX 3/4] CLOCK LOCKED! 1111 Sync Frame verified.", "color: #3b82f6; font-weight: bold;");
                }
            }

            // STATE 4: RECORDING (Differential Comparison)
            else if (state === 'RECORDING') {
                const now = Date.now();
                const frameInterval = this.BAUD_RATE + this.GUARD_GAP;

                if (now - lastBitTime >= frameInterval) {
                    const currentNibble = [0, 0, 0, 0];
                    
                    for (let i = 0; i < 4; i++) {
                        // The Core Logic: Whichever tone is louder dictates the bit
                        if (oneMags[i] > zeroMags[i]) {
                            currentNibble[i] = 1;
                        } else {
                            currentNibble[i] = 0;
                        }
                    }

                    // Push MSB -> LSB (Lane 3 -> Lane 0)
                    receivedBits.push(currentNibble[3], currentNibble[2], currentNibble[1], currentNibble[0]);
                    lastBitTime = now;

                    if (receivedBits.length >= expectedBits) {
                        this.finishReception(receivedBits, onDataComplete);
                        return;
                    }
                }

                if (endMag > this.THRESHOLD && receivedBits.length >= 8) {
                    this.finishReception(receivedBits, onDataComplete);
                    return;
                }
            }

            this.animationId = requestAnimationFrame(pollAudio);
        };

        this.animationId = requestAnimationFrame(pollAudio);
    },

    finishReception: function(receivedBits, onDataComplete) {
        this.stopReceiver();
        const rawBytes = this.reconstructBytesFromBits(receivedBits);

        if (rawBytes.length < 3) {
            console.error("[RX] Packet too short to contain header+checksum.");
            if (onDataComplete) onDataComplete(null);
            return;
        }

        // Parse length header
        const expectedLength = (rawBytes[0] << 8) | rawBytes[1];
        const payload = rawBytes.slice(2, 2 + expectedLength);
        const receivedChecksum = rawBytes[2 + expectedLength];

        // Recompute checksum
        let computedChecksum = 0;
        for (let i = 0; i < payload.length; i++) {
            computedChecksum ^= payload[i];
        }

        if (computedChecksum !== receivedChecksum) {
            console.error(`%c[RX] CHECKSUM MISMATCH! Expected ${receivedChecksum}, got ${computedChecksum}. Packet corrupted.`, "color: red; font-weight: bold;");
            if (onDataComplete) onDataComplete(null);
            return;
        }

        console.log("%c[RX 4/4] SUCCESS! Checksum verified. Payload:", "color: #7ed321; font-weight: bold; font-size: 14px;", payload);
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

    stopReceiver: function() {
        this.isListening = false;
        if (this.animationId) {
            cancelAnimationFrame(this.animationId);
            this.animationId = null;
        }
        if (this.micStream) {
            this.micStream.getTracks().forEach(track => track.stop());
            this.micStream = null;
        }
    },

    sleep: function(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    },

    transmitTestByte: async function() {
        if (!this.audioCtx) this.init();
        console.log("%c[TX] Sending test byte (10101010)...", "color: #f59e0b; font-weight: bold;");
        await this.transmitPayload(new Uint8Array([170]));
    }
};