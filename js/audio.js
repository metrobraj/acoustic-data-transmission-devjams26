// js/audio.js - Simple FSK Acoustic Modem

const AudioPipeline = {
    audioCtx: null,
    analyser: null,
    micStream: null,
    isListening: false,
    animationId: null,

    // ----------------------------------------------------
    // FSK FREQUENCY ALLOCATION
    // ----------------------------------------------------
    FREQ_0: 15000,     // Frequency for bit = 0
    FREQ_1: 18000,     // Frequency for bit = 1
    
    START_FREQ: 17000, // Wake up receiver
    SYNC_FREQ:  19000, // Sharp edge to lock receiver clock
    END_FREQ:   16000, // Transmission complete

    // ----------------------------------------------------
    // TIMING CONSTRAINTS
    // ----------------------------------------------------
    BAUD_RATE: 45,     // Duration of each tone pulse (ms)
    GUARD_GAP: 35,     // Dead-air between pulses to stop echo overlap (ms)
    THRESHOLD: 30,     // Absolute amplitude required for markers/sync

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

        if (!this.analyser) {
            this.analyser = this.audioCtx.createAnalyser();
            this.analyser.fftSize = 2048;
        }

        const now = this.audioCtx.currentTime;
        const durationSec = durationMs / 1000;
        const masterGain = this.audioCtx.createGain();

        const peakVolume = 0.9;

        masterGain.gain.setValueAtTime(0, now);
        masterGain.gain.linearRampToValueAtTime(peakVolume, now + 0.005);
        masterGain.gain.setValueAtTime(peakVolume, now + durationSec - 0.005);
        masterGain.gain.linearRampToValueAtTime(0, now + durationSec);
        
        masterGain.connect(this.analyser);
        this.analyser.connect(this.audioCtx.destination);

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
        for (let i = 0; i < payloadBytes.length; i++) {
            checksum ^= payloadBytes[i];
        }

        const packet = new Uint8Array(payloadBytes.length + 3);
        packet[0] = lengthHigh;
        packet[1] = lengthLow;
        packet.set(payloadBytes, 2);
        packet[packet.length - 1] = checksum;

        console.log(`[TX] Packet created: length=${length}B, checksum=0x${checksum.toString(16).toUpperCase()}`);
        console.log(`[TX] Initiating FSK transmission for ${packet.length} total bytes...`);

        // 1. PREAMBLE WAKEUP
        this.playTone(this.START_FREQ, 300);
        await this.sleep(350); 

        // 2. SYNC PULSE (Locks the receiver clock)
        console.log("[TX] Sending Sync Pulse...");
        this.playTone(this.SYNC_FREQ, this.BAUD_RATE); 
        await this.sleep(this.BAUD_RATE + this.GUARD_GAP);

        // 3. FSK PAYLOAD DATA (Serial Bit-by-Bit)
        console.log("[TX] Streaming payload...");
        for (let i = 0; i < packet.length; i++) {
            const byte = packet[i];
            console.log(`[TX] Transferring Byte ${i + 1}/${packet.length}: 0x${byte.toString(16).padStart(2, '0').toUpperCase()} (Bin: ${byte.toString(2).padStart(8, '0')})`);
            
            // Loop through all 8 bits (MSB first)
            for (let bit = 7; bit >= 0; bit--) {
                const isOne = (byte >> bit) & 1;
                const activeFreq = isOne ? this.FREQ_1 : this.FREQ_0;

                this.playTone(activeFreq, this.BAUD_RATE);
                await this.sleep(this.BAUD_RATE + this.GUARD_GAP);
            }
        }

        // 4. END MARKER
        await this.sleep(100);
        this.playTone(this.END_FREQ, 300);
        console.log("[TX] Transmission complete.");
    },

    // ==========================================
    // 2. RECEIVER ENGINE 
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
            this.analyser = this.audioCtx.createAnalyser();
            this.analyser.fftSize = 2048; 
            source.connect(this.analyser);

            this.isListening = true;
            console.log("[RX] Receiver Armed. Hardware filters bypassed.");

            this.listenLoop(onDataComplete);
        } catch (err) {
            console.error("[RX] Mic access denied:", err);
        }
    },

    listenLoop: function(onDataComplete) {
        const bufferLength = this.analyser.frequencyBinCount;
        const dataArray = new Uint8Array(bufferLength);

        let state = 'IDLE'; 
        let receivedBits = [];
        let lastBitTime = 0;
        let expectedLength = Infinity;
        let currentByteBits = [];

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
            const syncMag  = getPeak(this.SYNC_FREQ);
            const endMag   = getPeak(this.END_FREQ);
            const mag0     = getPeak(this.FREQ_0);
            const mag1     = getPeak(this.FREQ_1);

            // STATE 1: IDLE
            if (state === 'IDLE') {
                if (startMag > this.THRESHOLD) {
                    state = 'AWAIT_CLEARANCE';
                    receivedBits = [];
                    currentByteBits = [];
                    console.log("%c[RX 1/4] Preamble Detected.", "color: #f59e0b; font-weight: bold;");
                }
            }

            // STATE 2: AWAIT_CLEARANCE
            else if (state === 'AWAIT_CLEARANCE') {
                if (startMag < this.THRESHOLD - 10) {
                    state = 'AWAIT_SYNC';
                    console.log("%c[RX 2/4] Awaiting Sync Pulse...", "color: #eab308; font-weight: bold;");
                }
            }

            // STATE 3: AWAIT_SYNC
            else if (state === 'AWAIT_SYNC') {
                if (syncMag > this.THRESHOLD) {
                    state = 'RECORDING';
                    lastBitTime = Date.now(); 
                    console.log("%c[RX 3/4] CLOCK LOCKED! Sync Pulse verified.", "color: #3b82f6; font-weight: bold;");
                }
            }

            // STATE 4: RECORDING (FSK Comparison)
            else if (state === 'RECORDING') {
                const now = Date.now();
                const frameInterval = this.BAUD_RATE + this.GUARD_GAP;

                if (now - lastBitTime >= frameInterval) {
                    // Compare the 17kHz and 18kHz bins. The louder bin dictates the bit.
                    const bit = (mag1 > mag0) ? 1 : 0;
                    
                    receivedBits.push(bit);
                    currentByteBits.push(bit);
                    lastBitTime = now;

                    // Log byte progress
                    if (currentByteBits.length === 8) {
                        const byteVal = parseInt(currentByteBits.join(''), 2);
                        console.log(`[RX] Received Byte ${receivedBits.length / 8}: 0x${byteVal.toString(16).padStart(2, '0').toUpperCase()} (Bin: ${currentByteBits.join('')})`);
                        currentByteBits = [];

                        // Parse length from first two bytes
                        if (receivedBits.length === 16) {
                            const rawBytes = this.reconstructBytesFromBits(receivedBits);
                            expectedLength = (rawBytes[0] << 8) | rawBytes[1];
                            console.log(`[RX] Packet length parsed: Expecting ${expectedLength} payload bytes.`);
                        }
                    }

                    // Stop if we hit target bits (Header + Payload + Checksum)
                    const totalExpectedBits = (2 + expectedLength + 1) * 8;
                    if (receivedBits.length >= totalExpectedBits && expectedLength !== Infinity) {
                        this.finishReception(receivedBits, onDataComplete);
                        return;
                    }
                }

                // Fallback End Marker Trigger
                if (endMag > this.THRESHOLD && receivedBits.length >= 24) {
                    console.log("[RX] End marker detected.");
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

        const expectedLength = (rawBytes[0] << 8) | rawBytes[1];
        const payload = rawBytes.slice(2, 2 + expectedLength);
        const receivedChecksum = rawBytes[2 + expectedLength];

        let computedChecksum = 0;
        for (let i = 0; i < payload.length; i++) {
            computedChecksum ^= payload[i];
        }

        if (computedChecksum !== receivedChecksum) {
            console.error(`%c[RX] CHECKSUM MISMATCH! Expected 0x${receivedChecksum?.toString(16)}, got 0x${computedChecksum.toString(16)}. Packet corrupted.`, "color: red; font-weight: bold;");
            if (onDataComplete) onDataComplete(null);
            return;
        }

        console.log("%c[RX 4/4] SUCCESS! Checksum verified. Payload Reconstructed:", "color: #7ed321; font-weight: bold; font-size: 14px;", payload);
        if (onDataComplete) onDataComplete(payload);
    },

    reconstructBytesFromBits: function(bits) {
        const bytes = [];
        for (let i = 0; i < bits.length; i += 8) {
            if (i + 8 <= bits.length) {
                let byte = 0;
                for (let b = 0; b < 8; b++) byte = (byte << 1) | bits[i + b]; // MSB first
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

    // TEST HARNESS
    transmitTestByte: async function() {
        if (!this.audioCtx) this.init();
        
        // Tests the alternating pattern (10101010), high (11111111), and low (00000000) limits
        const testPayload = new Uint8Array([0xAA, 0xFF, 0x00, 0x55]);
        console.log("%c[TX] Sending FSK test packet [0xAA, 0xFF, 0x00, 0x55]...", "color: #f59e0b; font-weight: bold;");
        
        await this.transmitPayload(testPayload);
    }
};