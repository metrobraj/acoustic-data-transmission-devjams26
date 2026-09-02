# acoustic-data-transmission-devjams26

# AirChirp

> An experimental, Web Audio API and WebAssembly-powered acoustic modem designed to transfer encrypted binary payloads across air-gapped devices using sound waves.


---

## Project Overview

**AirChirp** was created during the Google Developer Groups DevJams'26 hackathon at VIT Vellore to bridge isolated devices without Wi-Fi, Bluetooth, or physical cables. The goal was to convert binary files into structured sound streams and decode them cleanly across high-reverberation room environments.

While the project could not be completed before the hackathon deadline due to physical acoustic edge cases, significant low-level DSP architecture was successfully designed and prototyped.

---

## Physical Architecture

This program follows Goertzel Algorithm. Rather than running complete Fast Fourier Transforms (FFT) across unnecessary frequency bands which introduced latency and byte mismatches, the core receiver pipeline was refactored around the **Goertzel Algorithm**. 
* **Targeted Detection:** Evaluates discrete target frequencies (e.g., 8 kHz – 12.5 kHz DTMF lanes) with lower computational overhead than an $O(N \log N)$ FFT.
* **Phase/Magnitude Extraction:** Allowed per-sample energy extraction for precise tone-pair detection directly out of PCM buffers.

### 1. Dual-Group DTMF & OFDM-Lite Encoding
To eliminate the "phantom zero-bit" problem (where silence is confused for a zero byte), a 4-lane parallel frequency mapper was built using Dual-Tone Multi-Frequency (DTMF) pairs across the 8 kHz – 12.5 kHz band(subject to change).

### 2. State-Machine Synchronization Engine
To counter reverberation time (RT60) and noise, 3 guardrails were implemented:
* **Preamble Lock:** Detects a start marker tone.
* **Echo Clearance:** Forces a silent drain window to allow hall reflections to dissipate.
* **Pilot Sync:** Aligns the sample clock to middle-of-symbol timing windows.

---

## Edge Cases

The project is currently paused due to physical layer challenges encountered during live environment testing:

It is possible that the device's hardware is not designed for such transfer through(unverified). Noise immunity could not be achieved with a reasonable accuracy. Real-time latency was a significant issue plaguing the sound stream decoding accuracy. Future solutions should aim to probe and fix these issues.

---
## Pending Issues

1. Dynamic threshold should be implemented such that the receiver is adjusted to variable noise. A counter-solution may be dynamic frequency-hopping based on real-time ambient noise levels.
2. Encryption must be implemented through client-side AES-256-GCM encryption layer via Web Crypto API prior to data transfer.
3. Bidirectional handshake for dynamic packet retransmission requests is suggested.
4. Real-time scrolling FFT spectrogram visualization rendered via HTML5 Canvas requires fix and polishing.
5. UI requires enhancement.
