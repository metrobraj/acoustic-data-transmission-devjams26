function draw(){
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

            if (currentFreq >= 14000 && currentFreq <= 20000) {
                this.ctx.fillStyle = '#00f2fe'; // Active ggwave frequency spectrum
            } else {
                this.ctx.fillStyle = '#333b4d'; // Inactive noise floor
            }

            if (barHeight > 0) {
                this.ctx.fillRect(x, height - barHeight, Math.max(1, barWidth - 1), barHeight);
            }
            x += barWidth;
        }
    }