// js/audio.js - 8-Frequency Differential FSK Modem

const AudioPipeline = {
    audioCtx: null,
    analyser: null,
    micStream: null,
    isListening: false,

    // ----------------------------------------------------
    // DIFFERENTIAL FREQUENCY ALLOCATION (Safe < 22kHz Nyquist)
    // ----------------------------------------------------
    LANE_FREQS_ONE:  [13000, 14000, 15000, 16000], // Frequencies for Bit = 1
    LANE_FREQS_ZERO: [16500, 17500, 18500, 19500], // Frequencies for Bit = 0
    
    // Markers compressed below 21.5kHz to support 44.1k audio cards
    START_FREQ: 20200, 
    SYNC_FREQ:  20700, 
    END_FREQ:   21200, 

    BAUD_RATE: 45,     
    GUARD_GAP: 25,     
    PREAMBLE_THRESH: 35, // Only used for the wakeup sequence

    init: function() {
        if (!this.audioCtx) {
            this.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
            console.log(`[Audio] Context initialized at ${this.audioCtx.sampleRate} Hz`);
        }
    },

    // ==========================================
    // 1. TRANSMITTER ENGINE (8-Tone Differential)
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

        // 8-FSK always plays exactly 4 tones. Scale volume accordingly.
        const peakVolume = 0.9 / 4;

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
        console.log(`[TX] Broadcasting ${payloadBytes.length} bytes via Differential FSK...`);

        // 1. PREAMBLE WAKEUP
        this.playParallelTones([this.START_FREQ], 300);
        await this.sleep(350); 

        // 2. PILOT SYNC
        this.playParallelTones([this.SYNC_FREQ], 100);
        await this.sleep(100 + this.GUARD_GAP + 50);

        // 3. DIFFERENTIAL DATA TRANSMISSION
        for (let i = 0; i < payloadBytes.length; i++) {
            const byte = payloadBytes[i];
            
            for (let nibbleIdx = 1; nibbleIdx >= 0; nibbleIdx--) {
                const shift = nibbleIdx * 4;
                const nibble = (byte >> shift) & 0x0F;

                const activeFreqs = [];
                
                // Construct the 4-tone signature
                for (let bit = 0; bit < 4; bit++) {
                    const bitValue = (nibble >> bit) & 1;
                    if (bitValue === 1) {
                        activeFreqs.push(this.LANE_FREQS_ONE[bit]);
                    } else {
                        activeFreqs.push(this.LANE_FREQS_ZERO[bit]);
                    }
                }

                console.log(`[TX] Sent Nibble: 0x${nibble.toString(16).toUpperCase()} (Binary: ${(nibble >>> 0).toString(2).padStart(4, '0')}) → Freqs: [${activeFreqs.join(', ')}]`);
                
                this.playParallelTones(activeFreqs, this.BAUD_RATE);
                await this.sleep(this.BAUD_RATE + this.GUARD_GAP);

                // console.log(`[TX] Nibble 0x${nibble.toString(16).toUpperCase()} → Freqs: ${activeFreqs.join(', ')}Hz`);
                
                this.playParallelTones(activeFreqs, this.BAUD_RATE);
                await this.sleep(this.BAUD_RATE + this.GUARD_GAP);
            }
        }

        // 4. END MARKER
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
            console.log("[RX] Receiver Armed for 8-Frequency Differential Decode.");

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
            const syncMag  = getPeak(this.SYNC_FREQ);
            const endMag   = getPeak(this.END_FREQ);

            if (state === 'IDLE') {
                if (startMag > this.PREAMBLE_THRESH) {
                    state = 'AWAIT_CLEARANCE';
                    receivedBits = [];
                    console.log("%c[RX 1/4] Preamble Detected.", "color: #f59e0b; font-weight: bold;");
                }
            }
            else if (state === 'AWAIT_CLEARANCE') {
                if (startMag < this.PREAMBLE_THRESH - 10) {
                    state = 'AWAIT_SYNC';
                    console.log("%c[RX 2/4] Awaiting Pilot Sync...", "color: #eab308; font-weight: bold;");
                }
            }
            else if (state === 'AWAIT_SYNC') {
                if (syncMag > this.PREAMBLE_THRESH) {
                    state = 'RECORDING';
                    lastBitTime = Date.now() + 100; 
                    console.log("%c[RX 3/4] Clock Synced! Decoding payload...", "color: #3b82f6; font-weight: bold;");
                }
            }
            else if (state === 'RECORDING') {
                const now = Date.now();
                const frameInterval = this.BAUD_RATE + this.GUARD_GAP;

                if (now - lastBitTime >= frameInterval) {
                    
                    const currentNibble = [0, 0, 0, 0];
                    // const debugInfo = [];

                    for (let i = 0; i < 4; i++) {
                        const magOne = getPeak(this.LANE_FREQS_ONE[i]);
                        const magZero = getPeak(this.LANE_FREQS_ZERO[i]);

                        // DIFFERENTIAL DECODE: Whichever frequency is louder wins. 
                        // No absolute noise thresholds needed.
                        let bitValue = 0;
                        if (magOne > magZero) {
                            bitValue = 1;
                        }
                        
                        currentNibble[i] = bitValue;
                        // debugInfo.push(`B${i}: 1=${magOne}, 0=${magZero} → ${bitValue}`);
                    }

                    receivedBits.push(currentNibble[3], currentNibble[2], currentNibble[1], currentNibble[0]);
                    lastBitTime = now;

                    if (receivedBits.length >= expectedBits) {
                        this.finishReception(receivedBits, onDataComplete);
                        return;
                    }
                }

                if (endMag > this.PREAMBLE_THRESH && receivedBits.length >= 8) {
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
        console.log("%c[RX 4/4] SUCCESS! Array Reconstructed:", "color: #7ed321; font-weight: bold;", finalBytes);
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
    }
};