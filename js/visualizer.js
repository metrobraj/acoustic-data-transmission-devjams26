const Visualizer = {
    canvas: null,
    ctx: null,
    animationId: null,

    init: function(canvasId) {
        this.canvas = document.getElementById(canvasId);
        if (this.canvas) {
            this.ctx = this.canvas.getContext('2d');
            const container = this.canvas.parentElement;
            this.canvas.width = container.clientWidth || 600;
            this.canvas.height = container.clientHeight || 150;
        }
    },

    start: function() {
        if (!this.canvas || !this.ctx) return;
        
        if (!AudioPipeline.analyser) {
            setTimeout(() => this.start(), 100);
            return;
        }
        
        if (this.animationId) cancelAnimationFrame(this.animationId);
        this.draw();
    },

    stop: function() {
        if (this.animationId) {
            cancelAnimationFrame(this.animationId);
            this.animationId = null;
        }
        if (this.ctx && this.canvas) {
            this.ctx.fillStyle = '#111';
            this.ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
        }
    },

    draw: function() {
        this.animationId = requestAnimationFrame(this.draw.bind(this));

        const analyser = AudioPipeline.analyser;
        if (!analyser) return;

        const bufferLength = analyser.frequencyBinCount;
        const dataArray = new Uint8Array(bufferLength);
        analyser.getByteFrequencyData(dataArray);

        const width = this.canvas.width;
        const height = this.canvas.height;
        const sampleRate = AudioPipeline.audioCtx.sampleRate || 44100;

        this.ctx.fillStyle = '#111';
        this.ctx.fillRect(0, 0, width, height);

        // Zoom in specifically on your Auditorium-Grade spectrum (12kHz to 18.5kHz)
        const minFreq = 12000;
        const maxFreq = 18500;
        const startBin = Math.floor((minFreq * analyser.fftSize) / sampleRate);
        const endBin = Math.ceil((maxFreq * analyser.fftSize) / sampleRate);
        const rangeBins = endBin - startBin;

        const barWidth = (width / rangeBins);
        let x = 0;

        for (let i = startBin; i <= endBin; i++) {
            const magnitude = dataArray[i];
            const barHeight = (magnitude / 255) * height;
            const currentFreq = (i * sampleRate) / analyser.fftSize;

            // Color Map matching your audio.js frequencies
            if (currentFreq >= 16800 && currentFreq <= 17200) {
                this.ctx.fillStyle = '#00f2fe'; // START_FREQ 17kHz (Green)
            } else if (currentFreq >= 16300 && currentFreq <= 16700) {
                this.ctx.fillStyle = '#ff007f'; // SYNC_FREQ 16.5kHz (Yellow)
            } else if (currentFreq >= 17300 && currentFreq <= 17700) {
                this.ctx.fillStyle = '#ff9f43'; // END_FREQ 17.5kHz (Orange)
            } else if (currentFreq >= 12800 && currentFreq <= 16200) {
                this.ctx.fillStyle = '#3b82f6'; // 4 Data Lanes 13k-16k (Blue)
            } else {
                this.ctx.fillStyle = '#333b4d';    // Ambient noise (Dark Gray)
            }

            this.ctx.fillRect(x, height - barHeight, barWidth, barHeight);
            x += barWidth;
        }
    }
};