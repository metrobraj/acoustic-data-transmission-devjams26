// js/data.js
const pako = require('pako');
const DataPipeline = {
    /**
     * Converts a string to a binary array and compresses it.
     * @param {string} payloadText - The message to send.
     * @returns {Uint8Array} - The compressed binary data ready for audio modulation.
     */
    compressPayload: function(payloadText) {
        // 1. Convert text to a Uint8Array
        const encoder = new TextEncoder();
        const rawBytes = encoder.encode(payloadText);
        
        // 2. Compress the bytes using DEFLATE
        const compressedBytes = pako.deflate(rawBytes);
        
        // Log the compression ratio to the console for your demo
        console.log(`Payload shrunk from ${rawBytes.length} to ${compressedBytes.length} bytes.`);
        
        return compressedBytes;
    },

    /**
     * Inflates a compressed binary array back into readable text.
     * @param {Uint8Array} compressedBytes - The data received from the microphone.
     * @returns {string} - The decoded original message.
     */
    decompressPayload: function(compressedBytes) {
        try {
            // 1. Inflate the binary data
            const decompressedBytes = pako.inflate(compressedBytes);
            
            // 2. Convert binary back to string
            const decoder = new TextDecoder();
            return decoder.decode(decompressedBytes);
        } catch (error) {
            console.error("Decompression failed. The audio packet might be corrupted.", error);
            return null;
        }
    }
};

// // --- RUN TEST ---
// const testMessage = "Hello World! This is an air-gapped transmission test for AirChirp. Repeating text compresses exceptionally well in DEFLATE!";
// console.log("Input Text:", testMessage);
// console.log("--------------------------------------------------");

// const compressed = DataPipeline.compressPayload(testMessage);
// const decompressed = DataPipeline.decompressPayload(compressed);

// console.log("--------------------------------------------------");
// console.log("Output Text:", decompressed);
// console.log("Test Passed:", testMessage === decompressed);

