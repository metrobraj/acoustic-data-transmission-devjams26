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

    BAUD_RATE: 15,       // Symbol duration per bit (ms)

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
            this.micStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
            const source = this.audioCtx.createMediaStreamSource(this.micStream);

            this.analyser = this.audioCtx.createAnalyser();
            this.analyser.fftSize = 2048; // Resolves ~23.4Hz per bin
            source.connect(this.analyser);

            this.isListening = true;
            console.log("[RX] Mic buffer online. Listening for FSK chirps...");

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

            // Calculate dynamic noise floor threshold
            const averageNoise = dataArray.reduce((a, b) => a + b, 0) / dataArray.length;
            const dynamicThreshold = Math.max(90, averageNoise * 1.6); // Floor of 90, or 60% above background noise

            // Read markers with +/- 120Hz tolerance
            const startMag = this.getMagnitudeAtFreqRange(dataArray, this.START_FREQ, 120);
            const endMag   = this.getMagnitudeAtFreqRange(dataArray, this.END_FREQ, 120);

            // 1. DETECT START MARKER
            if (!receivingFrame && startMag > dynamicThreshold) {
                receivingFrame = true;
                receivedBits = [];
                console.log("%c[RX] DETECTED START FREQUENCY (19.5kHz)!", "color: #7ed321; font-weight: bold;");
            }

            // 2. PARSE BITS SEQUENTIALLY
            if (receivingFrame) {
                const now = Date.now();

                if (now - lastBitTime >= this.BAUD_RATE) {
                    const mag0 = this.getMagnitudeAtFreqRange(dataArray, this.FREQ_0, 80);
                    const mag1 = this.getMagnitudeAtFreqRange(dataArray, this.FREQ_1, 80);

                    // Determine if a bit frequency peak is present above threshold
                    if (mag0 > dynamicThreshold || mag1 > dynamicThreshold) {
                        const bit = (mag1 > mag0) ? 1 : 0;
                        receivedBits.push(bit);
                        lastBitTime = now;
                    }
                }

                // 3. DETECT END MARKER
                if (endMag > dynamicThreshold && receivedBits.length > 0) {
                    receivingFrame = false;
                    console.log("%c[RX] DETECTED END FREQUENCY (19.8kHz)! Assembling bytes...", "color: #0ea5e9; font-weight: bold;");

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