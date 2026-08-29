// js/data.js

const DataPipeline = {
    /**
     * Accepts a Uint8Array and compresses it using fflate.
     * Returns a Uint8Array prefixed with a 1-byte header flag.
     * @param {Uint8Array} rawBytes
     * @returns {Uint8Array}
     */
    compressPayload: function(rawBytes) {
        // Synchronous DEFLATE compression via fflate
        const compressedBytes = fflate.deflateSync(rawBytes, { level: 9 });
        
        // SMART CHECK: Only send compressed version if it actually saved space
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
     * Decompresses an incoming Uint8Array back to raw file bytes.
     * @param {Uint8Array} payloadBytes
     * @returns {Uint8Array}
     */
    decompressPayload: function(payloadBytes) {
        try {
            const isCompressed = payloadBytes[0] === 1;
            const actualData = payloadBytes.subarray(1);

            if (isCompressed) {
                return fflate.inflateSync(actualData);
            } else {
                return actualData;
            }
        } catch (error) {
            console.error("Decompression failed. Audio frame corrupted.", error);
            return null;
        }
    }
};