
/**
 * WebRTC Client - Stable Glass-to-Glass Latency Measurement
 * ==========================================================
 * 
 * FIXES for 50-950ms fluctuation:
 *   1. Stable clock sync with moving average (no mode switching)
 *   2. Outlier rejection in latency samples
 *   3. Proper clock offset calculation
 *   4. Smooth updates with exponential moving average
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
// Stable Clock Synchronization
// =============================================================================

const timestampBuffer = new Map();  // frame_id -> timestamp data
const MAX_TIMESTAMP_BUFFER = 200;

// Clock sync state - uses moving average for stability
let clockOffset = 0;  // Server - Client offset
let clockSyncSamples = [];
const CLOCK_SYNC_SAMPLES = 20;
let clockSyncComplete = false;
let clockSyncInterval = null;

// Latency statistics with outlier rejection
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
// Process Timestamp from DataChannel
// =============================================================================

function processTimestamp(data) {
    const receiveTime = performance.now() + performance.timeOrigin;
    
    if (data.type === 'frame_timestamp') {
        // Store for correlation
        const frameId = data.frame_id || data.frame_num || data.seq;
        
        timestampBuffer.set(frameId, {
            frame_id: frameId,
            capture_ms: data.capture_ms,
            relay_ms: data.relay_time_ms || data.send_time_ms,
            send_ms: data.send_time_ms,
            receive_ms: receiveTime
        });
        
        // Cleanup old entries
        if (timestampBuffer.size > MAX_TIMESTAMP_BUFFER) {
            const oldest = timestampBuffer.keys().next().value;
            timestampBuffer.delete(oldest);
        }
        
        // === STABLE LATENCY CALCULATION ===
        // Estimated display delay for 60Hz monitor
        const DISPLAY_DELAY_MS = 20;
        
        // Calculate raw latency
        let rawLatency = receiveTime - data.capture_ms;
        
        // Apply clock offset if significant (>100ms indicates different machines)
        if (clockSyncComplete && Math.abs(clockOffset) > 100) {
            rawLatency = rawLatency + clockOffset;
        }
        
        // Add display delay estimate
        const estimatedGlassLatency = rawLatency + DISPLAY_DELAY_MS;
        
        // Sanity check and update
        if (estimatedGlassLatency > 0 && estimatedGlassLatency < 5000) {
            updateGlassLatency(estimatedGlassLatency);
        }
        
        // Debug logging (every 60 frames ≈ 2s at 30fps)
        if (frameId % 60 === 0) {
            console.log(`📊 Frame ${frameId}: raw=${rawLatency.toFixed(1)}ms, ` +
                       `offset=${clockOffset.toFixed(1)}ms, ` +
                       `glass=${estimatedGlassLatency.toFixed(1)}ms`);
        }
        
    } else if (data.type === 'pong') {
        processClockSync(data);
    }
}

// =============================================================================
// Stable Clock Synchronization (Moving Average)
// =============================================================================

function processClockSync(data) {
    const receiveTime = performance.now() + performance.timeOrigin;
    const rtt = receiveTime - data.client_time;
    const oneWayDelay = rtt / 2;
    
    // Clock offset calculation
    const offset = data.server_time - receiveTime + oneWayDelay;
    
    // Reject outliers (high RTT indicates network issues)
    if (rtt > 500) {
        console.warn(`⚠️ Clock sync rejected - high RTT: ${rtt.toFixed(1)}ms`);
        return;
    }
    
    // Store sample
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
        // Sort by RTT, take best 50%
        const sorted = [...clockSyncSamples].sort((a, b) => a.rtt - b.rtt);
        const best = sorted.slice(0, Math.ceil(sorted.length / 2));
        
        // Median offset
        const offsets = best.map(s => s.offset).sort((a, b) => a - b);
        const medianOffset = offsets[Math.floor(offsets.length / 2)];
        
        // Smooth update (exponential moving average)
        if (!clockSyncComplete) {
            clockOffset = medianOffset;
        } else {
            // 80% old, 20% new for stability
            clockOffset = clockOffset * 0.8 + medianOffset * 0.2;
        }
        
        // Mark complete
        if (clockSyncSamples.length >= CLOCK_SYNC_SAMPLES && !clockSyncComplete) {
            clockSyncComplete = true;
            console.log(`✅ Clock sync complete: offset=${clockOffset.toFixed(1)}ms`);
        }
        
        // Debug
        if (clockSyncSamples.length % 5 === 0) {
            console.log(`🕐 Clock sync: offset=${clockOffset.toFixed(1)}ms, ` +
                       `RTT=${rtt.toFixed(1)}ms, samples=${clockSyncSamples.length}`);
        }
    }
}

// =============================================================================
// Clock Sync Control
// =============================================================================

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
    clockSyncComplete = false;
    clockOffset = 0;
    
    console.log('🕐 Starting clock synchronization...');
    
    // Initial burst for quick convergence
    let burst = 0;
    const burstInterval = setInterval(() => {
        sendClockSyncPing();
        burst++;
        if (burst >= 10) {
            clearInterval(burstInterval);
            // Then periodic sync every 3 seconds
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
// Glass-to-Glass Latency Display with Outlier Rejection
// =============================================================================

function updateGlassLatency(latencyMs) {
    // Reject obvious outliers
    if (latencyMs < 0 || latencyMs > 5000) {
        return;
    }
    
    // Add to raw samples
    latencyStats.samples.push(latencyMs);
    if (latencyStats.samples.length > 100) {
        latencyStats.samples.shift();
    }
    
    // Outlier detection using standard deviation
    if (latencyStats.samples.length >= 10) {
        const mean = latencyStats.samples.reduce((a, b) => a + b) / latencyStats.samples.length;
        const variance = latencyStats.samples.reduce((sum, val) => 
            sum + Math.pow(val - mean, 2), 0) / latencyStats.samples.length;
        const stdDev = Math.sqrt(variance);
        
        // Reject if > 2 stdDev from mean (unless stdDev is very small)
        if (stdDev > 5 && Math.abs(latencyMs - mean) > 2 * stdDev) {
            return; // Outlier - don't update display
        }
        
        latencyStats.stdDev = stdDev;
    }
    
    // Update filtered samples
    latencyStats.filtered.push(latencyMs);
    if (latencyStats.filtered.length > 30) {
        latencyStats.filtered.shift();
    }
    
    // Update stats
    latencyStats.current = latencyMs;
    latencyStats.min = Math.min(latencyStats.min, latencyMs);
    latencyStats.max = Math.max(...latencyStats.filtered);
    latencyStats.avg = latencyStats.filtered.reduce((a, b) => a + b) / latencyStats.filtered.length;
    
    // Update display elements
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
    
    // Update chart
    if (glassLatencyChart) {
        updateChart(glassLatencyChart, new Date().toLocaleTimeString(), latencyMs);
    }
}

// =============================================================================
// requestVideoFrameCallback for Frame Timing
// =============================================================================

function setupFrameCallback(video) {
    if (!('requestVideoFrameCallback' in HTMLVideoElement.prototype)) {
        console.warn('requestVideoFrameCallback not supported - using receive-time latency');
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
// Chart Functions
// =============================================================================

function initializeCharts() {
    const chartConfig = (label, color, yLabel) => ({
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
            interaction: {
                intersect: false,
                mode: 'index'
            },
            plugins: {
                legend: { display: false }
            },
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
    
    // Glass latency chart (purple theme)
    const glassChartEl = document.getElementById('glass-latency-chart');
    if (glassChartEl) {
        glassLatencyChart = new Chart(glassChartEl, chartConfig('Glass Latency', '#CE93D8', 'ms'));
    }
    
    fpsChart = new Chart(document.getElementById('fps-chart'), 
                        chartConfig('FPS', '#4CAF50', 'FPS'));
    latencyChart = new Chart(document.getElementById('latency-chart'),
                            chartConfig('RTT', '#FF9800', 'ms'));
    bitrateChart = new Chart(document.getElementById('bitrate-chart'),
                            chartConfig('Bitrate', '#2196F3', 'Mbps'));
    packetLossChart = new Chart(document.getElementById('packet-loss-chart'),
                               chartConfig('Loss', '#F44336', 'Packets'));
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
// WebRTC Stream Management
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
        clockSyncComplete = false;
        clockOffset = 0;
        timestampBuffer.clear();
        displayedFrameCount = 0;
        
        pc = new RTCPeerConnection({
            iceServers: [
                { urls: 'stun:stun.l.google.com:19302' },
                { urls: 'stun:stun1.l.google.com:19302' }
            ],
            bundlePolicy: 'max-bundle',
            rtcpMuxPolicy: 'require',
            iceCandidatePoolSize: 10
        });
        
        console.log('✅ RTCPeerConnection created');
        
        // Create DataChannel BEFORE offer (critical for proper negotiation)
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
                    console.error('Unknown data type:', typeof event.data);
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
            console.log('ICE:', pc.iceConnectionState);
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
                    
                    // Update both sidebar and overlay
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
        
        // Add video transceiver
        const trans = pc.addTransceiver('video', { direction: 'recvonly' });
        
        // Prefer H264
        const caps = RTCRtpReceiver.getCapabilities('video');
        const h264 = caps.codecs.find(c => c.mimeType === 'video/H264');
        if (h264) {
            trans.setCodecPreferences([h264]);
            console.log('✅ H264 preferred');
        }
        
        // Create offer
        const offer = await pc.createOffer({
            offerToReceiveVideo: true,
            offerToReceiveAudio: false
        });
        
        // Check DataChannel in SDP
        if (offer.sdp.includes('m=application')) {
            console.log('✅ DataChannel in SDP');
        } else {
            console.error('❌ DataChannel NOT in SDP!');
        }
        
        await pc.setLocalDescription(offer);
        
        // Send to server
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
    
    // Reset displays
    ['connection-state', 'ice-state', 'duration'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.textContent = '-';
    });
    
    console.log('Stream stopped');
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
                
                // FPS
                const fps = Math.round((report.framesReceived - lastStats.framesReceived) / dt);
                updateMetric('fps', fps, ts);
                
                // Bitrate
                const bitrate = ((report.bytesReceived - lastStats.bytesReceived) * 8 / dt / 1e6).toFixed(2);
                updateMetric('bitrate', bitrate, ts);
            }
            
            // Packet loss
            updateMetric('packetsLost', report.packetsLost || 0, ts);
            
            // Jitter
            if (report.jitter !== undefined) {
                updateMetric('jitter', (report.jitter * 1000).toFixed(2), ts);
            }
            
            // Jitter buffer delay
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
        
        // Network RTT from candidate-pair
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
    console.log('🚀 Glass-to-Glass Latency Client');
    console.log('   - Stable clock sync (moving average)');
    console.log('   - Outlier rejection (2σ threshold)');
    console.log('   - Smooth latency updates');
    
    initializeCharts();
    
    // Load config
    try {
        const response = await fetch('/config');
        const config = await response.json();
        const el = document.getElementById('sender-url');
        if (el) el.textContent = config.sender_url || 'Python Sender';
        
        if (config.latency_supported) {
            console.log('✅ Server supports glass-to-glass latency');
        }
    } catch (error) {
        console.error('Config error:', error);
    }
    
    // Bind buttons
    const startBtn = document.getElementById('start-btn');
    const stopBtn = document.getElementById('stop-btn');
    
    if (startBtn) startBtn.onclick = startStream;
    if (stopBtn) stopBtn.onclick = stopStream;
});

window.addEventListener('beforeunload', () => {
    stopStream();
});

// Export for console debugging
window.startStream = startStream;
window.stopStream = stopStream;
window.getLatencyStats = () => latencyStats;
window.getClockOffset = () => clockOffset;
