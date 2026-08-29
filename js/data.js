// // js/data.js

// const DataPipeline = {
//     compressPayload: function(payloadText) {
//         const encoder = new TextEncoder();
//         const rawBytes = encoder.encode(payloadText);
        
//         // Compress using pako
//         const compressedBytes = pako.deflate(rawBytes);
        
//         // SMART CHECK: Only use compressed version if it actually saved space
//         if (compressedBytes.length < rawBytes.length) {
//             console.log(`[Compression Active] Shrunk from ${rawBytes.length} to ${compressedBytes.length} bytes.`);
//             // Return array with a flag byte (0x01 = Compressed)
//             const result = new Uint8Array(compressedBytes.length + 1);
//             result[0] = 1; 
//             result.set(compressedBytes, 1);
//             return result;
//         } else {
//             console.log(`[Raw Payload Kept] Original (${rawBytes.length}B) was smaller than compressed (${compressedBytes.length}B).`);
//             // Return raw array with a flag byte (0x00 = Uncompressed)
//             const result = new Uint8Array(rawBytes.length + 1);
//             result[0] = 0; 
//             result.set(rawBytes, 1);
//             return result;
//         }
//     },

//     decompressPayload: function(payloadBytes) {
//         const isCompressed = payloadBytes[0] === 1;
//         const actualData = payloadBytes.subarray(1);
//         const decoder = new TextDecoder();

//         if (isCompressed) {
//             const decompressed = pako.inflate(actualData);
//             return decoder.decode(decompressed);
//         } else {
//             return decoder.decode(actualData);
//         }
//     }
// };

// js/data.js

const DataPipeline = {
    /**
     * Converts text to a Uint8Array and compresses using fflate.
     * Includes a 1-byte flag header to prevent small payload expansion.
     */
    compressPayload: function(payloadText) {
        const encoder = new TextEncoder();
        const rawBytes = encoder.encode(payloadText);
        
        // fflate synchronous DEFLATE compression
        const compressedBytes = fflate.deflateSync(rawBytes, { level: 9 });
        
        // SMART CHECK: Only send compressed data if it actually saved space
        if (compressedBytes.length < rawBytes.length) {
            console.log(`[fflate Active] Shrunk from ${rawBytes.length}B to ${compressedBytes.length}B.`);
            const result = new Uint8Array(compressedBytes.length + 1);
            result[0] = 1; // Flag 1 = Compressed
            result.set(compressedBytes, 1);
            return result;
        } else {
            console.log(`[Raw Kept] Original (${rawBytes.length}B) was smaller than compressed (${compressedBytes.length}B).`);
            const result = new Uint8Array(rawBytes.length + 1);
            result[0] = 0; // Flag 0 = Uncompressed
            result.set(rawBytes, 1);
            return result;
        }
    },

    /**
     * Inflates/Decompresses incoming binary arrays back into readable text.
     */
    decompressPayload: function(payloadBytes) {
        try {
            const isCompressed = payloadBytes[0] === 1;
            const actualData = payloadBytes.subarray(1);
            const decoder = new TextDecoder();

            if (isCompressed) {
                // fflate synchronous INFLATE decompression
                const decompressedBytes = fflate.inflateSync(actualData);
                return decoder.decode(decompressedBytes);
            } else {
                return decoder.decode(actualData);
            }
        } catch (error) {
            console.error("Decompression failed. Audio frame corrupted.", error);
            return null;
        }
    }
};