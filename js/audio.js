// js/audio.js

const AudioPipeline = {
    audioCtx: null,
    
    // Frequencies mapped for hackathon MVP (staying in the 17.5 - 19.5kHz safe zone)
    FREQ_0: 17500, // Represents a binary '0'
    FREQ_1: 18500, // Represents a binary '1'
    PREAMBLE_FREQ: 19500, // Used to wake up the receiver
    BAUD_RATE: 50, // Milliseconds per bit (Speed of transmission)

    /**
     * Initializes the Web Audio API Context. 
     * MUST be called via a user click event to bypass browser auto-play policies.
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
        if (!this.audioCtx) return;

        const oscillator = this.audioCtx.createOscillator();
        const gainNode = this.audioCtx.createGain();

        // Use a sine wave for the cleanest acoustic signal
        oscillator.type = 'sine';
        oscillator.frequency.value = frequency;

        // Smooth amplitude envelope to prevent speaker clicking/popping
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
     * @param {Uint8Array} payloadBytes - The compressed data from data.js
     */
    transmitPayload: async function(payloadBytes) {
        if (!this.audioCtx) this.init();
        
        console.log(`Starting acoustic transmission of ${payloadBytes.length} bytes...`);

        // 1. Play the Preamble (Wake-up signal for the receiver)
        this.playTone(this.PREAMBLE_FREQ, 200);
        await this.sleep(200);

        // 2. Transmit the data bit-by-bit (Simplified FSK for MVP)
        for (let i = 0; i < payloadBytes.length; i++) {
            let byte = payloadBytes[i];
            
            // Loop through all 8 bits of the byte
            for (let b = 7; b >= 0; b--) {
                const bit = (byte >> b) & 1;
                const targetFreq = bit === 1 ? this.FREQ_1 : this.FREQ_0;
                
                this.playTone(targetFreq, this.BAUD_RATE);
                
                // Wait for the tone to finish before playing the next
                await this.sleep(this.BAUD_RATE);
            }
        }
        console.log("Transmission complete.");
    },

    // Helper function for timing
    sleep: function(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
};