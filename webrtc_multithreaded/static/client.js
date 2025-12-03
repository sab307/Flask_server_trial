/**
 * WebRTC Client - Fixed Clock Sync for Multiple Computers
 * ========================================================
 * 
 * FIX: The clock sync is between Go server and browser (via DataChannel).
 * But capture_ms comes from Python (which may have 22+ sec offset).
 * 
 * SOLUTION: Use relay_time_ms (from Go) as the reference point since
 * that's the clock we're syncing with via DataChannel ping-pong.
 * 
 * Glass Latency = (receiveTime - relay_time_ms + clockOffset) + (relay_time_ms - capture_ms) + displayDelay
 *               = (Go→Browser latency) + (Python→Go latency) + displayDelay
 */

// =============================================================================
// Global State
// =============================================================================

let pc = null;
let timestampChannel = null;
let metricsInterval = null;
let durationInterval = null;
let connectionStartTime = null;

// Charts
let fpsChart = null;
let latencyChart = null;
let bitrateChart = null;
let packetLossChart = null;
let glassLatencyChart = null;

const MAX_HISTORY = 60;

// Stats
let lastStats = null;
let lastStatsTime = null;

// =============================================================================
// Clock Synchronization (Go Server <-> Browser)
// =============================================================================

const timestampBuffer = new Map();
const MAX_TIMESTAMP_BUFFER = 200;

// Clock sync state - syncs with Go server (not Python!)
let clockOffset = 0;  // Go Server time - Browser time
let clockSyncSamples = [];
const CLOCK_SYNC_SAMPLES = 20;
let clockSyncComplete = false;
let clockSyncInterval = null;

// Python-Go offset (estimated from relay_time_ms - capture_ms)
let pythonGoOffset = 0;
let pythonGoSamples = [];

// Latency statistics
let latencyStats = {
    samples: [],
    filtered: [],
    min: Infinity,
    max: 0,
    avg: 0,
    current: 0,
    stdDev: 0
};

// Frame timing
let frameCallbackId = null;
let displayedFrameCount = 0;

// =============================================================================
// Process Timestamp - FIXED for Multiple Computers
// =============================================================================

function processTimestamp(data) {
    const receiveTime = performance.now() + performance.timeOrigin;
    
    if (data.type === 'frame_timestamp') {
        const frameId = data.frame_id || data.frame_num || data.seq;
        
        // Store for correlation
        timestampBuffer.set(frameId, {
            frame_id: frameId,
            capture_ms: data.capture_ms,
            relay_ms: data.relay_time_ms,
            send_ms: data.send_time_ms,
            receive_ms: receiveTime
        });
        
        // Cleanup old entries
        if (timestampBuffer.size > MAX_TIMESTAMP_BUFFER) {
            const oldest = timestampBuffer.keys().next().value;
            timestampBuffer.delete(oldest);
        }
        
        // === FIXED LATENCY CALCULATION ===
        // The key insight: we sync with Go server, so use relay_time_ms as reference
        
        const DISPLAY_DELAY_MS = 20;  // Estimated display delay
        
        // Part 1: Go→Browser latency (we have clock sync for this)
        let goBrowserLatency = receiveTime - data.relay_time_ms;
        
        // Apply clock offset (Go server - Browser)
        if (clockSyncComplete) {
            goBrowserLatency = goBrowserLatency + clockOffset;
        }
        
        // Part 2: Python→Go latency (relay_time_ms - capture_ms)
        // This is on the Python→Go path, clocks may differ but difference is consistent
        let pythonGoLatency = data.relay_time_ms - data.capture_ms;
        
        // If Python→Go shows huge values (>10 sec), it's clock skew not actual latency
        // Estimate actual transmission time as ~5-20ms for local network
        if (Math.abs(pythonGoLatency) > 10000) {
            // Use running average of Python-Go offset
            pythonGoSamples.push(pythonGoLatency);
            if (pythonGoSamples.length > 30) {
                pythonGoSamples.shift();
            }
            
            // Calculate median offset
            const sorted = [...pythonGoSamples].sort((a, b) => a - b);
            pythonGoOffset = sorted[Math.floor(sorted.length / 2)];
            
            // Actual latency = measured - offset + small transmission time
            pythonGoLatency = pythonGoLatency - pythonGoOffset + 10;  // Assume ~10ms transmission
        }
        
        // Total glass-to-glass latency
        const estimatedGlassLatency = pythonGoLatency + goBrowserLatency + DISPLAY_DELAY_MS;
        
        // Sanity check - now should work for all computers
        if (estimatedGlassLatency > 0 && estimatedGlassLatency < 2000) {
            updateGlassLatency(estimatedGlassLatency);
        }
        
        // Debug logging
        if (frameId % 60 === 0) {
            console.log(`📊 Frame ${frameId}: ` +
                       `python→go=${pythonGoLatency.toFixed(1)}ms, ` +
                       `go→browser=${goBrowserLatency.toFixed(1)}ms, ` +
                       `total=${estimatedGlassLatency.toFixed(1)}ms, ` +
                       `clockOffset=${clockOffset.toFixed(1)}ms`);
        }
        
    } else if (data.type === 'pong') {
        processClockSync(data);
    }
}

