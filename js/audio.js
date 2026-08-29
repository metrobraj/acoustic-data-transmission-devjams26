// js/audio.js - Unified Transmitter & Gate-1 Receiver Pipeline

const AudioPipeline = {
    audioCtx: null,
    analyser: null,
    isListening: false,
    
    // Frequencies mapped for hackathon MVP (17kHz - 20kHz safe zone)[cite: 3]
    FREQ_0: 17500,        // Represents a binary '0'
    FREQ_1: 18500,        // Represents a binary '1'
    PREAMBLE_FREQ: 19500, // Synchronisation wake-up tone[cite: 3]
    BAUD_RATE: 50,        // Milliseconds per bit

    /**
     * Initializes the Web Audio API Context. 
     */
    init: function() {
        if (!this.audioCtx) {
            this.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
            console.log("AudioContext initialized with sample rate:", this.audioCtx.sampleRate);
        }
    },

    /**
     * Plays a specific frequency for a set duration.
     */
    playTone: function(frequency, durationMs) {
        if (!this.audioCtx) this.init();

        const oscillator = this.audioCtx.createOscillator();
        const gainNode = this.audioCtx.createGain();

        oscillator.type = 'sine';
        oscillator.frequency.value = frequency;

        // Smooth amplitude envelope to prevent speaker clicking
        gainNode.gain.setValueAtTime(0, this.audioCtx.currentTime);
        gainNode.gain.linearRampToValueAtTime(1, this.audioCtx.currentTime + 0.01);
        gainNode.gain.setValueAtTime(1, this.audioCtx.currentTime + (durationMs / 1000) - 0.01);
        gainNode.gain.linearRampToValueAtTime(0, this.audioCtx.currentTime + (durationMs / 1000));

        oscillator.connect(gainNode);
        gainNode.connect(this.audioCtx.destination);

        oscillator.start();
        oscillator.stop(this.audioCtx.currentTime + (durationMs / 1000));
    },

    /**
     * Transmits a payload with a synchronised preamble tone[cite: 3].
     */
    transmitPayload: async function(payloadBytes) {
        if (!this.audioCtx) this.init();
        
        console.log(`[TX] Starting acoustic transmission of ${payloadBytes.length} bytes...`);

        // 1. Play the Preamble Tone to wake up receiver
        console.log(`[TX] Broadcasting Preamble at ${this.PREAMBLE_FREQ}Hz...`);
        this.playTone(this.PREAMBLE_FREQ, 300);
        await this.sleep(300);

        // 2. Transmit data bit-by-bit
        for (let i = 0; i < payloadBytes.length; i++) {
            let byte = payloadBytes[i];
            for (let b = 7; b >= 0; b--) {
                const bit = (byte >> b) & 1;
                const targetFreq = bit === 1 ? this.FREQ_1 : this.FREQ_0;
                
                this.playTone(targetFreq, this.BAUD_RATE);
                await this.sleep(this.BAUD_RATE);
            }
        }
        console.log("[TX] Transmission complete.");
    },

    /**
     * Opens the microphone buffer to listen for incoming chirps.
     */
    initReceiver: async function() {
        try {
            if (!this.audioCtx) this.init();
            
            const stream = await navigator.mediaDevices.getUserMedia({ 
                audio: { 
                    echoCancellation: false, 
                    noiseSuppression: false, 
                    autoGainControl: false 
                } 
            });

            const source = this.audioCtx.createMediaStreamSource(stream);
            this.analyser = this.audioCtx.createAnalyser();
            this.analyser.fftSize = 2048; // High resolution frequency bins
            
            source.connect(this.analyser);
            this.isListening = true;
            
            console.log("[RX] MIC BUFFER OPEN: Listening for Preamble (19.5kHz)...");
            this.startListeningLoop();
            
            return true;
        } catch (err) {
            console.error("[RX] Microphone access denied or unsupported:", err);
            alert("Microphone permission is required to receive acoustic data.");
            return false;
        }
    },

    /**
     * Continuous FFT Frequency Polling Loop (Gate 1 Focus)
     */
    startListeningLoop: function() {
        const bufferLength = this.analyser.frequencyBinCount;
        const dataArray = new Uint8Array(bufferLength);
        
        let preambleDetectedCount = 0;

        const evaluateSpectrum = () => {
            if (!this.isListening) return;

            this.analyser.getByteFrequencyData(dataArray);

            // Calculate exact FFT bin corresponding to our Preamble Frequency (19500 Hz)
            const sampleRate = this.audioCtx.sampleRate;
            const binWidth = sampleRate / this.analyser.fftSize;
            const targetBin = Math.round(this.PREAMBLE_FREQ / binWidth);

            // Check the amplitude of the exact preamble bin
            const preambleAmplitude = dataArray[targetBin] || 0;

            // Threshold set high enough to ignore routine room background noise
            if (preambleAmplitude > 200) {
                preambleDetectedCount++;
                console.warn(`[RX] 🎯 PREAMBLE LOCKED! Frequency: ~${this.PREAMBLE_FREQ}Hz | Amplitude: ${preambleAmplitude} | Hits: ${preambleDetectedCount}`);
                
                // Visual feedback update on UI if status dot exists
                const statusDot = document.getElementById('statusDot');
                if (statusDot) statusDot.className = "dot active";
            }

            requestAnimationFrame(evaluateSpectrum);
        };

        evaluateSpectrum();
    },

    sleep: function(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
};

window.AudioPipeline = AudioPipeline;