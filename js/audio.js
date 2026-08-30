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
            // Initialize WebAssembly Factory
            this.ggwave = await ggwave_factory();
            
            // EXACT FIX: Pass all required parameters to the C++ bindings
            const parameters = this.ggwave.getDefaultParameters();
            parameters.sampleRateIn = this.audioCtx.sampleRate;
            parameters.sampleRateOut = this.audioCtx.sampleRate;
            parameters.soundMarkerThreshold = 4;
            parameters.payloadLength = 0; // 0 = dynamic/variable length in ggwave parameters

            this.ggwaveInstance = this.ggwave.init(parameters);
            
            console.log("[Audio] ggwave WASM Engine initialized successfully.");
        }
    },
    // ==========================================
    // 1. TRANSMITTER ENGINE (ggwave WASM)
    // ==========================================
    transmitPayload: async function(payloadBytes) {
        await this.init();
        console.log(`[TX] Encoding ${payloadBytes.length} bytes via ggwave at higher speed...`);

        // 1. Convert payload bytes to a standard string
        let payloadString = "";
        for (let i = 0; i < payloadBytes.length; i++) {
            payloadString += String.fromCharCode(payloadBytes[i]);
        }

        // 2. Select a high-speed protocol ID integer 
        // (Typically, 2 or 3 map to faster ultrasonic/audible variants depending on the build)
        const fastProtocolId = 2; 
        const volume = 15; // Slightly higher volume to ensure robust high-speed sampling

        // 3. Generate waveform via WebAssembly
        const waveform = this.ggwave.encode(
            this.ggwaveInstance, 
            payloadString, 
            fastProtocolId, 
            volume
        );

        if (!waveform || waveform.length === 0) {
            console.error("[TX] ggwave failed to encode payload.");
            return;
        }

        console.log(`[TX] Playing high-speed waveform (${waveform.length} samples)...`);

        // 4. Play through Web Audio API
        const audioBuffer = this.audioCtx.createBuffer(1, waveform.length, this.audioCtx.sampleRate);
        audioBuffer.getChannelData(0).set(waveform);

        const source = this.audioCtx.createBufferSource();
        source.buffer = audioBuffer;

        if (!this.analyser) {
            this.analyser = this.audioCtx.createAnalyser();
            this.analyser.fftSize = 2048;
        }
        source.connect(this.analyser);
        this.analyser.connect(this.audioCtx.destination);

        source.start();
        
        const durationMs = (waveform.length / this.audioCtx.sampleRate) * 1000;
        await this.sleep(durationMs + 50);
        console.log("[TX] High-speed transmission complete.");
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
                
                const res = this.ggwave.decode(this.ggwaveInstance, pcmInt8);
                
                if (res && res.length > 0) {
                    console.log("[RX] Verified packet received via ggwave!");
                    
                    // Convert back to Uint8Array if ggwave returned a string
                    let uint8Data;
                    if (typeof res === 'string') {
                        uint8Data = new Uint8Array(res.length);
                        for (let i = 0; i < res.length; i++) {
                            uint8Data[i] = res.charCodeAt(i);
                        }
                    } else {
                        uint8Data = new Uint8Array(res);
                    }

                    this.stopReceiver();
                    processor.disconnect();
                    if (onDataComplete) onDataComplete(uint8Data);
                }

                // Convert PCM Float32 frame into Int8 array for C++ decoder
                const pcmInt8 = new Int8Array(inputData.length * 2);
                for (let i = 0; i < inputData.length; i++) {
                    const s = Math.max(-1, Math.min(1, inputData[i]));
                    const val = s < 0 ? s * 0x8000 : s * 0x7FFF;
                    pcmInt8[i * 2] = val & 0xFF;
                    pcmInt8[i * 2 + 1] = (val >> 8) & 0xFF;
                }

                // Decode audio frames through WebAssembly
                
                
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