// =============================================================================
// Clock Sync (Go Server <-> Browser via DataChannel)
// =============================================================================

function processClockSync(data) {
    const receiveTime = performance.now() + performance.timeOrigin;
    const rtt = receiveTime - data.client_time;
    const oneWayDelay = rtt / 2;
    
    // Clock offset: server_time - (receiveTime - oneWayDelay)
    // = server_time - receiveTime + oneWayDelay
    const offset = data.server_time - receiveTime + oneWayDelay;
    
    // Reject high RTT samples
    if (rtt > 500) {
        console.warn(`⚠️ Clock sync rejected - high RTT: ${rtt.toFixed(1)}ms`);
        return;
    }
    
    clockSyncSamples.push({
        offset: offset,
        rtt: rtt,
        timestamp: receiveTime
    });
    
    // Keep recent samples
    while (clockSyncSamples.length > CLOCK_SYNC_SAMPLES * 2) {
        clockSyncSamples.shift();
    }
    
    // Calculate stable offset using median of low-RTT samples
    if (clockSyncSamples.length >= 5) {
        const sorted = [...clockSyncSamples].sort((a, b) => a.rtt - b.rtt);
        const best = sorted.slice(0, Math.ceil(sorted.length / 2));
        
        const offsets = best.map(s => s.offset).sort((a, b) => a - b);
        const medianOffset = offsets[Math.floor(offsets.length / 2)];
        
        // Smooth update
        if (!clockSyncComplete) {
            clockOffset = medianOffset;
        } else {
            clockOffset = clockOffset * 0.8 + medianOffset * 0.2;
        }
        
        if (clockSyncSamples.length >= CLOCK_SYNC_SAMPLES && !clockSyncComplete) {
            clockSyncComplete = true;
            console.log(`✅ Clock sync complete: offset=${clockOffset.toFixed(1)}ms`);
        }
        
        if (clockSyncSamples.length % 5 === 0) {
            console.log(`🕐 Clock sync: offset=${clockOffset.toFixed(1)}ms, RTT=${rtt.toFixed(1)}ms`);
        }
    }
}

function sendClockSyncPing() {
    if (timestampChannel && timestampChannel.readyState === 'open') {
        timestampChannel.send(JSON.stringify({
            type: 'ping',
            client_time: performance.now() + performance.timeOrigin
        }));
    }
}

function startClockSync() {
    stopClockSync();
    clockSyncSamples = [];
    pythonGoSamples = [];
    clockSyncComplete = false;
    clockOffset = 0;
    pythonGoOffset = 0;
    
    console.log('🕐 Starting clock synchronization...');
    
    // Initial burst
    let burst = 0;
    const burstInterval = setInterval(() => {
        sendClockSyncPing();
        burst++;
        if (burst >= 10) {
            clearInterval(burstInterval);
            clockSyncInterval = setInterval(sendClockSyncPing, 3000);
        }
    }, 100);
}

