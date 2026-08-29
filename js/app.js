// js/app.js

document.addEventListener('DOMContentLoaded', () => {
    // UI Elements
    const fileInput = document.getElementById('fileInput');
    const fileName = document.getElementById('fileName');
    const fileSize = document.getElementById('fileSize');
    const btnTransmit = document.getElementById('btnTransmit');
    
    // Mode Selection Buttons
    const btnSelectTx = document.getElementById('btnSelectTx');
    const btnSelectRx = document.getElementById('btnSelectRx');
    const txPanel = document.getElementById('txPanel');
    const rxPanel = document.getElementById('rxPanel');
    const statusText = document.querySelector('.statustext');

    // Handle Mode Toggles
    if (btnSelectTx && btnSelectRx) {
        btnSelectTx.addEventListener('click', () => {
            txPanel.classList.remove('hidden');
            rxPanel.classList.add('hidden');
            statusText.textContent = 'SYSTEM ACTIVE || MODE: TRANSMITTER (TX)';
        });

        btnSelectRx.addEventListener('click', () => {
            rxPanel.classList.remove('hidden');
            txPanel.classList.add('hidden');
            statusText.textContent = 'SYSTEM ACTIVE || MODE: RECEIVER (RX)';
        });
    }

    // Handle File Selection & Compression Pipeline Integration
    if (fileInput) {
        fileInput.addEventListener('change', (event) => {
            const file = event.target.files[0];
            if (!file) return;

            fileName.textContent = file.name;
            fileSize.textContent = `${(file.size / 1024).toFixed(2)} KB`;
            btnTransmit.disabled = false;

            const reader = new FileReader();
            reader.onload = function(e) {
                const arrayBuffer = e.target.result;
                const rawBytes = new Uint8Array(arrayBuffer);
                
                // Convert binary file content to string format for the data pipeline
                const decoder = new TextDecoder('iso-8859-1'); // preserves raw byte integrity
                const textContent = decoder.decode(rawBytes);

                // Pass through your DataPipeline (data.js) instead of calling pako/fflate directly!
                const processedPayload = DataPipeline.compressPayload(textContent);
                
                console.log(`Processed binary payload ready for modulation: ${processedPayload.length} bytes.`);
            };
            reader.readAsArrayBuffer(file);
        });
    }
});