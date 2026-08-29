// js/app.js

document.addEventListener('DOMContentLoaded', () => {
    const fileInput = document.getElementById('fileInput');
    const fileName = document.getElementById('fileName');
    const fileSize = document.getElementById('fileSize');
    const btnTransmit = document.getElementById('btnTransmit');

    fileInput.addEventListener('change', (event) => {
        const file = event.target.files[0];
        if (!file) return;

        fileName.textContent = file.name;
        fileSize.textContent = `${(file.size / 1024).toFixed(2)} KB`;
        btnTransmit.disabled = false;

        // Read file contents as ArrayBuffer and test compression
        const reader = new FileReader();
        reader.onload = function(e) {
            const arrayBuffer = e.target.result;
            const rawBytes = new Uint8Array(arrayBuffer);
            
            // Compress using your data.js pipeline
            const compressed = pako.deflate(rawBytes);
            console.log(`Original: ${rawBytes.length} bytes | Compressed: ${compressed.length} bytes`);
        };
        reader.readAsArrayBuffer(file);
    });
});