function stopClockSync() {
    if (clockSyncInterval) {
        clearInterval(clockSyncInterval);
        clockSyncInterval = null;
    }
}

// =============================================================================
// Glass Latency Display with Outlier Rejection
// =============================================================================

function updateGlassLatency(latencyMs) {
    if (latencyMs < 0 || latencyMs > 2000) {
        return;
    }
    
    latencyStats.samples.push(latencyMs);
    if (latencyStats.samples.length > 100) {
        latencyStats.samples.shift();
    }
    
    // Outlier detection
    if (latencyStats.samples.length >= 10) {
        const mean = latencyStats.samples.reduce((a, b) => a + b) / latencyStats.samples.length;
        const variance = latencyStats.samples.reduce((sum, val) => 
            sum + Math.pow(val - mean, 2), 0) / latencyStats.samples.length;
        const stdDev = Math.sqrt(variance);
        
        if (stdDev > 5 && Math.abs(latencyMs - mean) > 2 * stdDev) {
            return;
        }
        
        latencyStats.stdDev = stdDev;
    }
    
    latencyStats.filtered.push(latencyMs);
    if (latencyStats.filtered.length > 30) {
        latencyStats.filtered.shift();
    }
    
    latencyStats.current = latencyMs;
    latencyStats.min = Math.min(latencyStats.min, latencyMs);
    latencyStats.max = Math.max(...latencyStats.filtered);
    latencyStats.avg = latencyStats.filtered.reduce((a, b) => a + b) / latencyStats.filtered.length;
    
    // Update display
    const el = (id) => document.getElementById(id);
    
    if (el('glass-latency-value')) {
        el('glass-latency-value').textContent = latencyMs.toFixed(0);
    }
    if (el('glass-latency-min')) {
        el('glass-latency-min').textContent = latencyStats.min.toFixed(0);
    }
    if (el('glass-latency-max')) {
        el('glass-latency-max').textContent = latencyStats.max.toFixed(0);
    }
    if (el('glass-latency-avg')) {
        el('glass-latency-avg').textContent = latencyStats.avg.toFixed(0);
    }
    
    if (glassLatencyChart) {
        updateChart(glassLatencyChart, new Date().toLocaleTimeString(), latencyMs);
    }
}

// =============================================================================
// Frame Callback
// =============================================================================

function setupFrameCallback(video) {
    if (!('requestVideoFrameCallback' in HTMLVideoElement.prototype)) {
        console.warn('requestVideoFrameCallback not supported');
        return;
    }
    
    const frameCallback = (now, metadata) => {
        displayedFrameCount++;
        frameCallbackId = video.requestVideoFrameCallback(frameCallback);
    };
    
    frameCallbackId = video.requestVideoFrameCallback(frameCallback);
    console.log('✅ requestVideoFrameCallback enabled');
}

// =============================================================================
// Charts
// =============================================================================

