const zlib = require('zlib');

function testCompression() {
    const testMessage = "Hello World! AirChirp near-ultrasonic test message. AirChirp near-ultrasonic test message.";
    
    // 1. Text to Bytes
    const rawBytes = Buffer.from(testMessage, 'utf-8');
    
    // 2. Compress (DEFLATE - exact same algorithm as pako)
    const compressedBytes = zlib.deflateSync(rawBytes);
    
    // 3. Decompress
    const decompressedBytes = zlib.inflateSync(compressedBytes);
    const restoredMessage = decompressedBytes.toString('utf-8');
    
    // Print results to terminal
    console.log("--------------------------------------------------");
    console.log("Original Text:    ", testMessage);
    console.log("Original Size:    ", rawBytes.length, "bytes");
    console.log("Compressed Size:  ", compressedBytes.length, "bytes");
    console.log("Restored Text:    ", restoredMessage);
    console.log("Match Successful: ", testMessage === restoredMessage);
    console.log("--------------------------------------------------");
}

 testCompression();
