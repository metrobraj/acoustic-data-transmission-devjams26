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
    THRESHOLD: 35,     // Amplitude required to register a 1 (out of 255)

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

        // NEW: Ensure an analyser exists so the visualizer can see outgoing TX bursts
        if (!this.analyser) {
            this.analyser = this.audioCtx.createAnalyser();
            this.analyser.fftSize = 2048;
        }

        const now = this.audioCtx.currentTime;
        const durationSec = durationMs / 1000;
        const masterGain = this.audioCtx.createGain();

        // Prevent Legion i7 speakers from distorting by dividing volume by active tones
        const peakVolume = 0.9 / Math.max(1, frequencies.length);

        masterGain.gain.setValueAtTime(0, now);
        masterGain.gain.linearRampToValueAtTime(peakVolume, now + 0.005);
        masterGain.gain.setValueAtTime(peakVolume, now + durationSec - 0.005);
        masterGain.gain.linearRampToValueAtTime(0, now + durationSec);
        
        // NEW ROUTING: Connect Gain -> Analyser -> Speakers
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
        console.log(`[TX] Broadcasting ${payloadBytes.length} bytes...`);

        // 1. PREAMBLE WAKEUP (17kHz for 300ms)
        this.playParallelTones([this.START_FREQ], 300);
        await this.sleep(350); 

        // 2. PILOT SYNC (16.5kHz for 100ms)
        this.playParallelTones([this.SYNC_FREQ], 100);
        await this.sleep(100 + this.GUARD_GAP + 50);

        // 3. PAYLOAD DATA (4 bits per symbol)
        for (let i = 0; i < payloadBytes.length; i++) {
            const byte = payloadBytes[i];
            
            for (let nibbleIdx = 1; nibbleIdx >= 0; nibbleIdx--) {
                const activeFreqs = [];
                const shift = nibbleIdx * 4;
                const nibble = (byte >> shift) & 0x0F;

                // Map bits to frequency lanes (Lane 0=13k, Lane 1=14k, Lane 2=15k, Lane 3=16k)
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

            // Tight 40Hz search radius to prevent spectral leakage
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
                    console.log("%c[RX 2/4] Awaiting Pilot Sync...", "color: #eab308; font-weight: bold;");
                }
            }

            // STATE 3: AWAIT_SYNC
            else if (state === 'AWAIT_SYNC') {
                if (syncMag > this.THRESHOLD) {
                    state = 'RECORDING';
                    // Align sample clock to start half a symbol after sync ends
                    lastBitTime = Date.now() + 100; 
                    console.log("%c[RX 3/4] Clock Synced! Decoding payload...", "color: #3b82f6; font-weight: bold;");
                }
            }

            // STATE 4: RECORDING (Self-Clocking Sampling)
            else if (state === 'RECORDING') {
                const now = Date.now();
                const frameInterval = this.BAUD_RATE + this.GUARD_GAP;

                if (now - lastBitTime >= frameInterval) {
                    const laneMags = [
                        getPeak(this.LANE_FREQS[0]), // Bit 0
                        getPeak(this.LANE_FREQS[1]), // Bit 1
                        getPeak(this.LANE_FREQS[2]), // Bit 2
                        getPeak(this.LANE_FREQS[3])  // Bit 3
                    ];

                    const maxLanePeak = Math.max(...laneMags);

                    // Dynamic Thresholding: A lane is "1" if it is at least 60% of the peak tone present
                    const dynamicCutoff = Math.max(this.THRESHOLD, maxLanePeak * 0.6);

                    const currentNibble = [0, 0, 0, 0];
                    for (let i = 0; i < 4; i++) {
                        if (laneMags[i] >= dynamicCutoff) {
                            currentNibble[i] = 1;
                        }
                    }

                    // Push MSB -> LSB (Lane 3 -> Lane 0)
                    receivedBits.push(currentNibble[3], currentNibble[2], currentNibble[1], currentNibble[0]);

                    const nibbleVal = (currentNibble[3] << 3) | (currentNibble[2] << 2) | (currentNibble[1] << 1) | currentNibble[0];
                    console.log(`[RX] Nibble ${receivedBits.length / 4}: [${currentNibble[3]}${currentNibble[2]}${currentNibble[1]}${currentNibble[0]}] (Val: ${nibbleVal})`);
                    
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
    //hallo
    transmitTestByte: async function() {
        if (!this.audioCtx) this.init();
        console.log("%c[TX] Sending test byte (10101010)...", "color: #f59e0b; font-weight: bold;");
        await this.transmitPayload(new Uint8Array([170]));
    }
};