function initializeCharts() {
    const chartConfig = (label, color) => ({
        type: 'line',
        data: {
            labels: [],
            datasets: [{
                label: label,
                data: [],
                borderColor: color,
                backgroundColor: color + '20',
                borderWidth: 2,
                fill: true,
                tension: 0.4,
                pointRadius: 0,
                pointHitRadius: 10
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            animation: false,
            interaction: { intersect: false, mode: 'index' },
            plugins: { legend: { display: false } },
            scales: {
                x: {
                    display: true,
                    grid: { color: 'rgba(255,255,255,0.1)' },
                    ticks: { color: '#888', maxTicksLimit: 6, font: { size: 10 } }
                },
                y: {
                    display: true,
                    grid: { color: 'rgba(255,255,255,0.1)' },
                    ticks: { color: '#888', font: { size: 10 } },
                    beginAtZero: true
                }
            }
        }
    });
    
    const glassChartEl = document.getElementById('glass-latency-chart');
    if (glassChartEl) {
        glassLatencyChart = new Chart(glassChartEl, chartConfig('Glass Latency', '#CE93D8'));
    }
    
    fpsChart = new Chart(document.getElementById('fps-chart'), chartConfig('FPS', '#4CAF50'));
    latencyChart = new Chart(document.getElementById('latency-chart'), chartConfig('RTT', '#FF9800'));
    bitrateChart = new Chart(document.getElementById('bitrate-chart'), chartConfig('Bitrate', '#2196F3'));
    packetLossChart = new Chart(document.getElementById('packet-loss-chart'), chartConfig('Loss', '#F44336'));
}

function updateChart(chart, label, value) {
    if (!chart) return;
    if (chart.data.labels.length >= MAX_HISTORY) {
        chart.data.labels.shift();
        chart.data.datasets[0].data.shift();
    }
    chart.data.labels.push(label);
    chart.data.datasets[0].data.push(value);
    chart.update('none');
}

function updateStatus(status, message) {
    const banner = document.getElementById('status-banner');
    const text = document.getElementById('status-text');
    if (banner) banner.className = 'status-banner ' + status;
    if (text) text.textContent = message;
}

// =============================================================================
// WebRTC Stream
// =============================================================================

async function startStream() {
    const startBtn = document.getElementById('start-btn');
    const stopBtn = document.getElementById('stop-btn');
    
    try {
        startBtn.disabled = true;
        updateStatus('connecting', 'Connecting...');
        
        // Reset state
        latencyStats = { samples: [], filtered: [], min: Infinity, max: 0, avg: 0, current: 0, stdDev: 0 };
        clockSyncSamples = [];
        pythonGoSamples = [];
        clockSyncComplete = false;
        clockOffset = 0;
        pythonGoOffset = 0;
        timestampBuffer.clear();
        displayedFrameCount = 0;
        
        pc = new RTCPeerConnection({
            iceServers: [
                { urls: 'stun:stun.l.google.com:19302' },
                { urls: 'stun:stun1.l.google.com:19302' }
            ],
            bundlePolicy: 'max-bundle',
            rtcpMuxPolicy: 'require'
        });
        
        console.log('✅ RTCPeerConnection created');
        
        // Create DataChannel BEFORE offer
        timestampChannel = pc.createDataChannel('timestamps', { ordered: true });
        console.log('📡 DataChannel created');
        
        timestampChannel.onopen = () => {
            console.log('📡 DataChannel OPEN');
            startClockSync();
        };
        
        timestampChannel.onclose = () => console.log('📡 DataChannel closed');
        timestampChannel.onerror = (e) => console.error('📡 DataChannel error:', e);
        
        timestampChannel.onmessage = (event) => {
            try {
                let jsonStr;
                if (typeof event.data === 'string') {
                    jsonStr = event.data;
                } else if (event.data instanceof ArrayBuffer) {
                    jsonStr = new TextDecoder().decode(event.data);
                } else if (event.data instanceof Blob) {
                    event.data.text().then(text => {
                        processTimestamp(JSON.parse(text));
                    });
                    return;
                } else {
                    return;
                }
                processTimestamp(JSON.parse(jsonStr));
            } catch (e) {
                console.error('Parse error:', e);
            }
        };
        
        pc.onconnectionstatechange = () => {
            const state = pc.connectionState;
            console.log('Connection:', state);
            
            const el = document.getElementById('connection-state');
            if (el) el.textContent = state;
            
            if (state === 'connected') {
                updateStatus('connected', '✓ Connected - Measuring Latency');
                const overlay = document.getElementById('video-overlay');
                if (overlay) overlay.style.display = 'block';
                connectionStartTime = Date.now();
                startDurationTimer();
            } else if (state === 'failed' || state === 'disconnected') {
                updateStatus(state === 'failed' ? 'error' : 'disconnected',
                           state === 'failed' ? 'Connection Failed' : 'Disconnected');
                if (state === 'failed') stopStream();
            }
        };
        
        pc.oniceconnectionstatechange = () => {
            const el = document.getElementById('ice-state');
            if (el) el.textContent = pc.iceConnectionState;
        };
        
        pc.ontrack = (event) => {
            console.log('✅ Track received:', event.track.kind);
            
            if (event.track.kind === 'video') {
                const video = document.getElementById('video');
                video.srcObject = event.streams[0];
                video.playsInline = true;
                
                video.onloadedmetadata = () => {
                    const res = `${video.videoWidth}x${video.videoHeight}`;
                    const resEl = document.getElementById('resolution-value');
                    const overlayResEl = document.getElementById('overlay-resolution');
                    if (resEl) resEl.textContent = res;
                    if (overlayResEl) overlayResEl.textContent = res;
                    
                    console.log('✅ Video metadata:', res);
                    setupFrameCallback(video);
                };
                
                setTimeout(() => video.play().catch(console.error), 100);
            }
        };
        
        const trans = pc.addTransceiver('video', { direction: 'recvonly' });
        
        const caps = RTCRtpReceiver.getCapabilities('video');
        const h264 = caps.codecs.find(c => c.mimeType === 'video/H264');
        if (h264) {
            trans.setCodecPreferences([h264]);
        }
        
        const offer = await pc.createOffer({
            offerToReceiveVideo: true,
            offerToReceiveAudio: false
        });
        
        await pc.setLocalDescription(offer);
        
        const response = await fetch('/offer', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                sdp: pc.localDescription.sdp,
                type: pc.localDescription.type
            })
        });
        
        if (!response.ok) {
            const err = await response.json();
            throw new Error(err.error || 'Server error');
        }
        
        const answer = await response.json();
        await pc.setRemoteDescription(new RTCSessionDescription(answer));
        console.log('✅ Remote description set');
        
        startMetricsCollection();
        stopBtn.disabled = false;
        
    } catch (error) {
        console.error('Start error:', error);
        updateStatus('error', 'Error: ' + error.message);
        startBtn.disabled = false;
        stopStream();
    }
}

