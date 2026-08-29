// js/audio.js

const AudioPipeline = {
    audioCtx: null,
    analyser: null,
    micStream: null,
    isListening: false,

    // Single-Lane FSK Frequency Map (Hz)
    FREQ_0: 17500,       // Binary 0
    FREQ_1: 18500,       // Binary 1
    START_FREQ: 19500,   // Frame Start Marker
    END_FREQ: 19800,     // Frame End Marker

    BAUD_RATE: 30,       // Symbol duration per bit (ms)

    /**
     * Initializes AudioContext on user gesture.
     */
    init: function() {
        if (!this.audioCtx) {
            this.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
            console.log("[Audio] AudioContext initialized at:", this.audioCtx.sampleRate, "Hz");
        }
    },

    // ==========================================
    // 1. TRANSMITTER ENGINE (TX - Single-Tone FSK)
    // ==========================================

    playTone: function(frequency, durationMs) {
        if (!this.audioCtx) return;

        const now = this.audioCtx.currentTime;
        const durationSec = durationMs / 1000;
        
        const oscillator = this.audioCtx.createOscillator();
        const gainNode = this.audioCtx.createGain();

        oscillator.type = 'sine';
        oscillator.frequency.value = frequency;

        // Smooth gain envelope to prevent clicking
        gainNode.gain.setValueAtTime(0, now);
        gainNode.gain.linearRampToValueAtTime(0.8, now + 0.002);
        gainNode.gain.setValueAtTime(0.8, now + durationSec - 0.002);
        gainNode.gain.linearRampToValueAtTime(0, now + durationSec);

        oscillator.connect(gainNode);
        gainNode.connect(this.audioCtx.destination);

        oscillator.start(now);
        oscillator.stop(now + durationSec);
    },

    transmitPayload: async function(payloadBytes) {
        if (!this.audioCtx) this.init();

        console.log(`[TX] Initiating single-lane FSK transmission: ${payloadBytes.length} bytes...`);

        // 1. Transmit START Marker (19.5kHz)
        this.playTone(this.START_FREQ, 150);
        await this.sleep(170);

        // 2. Transmit Payload Bit-by-Bit
        for (let i = 0; i < payloadBytes.length; i++) {
            const byte = payloadBytes[i];
            
            for (let b = 7; b >= 0; b--) {
                const bit = (byte >> b) & 1;
                const targetFreq = (bit === 1) ? this.FREQ_1 : this.FREQ_0;
                
                this.playTone(targetFreq, this.BAUD_RATE);
                await this.sleep(this.BAUD_RATE);
            }
        }

        // 3. Transmit END Marker (19.8kHz)
        await this.sleep(50);
        this.playTone(this.END_FREQ, 150);
        console.log("[TX] Transmission complete. END marker emitted.");
    },

    // ==========================================
    // 2. RECEIVER ENGINE (RX - Single-Lane Demodulation)
    // ==========================================

    startReceiver: async function(onDataComplete) {
        if (!this.audioCtx) this.init();
        if (this.isListening) return;

        try {
            // FIX 1: Request RAW audio. Disable all browser filters that destroy ultrasonic data.
            this.micStream = await navigator.mediaDevices.getUserMedia({ 
                audio: {
                    echoCancellation: false,
                    noiseSuppression: false,
                    autoGainControl: false
                }, 
                video: false 
            });
            
            const source = this.audioCtx.createMediaStreamSource(this.micStream);

            this.analyser = this.audioCtx.createAnalyser();
            this.analyser.fftSize = 2048; 
            source.connect(this.analyser);

            this.isListening = true;
            console.log("[RX] Mic buffer online (RAW AUDIO). Listening for FSK chirps...");

            this.listenLoop(onDataComplete);
        } catch (err) {
            console.error("[RX] Failed to access microphone:", err);
        }
    },


    /**
     * Scans a target frequency band (+/- toleranceHz) and returns peak magnitude.
     */
    getMagnitudeAtFreqRange: function(dataArray, targetFreq, toleranceHz = 100) {
        const sampleRate = this.audioCtx.sampleRate;
        const minFreq = targetFreq - toleranceHz;
        const maxFreq = targetFreq + toleranceHz;

        const startBin = Math.floor((minFreq * this.analyser.fftSize) / sampleRate);
        const endBin = Math.ceil((maxFreq * this.analyser.fftSize) / sampleRate);

        let maxMagnitude = 0;
        for (let i = startBin; i <= endBin; i++) {
            if (dataArray[i] > maxMagnitude) {
                maxMagnitude = dataArray[i];
            }
        }
        return maxMagnitude;
    },

    listenLoop: function(onDataComplete) {
        const bufferLength = this.analyser.frequencyBinCount;
        const dataArray = new Uint8Array(bufferLength);

        let receivingFrame = false;
        let receivedBits = [];
        let lastBitTime = 0;

        const pollAudio = () => {
            if (!this.isListening) return;

            this.analyser.getByteFrequencyData(dataArray);

            const sampleRate = this.audioCtx.sampleRate;
            const fftSize = this.analyser.fftSize;

            // Helper to get peak volume in a frequency range dynamically
            const getPeakInRange = (targetFreq, radiusHz = 400) => {
                const minBin = Math.max(0, Math.floor(((targetFreq - radiusHz) * fftSize) / sampleRate));
                const maxBin = Math.min(bufferLength - 1, Math.ceil(((targetFreq + radiusHz) * fftSize) / sampleRate));
                
                let maxVal = 0;
                for (let i = minBin; i <= maxBin; i++) {
                    if (dataArray[i] > maxVal) maxVal = dataArray[i];
                }
                return maxVal;
            };

            // Measure magnitudes with a wide 400Hz search window
            const startMag = getPeakInRange(this.START_FREQ, 400);
            const endMag   = getPeakInRange(this.END_FREQ, 400);

            // LOWER THRESHOLD TO 40 FOR GATE 1 TESTING
            const SENSITIVITY_THRESHOLD = 40; 

            // Live Log to Console so you can see the microphone reacting
            if (startMag > 20) {
                console.log(`[Mic Live] Hearing ~19.5kHz at Amplitude: ${startMag}`);
            }

            // 1. DETECT START MARKER
            if (!receivingFrame && startMag > SENSITIVITY_THRESHOLD) {
                receivingFrame = true;
                receivedBits = [];
                console.log(`%c[RX] 🎯 PREAMBLE LOCKED! Amplitude: ${startMag}`, "color: #7ed321; font-weight: bold; font-size: 14px;");
            }

            // 2. PARSE BITS SEQUENTIALLY
            if (receivingFrame) {
                const now = Date.now();

                if (now - lastBitTime >= this.BAUD_RATE) {
                    const mag0 = getPeakInRange(this.FREQ_0, 200);
                    const mag1 = getPeakInRange(this.FREQ_1, 200);

                    if (mag0 > SENSITIVITY_THRESHOLD || mag1 > SENSITIVITY_THRESHOLD) {
                        const bit = (mag1 > mag0) ? 1 : 0;
                        receivedBits.push(bit);
                        lastBitTime = now;
                    }
                }

                // 3. DETECT END MARKER
                if (endMag > SENSITIVITY_THRESHOLD && receivedBits.length > 0) {
                    receivingFrame = false;
                    console.log(`%c[RX] 🏁 END FREQUENCY DETECTED! Total bits parsed: ${receivedBits.length}`, "color: #0ea5e9; font-weight: bold;");

                    const finalBytes = this.reconstructBytesFromBits(receivedBits);
                    this.stopReceiver();

                    if (onDataComplete) onDataComplete(finalBytes);
                    return;
                }
            }

            requestAnimationFrame(pollAudio);
        };

        pollAudio();
    },

    reconstructBytesFromBits: function(bits) {
        const bytes = [];
        for (let i = 0; i < bits.length; i += 8) {
            if (i + 8 <= bits.length) {
                let byte = 0;
                for (let b = 0; b < 8; b++) {
                    byte = (byte << 1) | bits[i + b];
                }
                bytes.push(byte);
            }
        }
        return new Uint8Array(bytes);
    },

    stopReceiver: function() {
        this.isListening = false;
        if (this.micStream) {
            this.micStream.getTracks().forEach(track => track.stop());
        }
        console.log("[RX] Receiver stopped.");
    },

    sleep: function(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
};