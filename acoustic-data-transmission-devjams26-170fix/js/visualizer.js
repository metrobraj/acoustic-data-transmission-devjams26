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

        this.ctx.fillStyle = '#1e2330';
        this.ctx.fillRect(0, 0, width, height);

        // Zoom out slightly to cover the new 12kHz to 22kHz differential spread
        const minFreq = 12000;
        const maxFreq = 22000;
        const startBin = Math.floor((minFreq * analyser.fftSize) / sampleRate);
        const endBin = Math.ceil((maxFreq * analyser.fftSize) / sampleRate);
        const rangeBins = endBin - startBin;

        const barWidth = (width / rangeBins);
        let x = 0;

        for (let i = startBin; i <= endBin; i++) {
            const magnitude = dataArray[i];
            const barHeight = (magnitude / 255) * (height - 10);
            const currentFreq = (i * sampleRate) / analyser.fftSize;

            // Updated Color Map for 8-FSK
            if (currentFreq >= 20000 && currentFreq <= 20400) {
                this.ctx.fillStyle = '#00f2fe'; // START: Neon Cyan
            } else if (currentFreq >= 20500 && currentFreq <= 20900) {
                this.ctx.fillStyle = '#ff007f'; // SYNC: Cyber Pink
            } else if (currentFreq >= 21000 && currentFreq <= 21400) {
                this.ctx.fillStyle = '#ff9f43'; // END: Electric Amber
            } else if (currentFreq >= 12800 && currentFreq <= 16200) {
                this.ctx.fillStyle = '#3b82f6'; // 'ONE' LANES: Vibrant Blue
            } else if (currentFreq >= 16300 && currentFreq <= 19700) {
                this.ctx.fillStyle = '#9333ea'; // 'ZERO' LANES: Purple
            } else {
                this.ctx.fillStyle = '#333b4d'; // NOISE
            }

            if (barHeight > 0) {
                this.ctx.fillRect(x, height - barHeight, Math.max(1, barWidth - 1), barHeight);
            }
            x += barWidth;
        }
    }