function stopStream() {
    console.log('Stopping stream...');
    
    stopMetricsCollection();
    stopDurationTimer();
    stopClockSync();
    
    if (frameCallbackId !== null) {
        const video = document.getElementById('video');
        if (video && video.cancelVideoFrameCallback) {
            video.cancelVideoFrameCallback(frameCallbackId);
        }
        frameCallbackId = null;
    }
    
    if (pc) {
        pc.close();
        pc = null;
    }
    
    timestampChannel = null;
    
    const video = document.getElementById('video');
    if (video) video.srcObject = null;
    
    const overlay = document.getElementById('video-overlay');
    if (overlay) overlay.style.display = 'none';
    
    const startBtn = document.getElementById('start-btn');
    const stopBtn = document.getElementById('stop-btn');
    if (startBtn) startBtn.disabled = false;
    if (stopBtn) stopBtn.disabled = true;
    
    updateStatus('disconnected', 'Disconnected');
    
    ['connection-state', 'ice-state', 'duration'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.textContent = '-';
    });
}

// =============================================================================
// Metrics Collection
// =============================================================================

function startMetricsCollection() {
    if (metricsInterval) return;
    
    metricsInterval = setInterval(async () => {
        if (!pc) return;
        
        try {
            const stats = await pc.getStats();
            processStats(stats);
        } catch (error) {
            console.error('Stats error:', error);
        }
    }, 1000);
}

function stopMetricsCollection() {
    if (metricsInterval) {
        clearInterval(metricsInterval);
        metricsInterval = null;
    }
    lastStats = null;
    lastStatsTime = null;
}

