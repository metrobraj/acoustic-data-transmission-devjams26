// js/app.js

document.addEventListener('DOMContentLoaded', () => {
    const fileInput = document.getElementById('fileInput');
    const fileName = document.getElementById('fileName');
    const fileSize = document.getElementById('fileSize');
    const btnTransmit = document.getElementById('btnTransmit');
    const btnSelectTx = document.getElementById('btnSelectTx');
    const btnSelectRx = document.getElementById('btnSelectRx');
    const txPanel = document.getElementById('txPanel');
    const rxPanel = document.getElementById('rxPanel');
    const statusText = document.querySelector('.statustext');

    let readyPayload = null; // Will store the final Uint8Array ready for modulation

    if (btnSelectTx && btnSelectRx) {
        btnSelectTx.addEventListener('click', () => {
            txPanel.classList.remove('hidden');
            rxPanel.classList.add('hidden');
            statusText.textContent = 'SYSTEM ACTIVE || MODE: TRANSMITTER (TX)';
            AudioPipeline.init(); 
        });

        btnSelectRx.addEventListener('click', () => {
            rxPanel.classList.remove('hidden');
            txPanel.classList.add('hidden');
            statusText.textContent = 'SYSTEM ACTIVE || MODE: RECEIVER (RX)';
            AudioPipeline.init();
        });
    }

    if (fileInput) {
        fileInput.addEventListener('change', (event) => {
            const file = event.target.files[0];
            if (!file) return;

            fileName.textContent = file.name;
            fileSize.textContent = `${(file.size / 1024).toFixed(2)} KB`;
            btnTransmit.disabled = false;

            const reader = new FileReader();
            reader.onload = function(e) {
                // 1. Extract raw binary file bytes directly into a Uint8Array
                const rawBytes = new Uint8Array(e.target.result);
                
                // 2. Compress and get a pure Uint8Array ready for audio transmission
                readyPayload = DataPipeline.compressPayload(rawBytes);
                
                console.log("Ready payload Uint8Array:", readyPayload);
            };
            reader.readAsArrayBuffer(file);
        });
    }

    if (btnTransmit) {
        btnTransmit.addEventListener('click', () => {
            if (readyPayload && readyPayload instanceof Uint8Array) {
                btnTransmit.textContent = "TRANSMITTING...";
                btnTransmit.disabled = true;

                // Pass the pure Uint8Array into the audio transmitter
                AudioPipeline.transmitPayload(readyPayload).then(() => {
                    btnTransmit.textContent = "INITIATE CHIRP";
                    btnTransmit.disabled = false;
                });
            }
        });
    }
});

document.addEventListener('DOMContentLoaded', () => {
    const btnModeTx = document.getElementById('btnModeTx');
    const btnModeRx = document.getElementById('btnModeRx');
    const txPanel = document.getElementById('txPanel');
    const rxPanel = document.getElementById('rxPanel');
    const glider = document.querySelector('.glider');
    const statusText = document.querySelector('.subtitle');

    // Slide to Transmitter (Left)
    btnModeTx.addEventListener('click', () => {
        btnModeTx.classList.add('active');
        btnModeRx.classList.remove('active');

        // Move slider to left position
        glider.style.transform = 'translateX(0%)';

        txPanel.classList.remove('hidden');
        rxPanel.classList.add('hidden');

        if (statusText) statusText.textContent = "SYSTEM READY // TRANSMITTER (TX) MODE";
    });

    // Slide to Receiver (Right)
    btnModeRx.addEventListener('click', () => {
        btnModeRx.classList.add('active');
        btnModeTx.classList.remove('active');

        // Move slider to right position (100% offset)
        glider.style.transform = 'translateX(100%)';

        rxPanel.classList.remove('hidden');
        txPanel.classList.add('hidden');

        if (statusText) statusText.textContent = "SYSTEM READY // RECEIVER (RX) MODE";
    });
});