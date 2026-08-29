// js/data.js - Payload Compression & Decompression

const DataPipeline = {
    /**
     * Compress payload bytes using fflate DEFLATE
     * Returns Uint8Array with 1-byte header flag + compressed/raw data
     */
    compressPayload: function(rawBytes) {
        try {
            // Use fflate's synchronous deflate
            const compressedBytes = fflate.deflateSync(rawBytes, { level: 9 });

            // Smart check: only use compressed version if it saves space
            if (compressedBytes.length < rawBytes.length) {
                console.log(`%c[Compress] Shrunk from ${rawBytes.length}B → ${compressedBytes.length}B (${((compressedBytes.length / rawBytes.length) * 100).toFixed(1)}%)`, "color: #10b981; font-weight: bold;");

                const result = new Uint8Array(compressedBytes.length + 1);
                result[0] = 1; // Flag: 1 = Compressed
                result.set(compressedBytes, 1);
                return result;
            } else {
                console.log(`%c[Compress] Kept raw. Original (${rawBytes.length}B) ≤ Compressed (${compressedBytes.length}B)`, "color: #f59e0b; font-weight: bold;");

                const result = new Uint8Array(rawBytes.length + 1);
                result[0] = 0; // Flag: 0 = Uncompressed
                result.set(rawBytes, 1);
                return result;
            }
        } catch (error) {
            console.error("[Compress] Error during compression:", error);
            // Fallback: send uncompressed
            const result = new Uint8Array(rawBytes.length + 1);
            result[0] = 0;
            result.set(rawBytes, 1);
            return result;
        }
    },

    /**
     * Decompress payload bytes from receiver
     * Reads 1-byte header flag, then processes accordingly
     */
    decompressPayload: function(payloadBytes) {
        try {
            if (!payloadBytes || payloadBytes.length < 1) {
                console.error("[Decompress] Empty payload!");
                return null;
            }

            const isCompressed = payloadBytes[0] === 1;
            const actualData = payloadBytes.subarray(1);

            if (isCompressed) {
                const decompressed = fflate.inflateSync(actualData);
                console.log(`%c[Decompress] Decompressed ${actualData.length}B → ${decompressed.length}B`, "color: #10b981; font-weight: bold;");
                return decompressed;
            } else {
                console.log(`%c[Decompress] Raw data, no decompression needed. Size: ${actualData.length}B`, "color: #6b7280; font-weight: bold;");
                return actualData;
            }
        } catch (error) {
            console.error("[Decompress] Decompression failed! Audio frame corrupted or invalid.", error);
            return null;
        }
    }
};