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

    // Helper function to process the file regardless of how it was added
    function processSelectedFile(file) {
        if (!file) return;

        fileName.textContent = file.name;
        fileSize.textContent = `${(file.size / 1024).toFixed(2)} KB`;
        btnTransmit.disabled = false; // This unlocks the INITIATE CHIRP button

        const reader = new FileReader();
        reader.onload = function(e) {
            const rawBytes = new Uint8Array(e.target.result);
            
            // Compress and get a pure Uint8Array ready for audio transmission
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
        // Prevent default browser behavior (opening the file in a new tab)
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
            // Reset drop zone styling
            dropZone.style.borderColor = 'rgba(0, 0, 0, 0.15)';
            dropZone.style.background = 'rgba(255, 255, 255, 0.4)';
            
            // Grab the dropped file and send it to our processor
            if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
                processSelectedFile(e.dataTransfer.files[0]);
            }
        });
    }
    // 5. Transmit Button Handler
    if (btnTransmit) {
        btnTransmit.addEventListener('click', async () => {
            console.log("Transmit button clicked.");

            // 1. Force initialize audio context on click if it wasn't already
            if (typeof AudioPipeline !== 'undefined') {
                AudioPipeline.init();
            }

            // 2. Safety check: Ensure payload is loaded
            if (!readyPayload || !(readyPayload instanceof Uint8Array)) {
                console.warn("No payload loaded yet! Please select or drop a file first.");
                alert("Please select or drop a file first!");
                return;
            }

            // 3. Trigger transmission
            try {
                btnTransmit.textContent = "TRANSMITTING...";
                btnTransmit.disabled = true;

                console.log("Starting transmission of payload:", readyPayload);
                await AudioPipeline.transmitPayload(readyPayload);

                console.log("Transmission finished successfully.");
            } catch (error) {
                console.error("Error during transmission:", error);
            } finally {
                btnTransmit.textContent = "INITIATE CHIRP";
                btnTransmit.disabled = false;
            }

        });
    }
    // --- ADD THIS INSIDE YOUR EXISTING DOMContentLoaded BLOCK ---
    const btnReceive = document.getElementById('btnReceive');
    if (btnReceive) {
        btnReceive.addEventListener('click', async () => {
            btnReceive.textContent = "LISTENING FOR CHIRPS...";
            btnReceive.disabled = true;
            
            // Calls the receiver function we just added to audio.js
            const success = await AudioPipeline.initReceiver();
            if (success) {
                const statusDot = document.getElementById('statusDot');
                if(statusDot) statusDot.className = "dot active";
            } else {
                btnReceive.textContent = "OPEN MIC BUFFER";
                btnReceive.disabled = false;
            }
        });
    }

});

