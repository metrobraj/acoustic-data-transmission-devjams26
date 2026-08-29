// js/audio.js - WebAssembly Acoustic Modem powered by ggwave

const AudioPipeline = {
    audioCtx: null,
    analyser: null,
    ggwave: null,
    ggwaveInstance: null,
    micStream: null,
    isListening: false,

    init: async function() {
        if (!this.audioCtx) {
            this.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        }
        if (!this.ggwave) {
            // Load WebAssembly module
            this.ggwave = await ggwave_factory();
            this.ggwaveInstance = this.ggwave.init({
                sampleRate: this.audioCtx.sampleRate,
                soundMarkerThreshold: 4
            });
            console.log("[Audio] ggwave WASM Engine initialized.");
        }
    },

    // ==========================================
    // 1. TRANSMITTER ENGINE (ggwave WASM)
    // ==========================================
    transmitPayload: async function(payloadBytes) {
        await this.init();
        console.log(`[TX] Encoding ${payloadBytes.length} bytes via ggwave WASM...`);

        // Generate audio waveform with Reed-Solomon Error Correction & CRC
        const waveform = this.ggwave.encode(
            this.ggwaveInstance, 
            payloadBytes, 
            this.ggwave.ProtocolId.GGWAVE_TX_PROTOCOL_ULTRASOUND_FAST,
            10 // Volume level (1-100)
        );

        if (!waveform || waveform.length === 0) {
            console.error("[TX] Failed to encode waveform.");
            return;
        }

        // Play generated waveform through Web Audio API
        const audioBuffer = this.audioCtx.createBuffer(1, waveform.length, this.audioCtx.sampleRate);
        audioBuffer.getChannelData(0).set(waveform);

        const source = this.audioCtx.createBufferSource();
        source.buffer = audioBuffer;

        // Route through Analyser Node for visualizer support
        if (!this.analyser) {
            this.analyser = this.audioCtx.createAnalyser();
            this.analyser.fftSize = 2048;
        }
        source.connect(this.analyser);
        this.analyser.connect(this.audioCtx.destination);

        source.start();
        
        // Wait until audio finishes playing
        const durationMs = (waveform.length / this.audioCtx.sampleRate) * 1000;
        await this.sleep(durationMs + 100);
        console.log("[TX] Transmission complete.");
    },

    // ==========================================
    // 2. RECEIVER ENGINE (ggwave WASM)
    // ==========================================
    startReceiver: async function(onDataComplete) {
        await this.init();
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

            // Create processor to feed live PCM frames directly into ggwave WASM decoder
            const processor = this.audioCtx.createScriptProcessor(1024, 1, 1);
            source.connect(processor);
            processor.connect(this.audioCtx.destination);

            this.isListening = true;
            console.log("[RX] Listening for robust ultrasound chirps...");

            processor.onaudioprocess = (evt) => {
                if (!this.isListening) return;

                const inputData = evt.inputBuffer.getChannelData(0);
                
                // Convert PCM Float32 frame into Int8 array for C++ decoder
                const pcmInt8 = new Int8Array(inputData.length * 2);
                for (let i = 0; i < inputData.length; i++) {
                    const s = Math.max(-1, Math.min(1, inputData[i]));
                    const val = s < 0 ? s * 0x8000 : s * 0x7FFF;
                    pcmInt8[i * 2] = val & 0xFF;
                    pcmInt8[i * 2 + 1] = (val >> 8) & 0xFF;
                }

                // Decode audio frames through WebAssembly
                const res = this.ggwave.decode(this.ggwaveInstance, pcmInt8);
                
                // Trigger callback only when payload passes 16-bit CRC check
                if (res && res.length > 0) {
                    console.log("[RX] Payload decoded and verified via CRC!");
                    this.stopReceiver();
                    processor.disconnect();
                    if (onDataComplete) onDataComplete(res);
                }
            };
        } catch (err) {
            console.error("[RX] Mic setup failed:", err);
        }
    },

    stopReceiver: function() {
        this.isListening = false;
        if (this.micStream) this.micStream.getTracks().forEach(track => track.stop());
    },

    sleep: function(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
};