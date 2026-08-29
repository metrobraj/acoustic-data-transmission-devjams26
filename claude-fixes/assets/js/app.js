// js/app.js - Application Logic Layer

document.addEventListener('DOMContentLoaded', () => {
    // ============================================
    // 1. UI ELEMENT REFERENCES
    // ============================================
    
    const fileInput = document.getElementById('fileInput');
    const fileName = document.getElementById('fileName');
    const fileSize = document.getElementById('fileSize');
    const btnTransmit = document.getElementById('btnTransmit');
    
    const btnModeTx = document.getElementById('btnModeTx');
    const btnModeRx = document.getElementById('btnModeRx');
    const txPanel = document.getElementById('txPanel');
    const rxPanel = document.getElementById('rxPanel');
    const glider = document.querySelector('.glider');
    const statusText = document.querySelector('.subtitle');
    const statusDot = document.getElementById('statusDot');

    const btnReceive = document.getElementById('btnReceive');
    const downloadZone = document.getElementById('downloadZone');
    const downloadLink = document.getElementById('downloadLink');

    let readyPayload = null;

    // ============================================
    // 2. MODE SELECTOR LOGIC
    // ============================================

    if (btnModeTx && btnModeRx) {
        // Switch to TRANSMITTER mode
        btnModeTx.addEventListener('click', () => {
            btnModeTx.classList.add('active');
            btnModeRx.classList.remove('active');

            glider.style.transform = 'translateX(0%)';
            txPanel.classList.remove('hidden');
            rxPanel.classList.add('hidden');

            if (statusText) statusText.textContent = "[ TX MODE ] // Ready to transmit";
            if (statusDot) statusDot.className = "dot standby";

            // Init audio context
            if (typeof AudioPipeline !== 'undefined') AudioPipeline.init();
        });

        // Switch to RECEIVER mode
        btnModeRx.addEventListener('click', () => {
            btnModeRx.classList.add('active');
            btnModeTx.classList.remove('active');

            glider.style.transform = 'translateX(100%)';
            rxPanel.classList.remove('hidden');
            txPanel.classList.add('hidden');

            if (statusText) statusText.textContent = "[ RX MODE ] // Ready to receive";
            if (statusDot) statusDot.className = "dot standby";

            // Init audio context
            if (typeof AudioPipeline !== 'undefined') AudioPipeline.init();
        });
    }

    // ============================================
    // 3. FILE UPLOAD PIPELINE (TX)
    // ============================================

    /**
     * Process a selected file and compress it
     */
    function processSelectedFile(file) {
        if (!file) return;

        fileName.textContent = file.name;
        fileSize.textContent = `${(file.size / 1024).toFixed(2)} KB`;
        btnTransmit.disabled = false;

        const reader = new FileReader();
        reader.onload = function(e) {
            const rawBytes = new Uint8Array(e.target.result);

            // Compress via fflate
            if (typeof DataPipeline !== 'undefined') {
                readyPayload = DataPipeline.compressPayload(rawBytes);
                console.log("✅ File loaded and compressed. Ready payload size:", readyPayload.length);
            } else {
                console.error("❌ DataPipeline not loaded!");
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

    // Method B: Drag and Drop
    const dropZone = document.querySelector('.file-drop-zone');
    if (dropZone) {
        dropZone.addEventListener('dragover', (e) => {
            e.preventDefault();
            dropZone.style.borderColor = 'var(--accent-blue)';
            dropZone.style.background = 'rgba(255, 255, 255, 0.1)';
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

    // ============================================
    // 4. TRANSMIT BUTTON HANDLER
    // ============================================

    if (btnTransmit) {
        btnTransmit.addEventListener('click', async () => {
            console.log("🎙️ Transmit button clicked.");

            // Init audio if needed
            if (typeof AudioPipeline !== 'undefined') {
                AudioPipeline.init();
            }

            // Validate payload
            if (!readyPayload || !(readyPayload instanceof Uint8Array)) {
                console.warn("❌ No payload ready! Please select a file first.");
                alert("Please select a file first!");
                return;
            }

            try {
                btnTransmit.textContent = "⏱️ TRANSMITTING...";
                btnTransmit.disabled = true;

                if (statusText) statusText.textContent = "[ TRANSMITTING ] // Broadcasting now";
                if (statusDot) statusDot.className = "dot active";

                console.log("Starting transmission...");
                await AudioPipeline.transmitPayload(readyPayload);

                console.log("✅ Transmission complete!");
                if (statusText) statusText.textContent = "[ TX COMPLETE ] // Standby";
                if (statusDot) statusDot.className = "dot success";

            } catch (error) {
                console.error("❌ Transmission error:", error);
                if (statusText) statusText.textContent = "[ ERROR ] // Check console";
                if (statusDot) statusDot.className = "dot error";
            } finally {
                btnTransmit.textContent = "INITIATE CHIRP";
                btnTransmit.disabled = false;
            }
        });
    }

    // ============================================
    // 5. RECEIVE BUTTON HANDLER
    // ============================================

    if (btnReceive) {
        btnReceive.addEventListener('click', async () => {
            console.log("🎤 Receive button clicked.");

            if (typeof AudioPipeline === 'undefined') {
                console.error("❌ AudioPipeline not available!");
                alert("Audio engine not loaded. Refresh page.");
                return;
            }

            btnReceive.textContent = "👂 LISTENING...";
            btnReceive.disabled = true;

            if (statusText) statusText.textContent = "[ LISTENING ] // Waiting for chirps";
            if (statusDot) statusDot.className = "dot active";

            try {
                // Start receiver with callback
                await AudioPipeline.startReceiver((finalBytes) => {
                    console.log("✅ Reception complete! Received bytes:", finalBytes.length);

                    // Decompress payload
                    if (typeof DataPipeline !== 'undefined') {
                        const originalFile = DataPipeline.decompressPayload(finalBytes);

                        if (originalFile) {
                            // Create download link
                            const blob = new Blob([originalFile], { type: 'application/octet-stream' });
                            const url = URL.createObjectURL(blob);

                            downloadLink.href = url;
                            downloadLink.download = `received_file_${Date.now()}.bin`;
                            downloadLink.textContent = "💾 DOWNLOAD FILE";

                            if (downloadZone) {
                                downloadZone.classList.remove('hidden');
                            }

                            if (statusText) statusText.textContent = "[ FILE RECEIVED ] // Ready to download";
                            if (statusDot) statusDot.className = "dot success";

                            console.log("✅ File decompressed and ready for download!");
                        } else {
                            console.error("❌ Decompression failed!");
                            if (statusText) statusText.textContent = "[ ERROR ] // Decompression failed";
                            if (statusDot) statusDot.className = "dot error";
                        }
                    }
                });

            } catch (error) {
                console.error("❌ Receiver error:", error);
                if (statusText) statusText.textContent = "[ ERROR ] // Check permissions";
                if (statusDot) statusDot.className = "dot error";
            } finally {
                btnReceive.textContent = "OPEN MIC BUFFER";
                btnReceive.disabled = false;
            }
        });
    }

    console.log("✅ App initialized successfully!");
});