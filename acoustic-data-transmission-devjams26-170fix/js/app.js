// js/app.js

document.addEventListener('DOMContentLoaded', () => {
    // 1. UI Elements (Updated to match new HTML)
    const fileInput = document.getElementById('fileInput');
    const fileName = document.getElementById('fileName');
    const fileSize = document.getElementById('fileSize');
    const btnTransmit = document.getElementById('btnTransmit');
    
    // 2. Mode Selector Elements
    const btnModeTx = document.getElementById('btnModeTx');
    const btnModeRx = document.getElementById('btnModeRx');
    const txPanel = document.getElementById('txPanel');
    const rxPanel = document.getElementById('rxPanel');
    const glider = document.querySelector('.glider');
    const statusText = document.querySelector('.subtitle');

    let readyPayload = null; 

    // 3. Unified Mode Selector Logic
    if (btnModeTx && btnModeRx) {
        // Slide to Transmitter (Left)
        btnModeTx.addEventListener('click', () => {
            btnModeTx.classList.add('active');
            btnModeRx.classList.remove('active');

            glider.style.transform = 'translateX(0%)';
            txPanel.classList.remove('hidden');
            rxPanel.classList.add('hidden');

            if (statusText) statusText.textContent = "SYSTEM READY // TRANSMITTER (TX) MODE";
            
            // UNLOCK AUDIO CONTEXT
            if (typeof AudioPipeline !== 'undefined') AudioPipeline.init(); 
        });

        // Slide to Receiver (Right)
        btnModeRx.addEventListener('click', () => {
            btnModeRx.classList.add('active');
            btnModeTx.classList.remove('active');

            glider.style.transform = 'translateX(100%)';
            rxPanel.classList.remove('hidden');
            txPanel.classList.add('hidden');

            if (statusText) statusText.textContent = "SYSTEM READY // RECEIVER (RX) MODE";
            
            // UNLOCK AUDIO CONTEXT
            if (typeof AudioPipeline !== 'undefined') AudioPipeline.init();
        });
    }

    // 4. File Handling Pipeline (With Drag & Drop Support)
    const dropZone = document.querySelector('.file-drop-zone');

    function processSelectedFile(file) {
        if (!file) return;

        fileName.textContent = file.name;
        fileSize.textContent = `${(file.size / 1024).toFixed(2)} KB`;
        btnTransmit.disabled = false; // Unlocks the INITIATE CHIRP button

        const reader = new FileReader();
        reader.onload = function(e) {
            const rawBytes = new Uint8Array(e.target.result);
            
            if (typeof DataPipeline !== 'undefined') {
                readyPayload = DataPipeline.compressPayload(rawBytes);
                console.log("File loaded and compressed. Ready payload:", readyPayload);
            }
        };
        reader.readAsArrayBuffer(file);
    }

    // Method A: Click to Browse
    if (fileInput) {
        fileInput.addEventListener('change', (event) => {
            processSelectedFile(event.target.files[0]);
        });
    }

    // Method B: Drag and Drop Mechanics
    if (dropZone) {
        dropZone.addEventListener('dragover', (e) => {
            e.preventDefault();
            dropZone.style.borderColor = 'var(--accent-blue)';
            dropZone.style.background = 'rgba(255, 255, 255, 0.8)';
        });

        dropZone.addEventListener('dragleave', (e) => {
            e.preventDefault();
            dropZone.style.borderColor = 'rgba(0, 0, 0, 0.15)';
            dropZone.style.background = 'rgba(255, 255, 255, 0.4)';
        });

        dropZone.addEventListener('drop', (e) => {
            e.preventDefault();
            dropZone.style.borderColor = 'rgba(0, 0, 0, 0.15)';
            dropZone.style.background = 'rgba(255, 255, 255, 0.4)';
            
            if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
                processSelectedFile(e.dataTransfer.files[0]);
            }
        });
    }

    // 5. Transmit Button Handler
    if (btnTransmit) {
        btnTransmit.addEventListener('click', async () => {
            console.log("Transmit button clicked.");

            if (typeof AudioPipeline !== 'undefined') {
                AudioPipeline.init();
            }

            if (!readyPayload || !(readyPayload instanceof Uint8Array)) {
                console.warn("No payload loaded yet! Please select or drop a file first.");
                alert("Please select or drop a file first!");
                return;
            }

            if (typeof Visualizer !== 'undefined') {
                Visualizer.init('spectrogramCanvas'); 
            }

            try {
                btnTransmit.textContent = "TRANSMITTING...";
                btnTransmit.disabled = true;

                if (typeof Visualizer !== 'undefined') Visualizer.start();

                console.log("Starting transmission of payload:", readyPayload);
                await AudioPipeline.transmitPayload(readyPayload);

                console.log("Transmission finished successfully.");
            } catch (error) {
                console.error("Error during transmission:", error);
            } finally {
                if (typeof Visualizer !== 'undefined') Visualizer.stop();

                btnTransmit.textContent = "INITIATE CHIRP";
                btnTransmit.disabled = false;
            }
        });
    }

    // 6. Receive Button Handler
    const btnReceive = document.getElementById('btnReceive');
    if (btnReceive) {
        btnReceive.addEventListener('click', async () => {
            btnReceive.textContent = "LISTENING FOR CHIRPS...";
            btnReceive.disabled = true;

            const statusDot = document.getElementById('statusDot');
            if (statusDot) statusDot.className = "dot active";

            // Initialize visualizer for listening mode
            if (typeof Visualizer !== 'undefined') {
                Visualizer.init('spectrogramCanvas');
                Visualizer.start();
            }

            // Unified ggwave receiver callback pipeline
            await AudioPipeline.startReceiver((receivedUint8Array) => {
                console.log(`[App] Signal decoded! Received ${receivedUint8Array.length} bytes.`);

                // 1. Stop visualizer if running
                if (typeof Visualizer !== 'undefined') Visualizer.stop();

                // 2. Decompress the payload back to original file bytes using DataPipeline
                const originalFileBytes = DataPipeline.decompressPayload(receivedUint8Array);

                if (originalFileBytes) {
                    // 3. Wrap raw bytes into a generic binary Blob
                    const blob = new Blob([originalFileBytes], { type: 'application/octet-stream' });
                    const blobUrl = URL.createObjectURL(blob);

                    // 4. Update UI download link
                    const downloadLink = document.getElementById('downloadLink');
                    const downloadZone = document.getElementById('downloadZone');

                    if (downloadLink && downloadZone) {
                        downloadLink.href = blobUrl;
                        downloadLink.download = `recovered_file_${Date.now()}`;
                        downloadZone.classList.remove('hidden');
                    }

                    console.log("[App] File successfully reconstructed and ready for download!");
                    alert("File received and ready for download!");
                } else {
                    console.error("[App] Decompression failed.");
                    alert("File reconstruction failed. Payload data was corrupted.");
                }

                // Reset receiver button UI state
                btnReceive.textContent = "ENGAGE RECEIVER";
                btnReceive.disabled = false;
            });
        });
    }
});