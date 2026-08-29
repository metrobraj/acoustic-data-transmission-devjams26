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
        console.log(`[TX] Encoding ${payloadBytes.length} bytes via ggwave WASM...`);

        // 1. Ensure payload is a clean, standard binary string
        let payloadString = "";
        for (let i = 0; i < payloadBytes.length; i++) {
            payloadString += String.fromCharCode(payloadBytes[i]);
        }

        // 2. Fetch or fallback Protocol ID as an explicit integer
        // Protocol 1 = GGWAVE_PROTOCOL_ULTRASOUND_FAST
        // Protocol 0 = GGWAVE_PROTOCOL_AUDIBLE_FAST (Fallback if ultrasound isn't supported)
        let protocolId = 1; 
        if (this.ggwave.ProtocolId && this.ggwave.ProtocolId.GGWAVE_PROTOCOL_ULTRASOUND_FAST !== undefined) {
            protocolId = this.ggwave.ProtocolId.GGWAVE_PROTOCOL_ULTRASOUND_FAST;
        } else if (this.ggwave.TxProtocolId && this.ggwave.TxProtocolId.GGWAVE_TX_PROTOCOL_ULTRASOUND_FAST !== undefined) {
            protocolId = this.ggwave.TxProtocolId.GGWAVE_TX_PROTOCOL_ULTRASOUND_FAST;
        }

        // 3. Force integer types explicitly using Math.floor or parseInt
        const instance = this.ggwaveInstance;
        const volume = 10; // Integer 1-100

        console.log(`[TX] Calling ggwave.encode with Protocol ID: ${protocolId}`);

        // 4. Generate audio waveform
        const waveform = this.ggwave.encode(
            instance, 
            payloadString, 
            protocolId, 
            volume
        );

        if (!waveform || waveform.length === 0) {
            console.error("[TX] Failed to encode waveform: ggwave returned an empty array.");
            return;
        }

        console.log(`[TX] Playing waveform of ${waveform.length} audio samples...`);

        // 5. Play audio via Web Audio API
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