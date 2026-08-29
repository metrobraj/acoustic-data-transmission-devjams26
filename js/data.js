// js/data.js

const DataPipeline = {
    compressPayload: function(payloadText) {
        const encoder = new TextEncoder();
        const rawBytes = encoder.encode(payloadText);
        
        // Compress using pako
        const compressedBytes = pako.deflate(rawBytes);
        
        // SMART CHECK: Only use compressed version if it actually saved space
        if (compressedBytes.length < rawBytes.length) {
            console.log(`[Compression Active] Shrunk from ${rawBytes.length} to ${compressedBytes.length} bytes.`);
            // Return array with a flag byte (0x01 = Compressed)
            const result = new Uint8Array(compressedBytes.length + 1);
            result[0] = 1; 
            result.set(compressedBytes, 1);
            return result;
        } else {
            console.log(`[Raw Payload Kept] Original (${rawBytes.length}B) was smaller than compressed (${compressedBytes.length}B).`);
            // Return raw array with a flag byte (0x00 = Uncompressed)
            const result = new Uint8Array(rawBytes.length + 1);
            result[0] = 0; 
            result.set(rawBytes, 1);
            return result;
        }
    },

    decompressPayload: function(payloadBytes) {
        const isCompressed = payloadBytes[0] === 1;
        const actualData = payloadBytes.subarray(1);
        const decoder = new TextDecoder();

        if (isCompressed) {
            const decompressed = pako.inflate(actualData);
            return decoder.decode(decompressed);
        } else {
            return decoder.decode(actualData);
        }
    }
};