// assets/js/initialization.js - Visualizer & Initialization

const Visualizer = {
    canvas: null,
    ctx: null,
    analyser: null,
    isRunning: false,

    /**
     * Initialize the canvas and get analyser from AudioPipeline
     */
    init: function() {
        this.canvas = document.getElementById('spectrogramCanvas');
        if (!this.canvas) {
            console.warn("[Visualizer] Canvas not found!");
            return;
        }

        this.ctx = this.canvas.getContext('2d');

        // Set canvas size to fill container
        const container = this.canvas.parentElement;
        this.canvas.width = container.offsetWidth;
        this.canvas.height = 300;

        console.log(`[Visualizer] Canvas initialized: ${this.canvas.width}x${this.canvas.height}`);
    },

    /**
     * Start visualization using AudioPipeline's analyser
     */
    start: function() {
        if (this.isRunning) return;

        // Get analyser from AudioPipeline
        if (!AudioPipeline || !AudioPipeline.analyser) {
            console.error("[Visualizer] AudioPipeline or analyser not available!");
            return;
        }

        this.analyser = AudioPipeline.analyser;
        this.isRunning = true;

        console.log("[Visualizer] Starting spectrogram...");
        this.animationLoop();
    },

    /**
     * Stop visualization
     */
    stop: function() {
        this.isRunning = false;
        console.log("[Visualizer] Spectrogram stopped.");
    },

    /**
     * Main animation frame loop
     */
    animationLoop: function() {
        if (!this.isRunning || !this.analyser) return;

        requestAnimationFrame(() => this.animationLoop());

        // Get frequency data
        const dataArray = new Uint8Array(this.analyser.frequencyBinCount);
        this.analyser.getByteFrequencyData(dataArray);

        // Draw waveform
        this.drawSpectrum(dataArray);
    },

    /**
     * Draw frequency spectrum as a 2D graph with color intensity
     */
    drawSpectrum: function(dataArray) {
        const width = this.canvas.width;
        const height = this.canvas.height;

        // Shift canvas left (scrolling effect)
        this.ctx.drawImage(this.canvas, -2, 0);

        // Get current audio data and draw rightmost column
        const binWidth = Math.ceil(dataArray.length / width);

        this.ctx.fillStyle = '#000';
        this.ctx.fillRect(width - 2, 0, 2, height);

        // Draw vertical slice
        for (let y = 0; y < height; y++) {
            const binIndex = Math.floor((y / height) * dataArray.length);
            const value = dataArray[binIndex];

            // Color gradient based on intensity
            const hue = 120 - (value / 255) * 240; // Green -> Red
            const saturation = 100;
            const lightness = 30 + (value / 255) * 40;

            this.ctx.fillStyle = `hsl(${hue}, ${saturation}%, ${lightness}%)`;
            this.ctx.fillRect(width - 2, y, 2, 1);
        }

        // Draw frequency labels
        this.drawFrequencyLabels();
    },

    /**
     * Add frequency axis labels
     */
    drawFrequencyLabels: function() {
        const width = this.canvas.width;
        const height = this.canvas.height;
        const sampleRate = AudioPipeline.audioCtx.sampleRate;
        const nyquist = sampleRate / 2;

        this.ctx.fillStyle = 'rgba(0, 255, 0, 0.8)';
        this.ctx.font = '10px Fira Code';
        this.ctx.textAlign = 'left';

        // Draw key frequency markers
        const markers = [
            { freq: 17000, label: '17k' },
            { freq: 18000, label: '18k' },
            { freq: 19000, label: '19k' },
            { freq: 20500, label: '20.5k' },
            { freq: 21500, label: 'START' },
            { freq: 22500, label: 'END' }
        ];

        markers.forEach(marker => {
            const yPos = height - (marker.freq / nyquist) * height;
            if (yPos > 0 && yPos < height) {
                this.ctx.fillText(marker.label, 5, yPos - 2);
            }
        });
    }
};

// Auto-init when DOM is ready
document.addEventListener('DOMContentLoaded', () => {
    Visualizer.init();

    // Start visualizer when mode is selected
    const btnModeTx = document.getElementById('btnModeTx');
    const btnModeRx = document.getElementById('btnModeRx');

    if (btnModeTx) {
        btnModeTx.addEventListener('click', () => {
            Visualizer.start();
        });
    }

    if (btnModeRx) {
        btnModeRx.addEventListener('click', () => {
            Visualizer.start();
        });
    }

    console.log("✅ Visualizer initialized!");
});