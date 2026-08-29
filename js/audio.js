// js/audio.js - Unified Transmitter & Receiver Audio Pipeline

const AudioPipeline = {
    audioCtx: null,
    analyser: null,
    isListening: false,
    
    // Frequencies mapped for hackathon MVP (staying in the 17.5 - 19.5kHz safe zone)[cite: 7]
    FREQ_0: 17500,        // Represents a binary '0'[cite: 7]
    FREQ_1: 18500,        // Represents a binary '1'[cite: 7]
    PREAMBLE_FREQ: 19500, // Used to wake up the receiver[cite: 7]
    BAUD_RATE: 50,        // Milliseconds per bit (Speed of transmission)[cite: 7]

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
     * Converts a Uint8Array into a sequence of audio tones (Modulation).
     */
    transmitPayload: async function(payloadBytes) {
        if (!this.audioCtx) this.init();
        
        console.log(`Starting acoustic transmission of ${payloadBytes.length} bytes...`);

        this.playTone(this.PREAMBLE_FREQ, 200);
        await this.sleep(200);

        for (let i = 0; i < payloadBytes.length; i++) {
            let byte = payloadBytes[i];
            
            for (let b = 7; b >= 0; b--) {
                const bit = (byte >> b) & 1;
                const targetFreq = bit === 1 ? this.FREQ_1 : this.FREQ_0;
                
                this.playTone(targetFreq, this.BAUD_RATE);
                await this.sleep(this.BAUD_RATE);
            }
        }
        console.log("Transmission complete.");
    },

    /**
     * Initialize Audio Context and Request Microphone Access for Receiver
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
            this.analyser.fftSize = 2048;
            
            source.connect(this.analyser);
            this.isListening = true;
            
            console.log("MIC BUFFER OPEN: Listening for near-ultrasonic chirps (17kHz - 20kHz)...");
            this.startListeningLoop();
            
            return true;
        } catch (err) {
            console.error("Microphone access denied or unsupported:", err);
            alert("Microphone permission is required to receive acoustic data.");
            return false;
        }
    },

    /**
     * Continuous FFT Frequency Polling Loop
     */
    startListeningLoop: function() {
        const bufferLength = this.analyser.frequencyBinCount;
        const dataArray = new Uint8Array(bufferLength);
        
        const evaluateSpectrum = () => {
            if (!this.isListening) return;

            this.analyser.getByteFrequencyData(dataArray);

            const nyquist = this.audioCtx.sampleRate / 2;
            const targetMinBin = Math.floor(17000 * bufferLength / nyquist);
            const targetMaxBin = Math.floor(20000 * bufferLength / nyquist);

            let peakVolume = 0;
            let peakBin = -1;

            for (let i = targetMinBin; i <= targetMaxBin; i++) {
                if (dataArray[i] > peakVolume) {
                    peakVolume = dataArray[i];
                    peakBin = i;
                }
            }

            if (peakVolume > 180) {
                const detectedFrequency = (peakBin * nyquist) / bufferLength;
                console.log(`Chirp detected ~${detectedFrequency.toFixed(1)} Hz | Amplitude: ${peakVolume}`);
            }

            requestAnimationFrame(evaluateSpectrum);
        };

        evaluateSpectrum();
    },

    sleep: function(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
};

// Expose globally so app.js can access it safely
window.AudioPipeline = AudioPipeline;