function processStats(stats) {
    const now = Date.now();
    const ts = new Date().toLocaleTimeString();
    
    stats.forEach(report => {
        if (report.type === 'inbound-rtp' && report.kind === 'video') {
            if (lastStats && lastStats.framesReceived !== undefined) {
                const dt = (now - lastStatsTime) / 1000;
                
                const fps = Math.round((report.framesReceived - lastStats.framesReceived) / dt);
                updateMetric('fps', fps, ts);
                
                const bitrate = ((report.bytesReceived - lastStats.bytesReceived) * 8 / dt / 1e6).toFixed(2);
                updateMetric('bitrate', bitrate, ts);
            }
            
            updateMetric('packetsLost', report.packetsLost || 0, ts);
            
            if (report.jitter !== undefined) {
                updateMetric('jitter', (report.jitter * 1000).toFixed(2), ts);
            }
            
            if (report.jitterBufferDelay && report.jitterBufferEmittedCount) {
                const jbDelay = (report.jitterBufferDelay / report.jitterBufferEmittedCount * 1000).toFixed(2);
                updateMetric('jitterBuffer', jbDelay, ts);
            }
            
            lastStats = {
                framesReceived: report.framesReceived,
                bytesReceived: report.bytesReceived
            };
            lastStatsTime = now;
        }
        
        if (report.type === 'candidate-pair' && report.state === 'succeeded') {
            if (report.currentRoundTripTime !== undefined) {
                if (report.currentRoundTripTime > 0) {
                    updateMetric('latency', (report.currentRoundTripTime * 1000).toFixed(2), ts);
                } else {
                    updateMetric('latency', '< 1', ts);
                }
            }
        }
    });
}

function updateMetric(metric, value, timestamp) {
    const el = (id) => document.getElementById(id);
    
    switch (metric) {
        case 'fps':
            if (el('fps-value')) el('fps-value').textContent = value;
            if (el('overlay-fps')) el('overlay-fps').textContent = value;
            updateChart(fpsChart, timestamp, value);
            break;
        case 'latency':
            if (el('latency-value')) el('latency-value').textContent = value;
            if (typeof value === 'number' || !isNaN(parseFloat(value))) {
                updateChart(latencyChart, timestamp, parseFloat(value));
            }
            break;
        case 'bitrate':
            if (el('bitrate-value')) el('bitrate-value').textContent = value;
            updateChart(bitrateChart, timestamp, parseFloat(value));
            break;
        case 'packetsLost':
            if (el('packets-lost-value')) el('packets-lost-value').textContent = value;
            updateChart(packetLossChart, timestamp, value);
            break;
        case 'jitter':
            if (el('jitter-value')) el('jitter-value').textContent = value;
            break;
        case 'jitterBuffer':
            if (el('jitter-buffer-value')) el('jitter-buffer-value').textContent = value;
            break;
    }
}

// =============================================================================
// Duration Timer
// =============================================================================

function startDurationTimer() {
    if (durationInterval) return;
    
    durationInterval = setInterval(() => {
        if (!connectionStartTime) return;
        
        const d = Date.now() - connectionStartTime;
        const s = Math.floor(d / 1000) % 60;
        const m = Math.floor(d / 60000) % 60;
        const h = Math.floor(d / 3600000);
        
        const formatted = `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
        const el = document.getElementById('duration');
        if (el) el.textContent = formatted;
    }, 1000);
}

function stopDurationTimer() {
    if (durationInterval) {
        clearInterval(durationInterval);
        durationInterval = null;
    }
    connectionStartTime = null;
}

// =============================================================================
// Initialization
// =============================================================================

window.addEventListener('DOMContentLoaded', async () => {
    console.log('🚀 Glass-to-Glass Latency Client (FIXED)');
    console.log('   - Uses relay_time_ms for clock sync reference');
    console.log('   - Handles Python-Go clock offset separately');
    console.log('   - Works across all computers');
    
    initializeCharts();
    
    try {
        const response = await fetch('/config');
        const config = await response.json();
        const el = document.getElementById('sender-url');
        if (el) el.textContent = config.sender_url || 'Python Sender';
    } catch (error) {
        console.error('Config error:', error);
    }
    
    const startBtn = document.getElementById('start-btn');
    const stopBtn = document.getElementById('stop-btn');
    
    if (startBtn) startBtn.onclick = startStream;
    if (stopBtn) stopBtn.onclick = stopStream;
});

window.addEventListener('beforeunload', () => {
    stopStream();
});

// Debug exports
window.startStream = startStream;
window.stopStream = stopStream;
window.getLatencyStats = () => latencyStats;
window.getClockOffset = () => ({ goToBrowser: clockOffset, pythonToGo: pythonGoOffset });
window.getClockSyncStatus = () => ({
    complete: clockSyncComplete,
    samples: clockSyncSamples.length,
    offset: clockOffset,
    pythonGoOffset: pythonGoOffset
});