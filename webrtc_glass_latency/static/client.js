/**
 * WebRTC Video Receiver Client - Glass-to-Glass Latency Measurement
 * ==================================================================
 * 
 * Measures true end-to-end latency from camera capture to screen display.
 * 
 * =============================================================================
 * CHANGES FROM client.js (original):
 * =============================================================================
 * 1. Added DataChannel handling for receiving timestamps from sender
 * 2. Added clock synchronization via ping/pong messages
 * 3. Added timestampBuffer to store received timestamps for correlation
 * 4. Added requestVideoFrameCallback for precise frame timing
 * 5. Added latencyStats object to track min/max/avg latency
 * 6. Added glassLatencyChart for displaying latency over time
 * 7. Added updateGlassLatency function to calculate and display latency
 * 
 * =============================================================================
 * ADAPTIVE CLOCK SYNC (Latest):
 * =============================================================================
 * 8. Auto-detects clock skew between sender and receiver
 * 9. If raw latency > 1000ms: Applies two-stage offset compensation
 * 10. If raw latency < 1000ms: Uses raw latency (clocks synced)
 * 11. Works seamlessly for both same-machine and remote access scenarios
 * 
 * SCENARIOS HANDLED:
 * - Same machine access: No compensation needed (clocks synced)
 * - Remote access with clock skew: Automatic compensation applied
 * - Mixed environments: Adapts per-frame based on detection
 * =============================================================================
 */

// =============================================================================
// Global State
// =============================================================================

let pc = null;
let timestampChannel = null;
let metricsInterval = null;
let durationInterval = null;
let connectionStartTime = null;

// Chart instances
let fpsChart = null;
let latencyChart = null;
let bitrateChart = null;
let packetLossChart = null;
let glassLatencyChart = null;

// Metrics history
const MAX_HISTORY = 60;

// Statistics
let lastStats = null;
let lastStatsTime = null;

// =============================================================================
// Glass-to-Glass Latency Measurement Variables
// =============================================================================

// Timestamp correlation - stores timestamps received via DataChannel
const timestampBuffer = new Map();
const MAX_TIMESTAMP_BUFFER = 100;

// =============================================================================
// Adaptive Clock Synchronization
// =============================================================================
// Automatically detects and compensates for clock skew between machines:
// 
// DETECTION: Checks raw latency (receiveTime - capture_ms)
//   - If > 1000ms: Clock skew detected → Apply two-stage compensation
//   - If < 1000ms: Clocks synced → Use raw latency
//
// TWO-STAGE COMPENSATION (when clock skew detected):
//   offset_python_browser = offset_python_go + offset_go_browser
//   latency = raw_latency + offset_python_browser
//
// This handles:
//   ✅ Same machine access (no skew, no compensation)
//   ✅ Remote access with 22-second clock difference (auto-compensated)
//   ✅ Mixed environments (adapts automatically per frame)
// =============================================================================
let clockOffsetGoBrowser = 0;      // Go relay ↔ Browser offset (from ping/pong)
let clockOffsetPythonBrowser = 0;  // Python sender → Browser offset (calculated when needed)
let clockSyncSamples = [];
const CLOCK_SYNC_SAMPLES = 10;
let clockSyncComplete = false;
let clockSyncInterval = null;
// =============================================================================

// Latency statistics
let latencyStats = {
    samples: [],
    min: Infinity,
    max: 0,
    avg: 0,
    current: 0
};

// Frame timing using requestVideoFrameCallback API
let frameCallbackId = null;
let lastFrameTime = 0;
let frameCount = 0;


// =============================================================================
// IMPROVED: Process received timestamp from DataChannel
// =============================================================================
function processTimestamp(data) {
    const receiveTime = performance.now() + performance.timeOrigin;
    
    if (data.type === 'frame_timestamp') {
        // Store timestamp for correlation with displayed frames
        timestampBuffer.set(data.frame_num, {
            seq: data.seq,
            capture_ms: data.capture_ms,
            relay_ms: data.relay_time_ms || data.send_time_ms,
            send_ms: data.send_time_ms,
            receive_ms: receiveTime,
            frame_num: data.frame_num
        });
        
        // Cleanup old entries to prevent memory leak
        if (timestampBuffer.size > MAX_TIMESTAMP_BUFFER) {
            const oldestKey = timestampBuffer.keys().next().value;
            timestampBuffer.delete(oldestKey);
        }
        
        // =================================================================
        // ADAPTIVE CLOCK SYNC: Auto-detect and compensate for clock skew
        // =================================================================
        // Calculate raw latency (no compensation)
        const rawLatency = receiveTime - data.capture_ms;
        
        // Detect if clocks are significantly out of sync
        // Threshold: 1000ms (1 second)
        // - If rawLatency > 1000ms: Clocks are out of sync, apply compensation
        // - If rawLatency < 1000ms: Clocks are synced, use raw value
        const CLOCK_SKEW_THRESHOLD = 1000; // milliseconds
        const hasClockSkew = Math.abs(rawLatency) > CLOCK_SKEW_THRESHOLD;
        
        let networkLatency;
        let compensationApplied = false;
        
        if (hasClockSkew) {
            // =============================================================
            // SCENARIO 1: Large clock offset detected (e.g., 22 seconds)
            // =============================================================
            // Calculate Python→Browser offset using two-stage approach
            // 
            // offsetPythonGo = relay_time - send_time (Go ahead of Python)
            // offsetGoBrowser = Go - Browser (from ping/pong)
            // 
            // To get Python→Browser offset:
            // Python - Browser = -(Go - Python) + (Go - Browser)
            //                  = -offsetPythonGo + offsetGoBrowser
            //
            const offsetPythonGo = (data.relay_time_ms || data.send_time_ms) - data.send_time_ms;
            clockOffsetPythonBrowser = clockOffsetGoBrowser - offsetPythonGo;
            
            // Apply compensation
            networkLatency = rawLatency + clockOffsetPythonBrowser;
            compensationApplied = true;
            
            // Debug logging every 60 frames (~2 seconds at 30fps)
            if (data.frame_num % 60 === 0) {
                console.log(`🔧 Clock skew detected! Raw=${rawLatency.toFixed(0)}ms`);
                console.log(`   Python→Go=${offsetPythonGo.toFixed(2)}ms, Go→Browser=${clockOffsetGoBrowser.toFixed(2)}ms`);
                console.log(`   Total offset: ${clockOffsetPythonBrowser.toFixed(2)}ms`);
                console.log(`   Compensated latency: ${networkLatency.toFixed(1)}ms`);
            }
        } else {
            // =============================================================
            // SCENARIO 2: Clocks are synced (same machine or NTP synced)
            // =============================================================
            // Use raw latency directly (no compensation needed)
            networkLatency = rawLatency;
            clockOffsetPythonBrowser = 0; // No offset needed
            
            // Debug logging every 60 frames
            if (data.frame_num % 60 === 0) {
                console.log(`✅ Clocks synced! Latency=${networkLatency.toFixed(1)}ms (no compensation needed)`);
            }
        }
        // =================================================================
        
        // Update current latency estimate (with sanity check)
        if (networkLatency > 0 && networkLatency < 5000) {
            updateGlassLatency(networkLatency);
        } else {
            if (data.frame_num % 30 === 0) {  // Log every 30 frames
                const status = compensationApplied ? "compensated" : "raw";
                console.warn(`⚠️ Invalid latency: ${networkLatency.toFixed(1)}ms (${status}, receiveTime=${receiveTime.toFixed(0)}, capture=${data.capture_ms?.toFixed(0)})`);
            }
        }
    } else if (data.type === 'pong') {
        processClockSync(data);
    }
}


// =============================================================================
// IMPROVED: Process clock synchronization with outlier rejection
// =============================================================================
function processClockSync(data) {
    const receiveTime = performance.now() + performance.timeOrigin;
    const rtt = receiveTime - data.client_time;
    const oneWayDelay = rtt / 2;
    
    // Calculate clock offset: server_time + one_way_delay should equal our receive_time
    const offset = data.server_time + oneWayDelay - receiveTime;
    
    // =================================================================
    // NEW: Reject outliers (RTT > 500ms suggests network issues)
    // =================================================================
    if (rtt > 500) {
        console.warn(`⚠️ Rejecting clock sync sample - high RTT: ${rtt.toFixed(2)}ms`);
        return;
    }
    // =================================================================
    
    clockSyncSamples.push({
        offset: offset,
        rtt: rtt,
        timestamp: receiveTime
    });
    
    // Keep only recent samples
    if (clockSyncSamples.length > CLOCK_SYNC_SAMPLES * 2) {
        clockSyncSamples.shift();
    }
    
    // =================================================================
    // IMPROVED: Use median offset from samples with lowest RTT
    // =================================================================
    if (clockSyncSamples.length >= 3) {
        // Sort by RTT and take the best 50% of samples
        const sortedByRTT = [...clockSyncSamples].sort((a, b) => a.rtt - b.rtt);
        const bestSamples = sortedByRTT.slice(0, Math.ceil(sortedByRTT.length / 2));
        
        // Calculate median offset from best samples
        const offsets = bestSamples.map(s => s.offset).sort((a, b) => a - b);
        const newOffset = offsets[Math.floor(offsets.length / 2)];
        
        // =============================================================
        // Warn if offset is abnormally large (for monitoring)
        // =============================================================
        if (Math.abs(newOffset) > 5000 && !clockSyncComplete) {
            console.warn(`⚠️ Clock offset (Go relay ↔ Browser): ${newOffset.toFixed(2)}ms (${(newOffset/1000).toFixed(1)}s)`);
            console.warn(`   This is expected when accessing from a different machine.`);
            console.warn(`   Two-stage sync will compensate: Python→Go + Go→Browser`);
        }
        // =============================================================
        
        clockOffsetGoBrowser = newOffset;
        
        // =============================================================
        // NEW: Mark sync as complete after collecting enough samples
        // =============================================================
        if (clockSyncSamples.length >= CLOCK_SYNC_SAMPLES && !clockSyncComplete) {
            clockSyncComplete = true;
            console.log(`✅ Clock sync complete (Go↔Browser): ${clockOffsetGoBrowser.toFixed(2)}ms`);
            console.log(`   Python→Browser offset will be calculated from relay timestamps`);
        } else {
            console.log(`🕐 Clock sync (Go↔Browser): offset=${clockOffsetGoBrowser.toFixed(2)}ms, RTT=${rtt.toFixed(2)}ms (${clockSyncSamples.length}/${CLOCK_SYNC_SAMPLES})`);
        }
        // =============================================================
    }
}


// =============================================================================
// Send clock sync ping via DataChannel
// =============================================================================
function sendClockSyncPing() {
    if (timestampChannel && timestampChannel.readyState === 'open') {
        const ping = {
            type: 'ping',
            client_time: performance.now() + performance.timeOrigin
        };
        timestampChannel.send(JSON.stringify(ping));
    } else {
        console.warn(`⚠️ Cannot send clock sync - DataChannel state: ${timestampChannel?.readyState}`);
    }
}


// =============================================================================
// NEW: Start clock sync with rapid initial sampling
// =============================================================================
function startClockSync() {
    // Stop any existing sync
    stopClockSync();
    
    // Reset sync state
    clockSyncSamples = [];
    clockSyncComplete = false;
    
    console.log('🕐 Starting rapid clock synchronization...');
    
    // Send initial burst of pings for fast convergence
    let burstCount = 0;
    const burstInterval = setInterval(() => {
        sendClockSyncPing();
        burstCount++;
        
        if (burstCount >= CLOCK_SYNC_SAMPLES) {
            clearInterval(burstInterval);
            // Then switch to periodic sync every 5 seconds
            console.log('🕐 Initial burst complete, switching to periodic sync');
            clockSyncInterval = setInterval(sendClockSyncPing, 5000);
        }
    }, 200);  // Send 10 samples in 2 seconds
}


// =============================================================================
// NEW: Stop clock synchronization
// =============================================================================
function stopClockSync() {
    if (clockSyncInterval) {
        clearInterval(clockSyncInterval);
        clockSyncInterval = null;
    }
}


// =============================================================================
// Update glass-to-glass latency display
// =============================================================================
function updateGlassLatency(latencyMs) {
    // Sanity check
    if (latencyMs < 0 || latencyMs > 10000) {
        console.warn(`⚠️ Glass latency out of range: ${latencyMs.toFixed(1)}ms`);
        return;
    }
    
    latencyStats.current = latencyMs;
    latencyStats.samples.push(latencyMs);
    
    // Keep last 30 samples
    if (latencyStats.samples.length > 30) {
        latencyStats.samples.shift();
    }
    
    // Calculate statistics
    latencyStats.min = Math.min(latencyStats.min, latencyMs);
    latencyStats.max = Math.max(latencyStats.max, latencyMs);
    latencyStats.avg = latencyStats.samples.reduce((a, b) => a + b, 0) / latencyStats.samples.length;
    
    // Debug: log every 10th update
    if (latencyStats.samples.length % 10 === 0) {
        console.log(`📊 Glass latency stats: current=${latencyMs.toFixed(1)}, min=${latencyStats.min.toFixed(1)}, avg=${latencyStats.avg.toFixed(1)}, max=${latencyStats.max.toFixed(1)}`);
    }
    
    // Update display elements
    const glassLatencyEl = document.getElementById('glass-latency-value');
    if (glassLatencyEl) {
        glassLatencyEl.textContent = latencyMs.toFixed(1);
    }
    
    const glassLatencyMinEl = document.getElementById('glass-latency-min');
    if (glassLatencyMinEl) {
        glassLatencyMinEl.textContent = latencyStats.min.toFixed(1);
    }
    
    const glassLatencyMaxEl = document.getElementById('glass-latency-max');
    if (glassLatencyMaxEl) {
        glassLatencyMaxEl.textContent = latencyStats.max.toFixed(1);
    }
    
    const glassLatencyAvgEl = document.getElementById('glass-latency-avg');
    if (glassLatencyAvgEl) {
        glassLatencyAvgEl.textContent = latencyStats.avg.toFixed(1);
    }
    
    // Update chart
    if (glassLatencyChart) {
        const timestamp = new Date().toLocaleTimeString();
        updateChart(glassLatencyChart, timestamp, latencyMs);
    }
}


// =============================================================================
// Setup requestVideoFrameCallback for precise frame timing
// =============================================================================
function setupFrameCallback(video) {
    if (!('requestVideoFrameCallback' in HTMLVideoElement.prototype)) {
        console.warn('requestVideoFrameCallback not supported');
        return;
    }
    
    const frameCallback = (now, metadata) => {
        frameCount++;
        
        if (metadata.presentationTime) {
            const displayTime = metadata.presentationTime;
            const approxFrameNum = metadata.presentedFrames || frameCount;
            
            // Look for matching timestamp in buffer (with some tolerance)
            for (const [frameNum, tsData] of timestampBuffer) {
                if (Math.abs(frameNum - approxFrameNum) < 5) {
                    // Calculate glass-to-glass latency
                    const captureTime = tsData.capture_ms;
                    // Don't apply clock offset - Python and browser clocks are synchronized
                    const displayTimeMs = displayTime;
                    
                    const glassLatency = displayTimeMs - captureTime;
                    
                    if (glassLatency > 0 && glassLatency < 5000) {
                        // Add display buffer estimate (~16ms for 60Hz)
                        const displayBufferMs = 16;
                        updateGlassLatency(glassLatency + displayBufferMs);
                    }
                    
                    // Remove used timestamp
                    timestampBuffer.delete(frameNum);
                    break;
                }
            }
        }
        
        lastFrameTime = now;
        frameCallbackId = video.requestVideoFrameCallback(frameCallback);
    };
    
    frameCallbackId = video.requestVideoFrameCallback(frameCallback);
    console.log('✅ requestVideoFrameCallback enabled for precise frame timing');
}


// =============================================================================
// Chart Initialization
// =============================================================================

function initializeCharts() {
    const chartConfig = (label, color, yAxisLabel) => ({
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
                legend: {
                    display: true,
                    labels: { color: 'white' }
                },
                tooltip: {
                    enabled: true,
                    backgroundColor: 'rgba(0, 0, 0, 0.8)',
                    titleColor: 'white',
                    bodyColor: 'white'
                }
            },
            scales: {
                x: {
                    display: true,
                    grid: { color: 'rgba(255, 255, 255, 0.1)' },
                    ticks: { color: 'white', maxTicksLimit: 10 }
                },
                y: {
                    display: true,
                    grid: { color: 'rgba(255, 255, 255, 0.1)' },
                    ticks: { color: 'white' },
                    title: {
                        display: true,
                        text: yAxisLabel,
                        color: 'white'
                    },
                    beginAtZero: true
                }
            }
        }
    });
    
    fpsChart = new Chart(
        document.getElementById('fps-chart'),
        chartConfig('Frame Rate', '#4CAF50', 'FPS')
    );
    
    latencyChart = new Chart(
        document.getElementById('latency-chart'),
        chartConfig('Network RTT', '#FF9800', 'ms')
    );
    
    bitrateChart = new Chart(
        document.getElementById('bitrate-chart'),
        chartConfig('Bitrate', '#2196F3', 'Mbps')
    );
    
    packetLossChart = new Chart(
        document.getElementById('packet-loss-chart'),
        chartConfig('Packet Loss', '#F44336', 'Packets')
    );
    
    const glassChartEl = document.getElementById('glass-latency-chart');
    if (glassChartEl) {
        glassLatencyChart = new Chart(
            glassChartEl,
            chartConfig('Glass-to-Glass Latency', '#9C27B0', 'ms')
        );
    }
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
        
        // =================================================================
        // IMPROVED: Reset all latency measurement state
        // =================================================================
        latencyStats = { samples: [], min: Infinity, max: 0, avg: 0, current: 0 };
        clockSyncSamples = [];
        clockSyncComplete = false;  // ADDED: Reset sync completion flag
        timestampBuffer.clear();
        // =================================================================
        
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
        
        // =================================================================
        // DataChannel Setup
        // =================================================================
        timestampChannel = pc.createDataChannel('timestamps', {
            ordered: true
        });
        console.log('📡 Created DataChannel: timestamps');
        
        // =================================================================
        // IMPROVED: Use startClockSync() for better initialization
        // =================================================================
        timestampChannel.onopen = () => {
            console.log('📡 Timestamp DataChannel OPEN - starting clock sync');
            startClockSync();  // CHANGED: Use new rapid sync function
        };
        // =================================================================
        
        timestampChannel.onclose = () => {
            console.log('📡 Timestamp DataChannel CLOSED');
        };
        
        timestampChannel.onerror = (error) => {
            console.error('📡 Timestamp DataChannel ERROR:', error);
        };
        
        timestampChannel.onmessage = (event) => {
            try {
                let jsonString;
                if (typeof event.data === 'string') {
                    jsonString = event.data;
                } else if (event.data instanceof ArrayBuffer) {
                    jsonString = new TextDecoder().decode(event.data);
                } else if (event.data instanceof Blob) {
                    console.warn('Received Blob data, converting...');
                    event.data.text().then(text => {
                        const data = JSON.parse(text);
                        processTimestamp(data);
                    });
                    return;
                } else {
                    console.error('Unknown data type:', typeof event.data);
                    return;
                }
                
                const data = JSON.parse(jsonString);
                processTimestamp(data);
            } catch (e) {
                console.error('Failed to parse timestamp:', e, 'Raw data:', event.data);
            }
        };
        
        pc.onconnectionstatechange = () => {
            console.log('Connection state:', pc.connectionState);
            const stateEl = document.getElementById('connection-state');
            if (stateEl) stateEl.textContent = pc.connectionState;
            
            if (pc.connectionState === 'connected') {
                updateStatus('connected', '✓ Connected - Measuring Glass-to-Glass Latency');
                const overlay = document.getElementById('video-overlay');
                if (overlay) overlay.style.display = 'block';
                connectionStartTime = Date.now();
                startDurationTimer();
            } else if (pc.connectionState === 'disconnected' || pc.connectionState === 'failed') {
                updateStatus(pc.connectionState === 'failed' ? 'error' : 'disconnected', 
                           pc.connectionState === 'failed' ? 'Connection Failed' : 'Disconnected');
                stopStream();
            }
        };
        
        pc.oniceconnectionstatechange = () => {
            console.log('ICE connection state:', pc.iceConnectionState);
            const iceEl = document.getElementById('ice-state');
            if (iceEl) iceEl.textContent = pc.iceConnectionState;
        };
        
        pc.ontrack = (event) => {
            console.log('✅ Received remote track:', event.track.kind);
            
            if (event.track.kind === 'video') {
                const video = document.getElementById('video');
                video.srcObject = event.streams[0];
                video.playsInline = true;
                
                video.onloadedmetadata = () => {
                    const resolution = `${video.videoWidth}x${video.videoHeight}`;
                    const resEl = document.getElementById('resolution-value');
                    const overlayResEl = document.getElementById('overlay-resolution');
                    if (resEl) resEl.textContent = resolution;
                    if (overlayResEl) overlayResEl.textContent = resolution;
                    console.log('✅ Video metadata:', resolution);
                    
                    setupFrameCallback(video);
                };
                
                setTimeout(() => {
                    video.play().then(() => {
                        console.log('✅ Video playback started');
                    }).catch(err => {
                        console.error('Video play failed:', err);
                    });
                }, 100);
            }
        };
        
        // Add video transceiver
        const transceiver = pc.addTransceiver('video', { direction: 'recvonly' });
        
        // Prefer H264 for lower latency
        const capabilities = RTCRtpReceiver.getCapabilities('video');
        const h264Codec = capabilities.codecs.find(codec => 
            codec.mimeType === 'video/H264'
        );
        if (h264Codec) {
            transceiver.setCodecPreferences([h264Codec]);
            console.log('✅ H264 codec preference set');
        }
        
        // Create and send offer
        const offer = await pc.createOffer({
            offerToReceiveVideo: true,
            offerToReceiveAudio: false
        });
        
        console.log('📋 Offer SDP created');
        if (offer.sdp.includes('m=application')) {
            console.log('✅ DataChannel IS in offer SDP (m=application found)');
        } else {
            console.error('❌ DataChannel NOT in offer SDP - check createDataChannel!');
        }
        
        await pc.setLocalDescription(offer);
        console.log('Created offer, sending to server...');
        
        const response = await fetch('/offer', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                sdp: pc.localDescription.sdp,
                type: pc.localDescription.type
            })
        });
        
        if (!response.ok) {
            const error = await response.json();
            throw new Error(error.error || 'Failed to get answer');
        }
        
        const answer = await response.json();
        await pc.setRemoteDescription(new RTCSessionDescription(answer));
        console.log('Remote description set');
        
        startMetricsCollection();
        
        stopBtn.disabled = false;
        
    } catch (error) {
        console.error('Error starting stream:', error);
        updateStatus('error', 'Error: ' + error.message);
        startBtn.disabled = false;
        stopStream();
    }
}


// =============================================================================
// IMPROVED: Stop stream with clock sync cleanup
// =============================================================================
function stopStream() {
    console.log('Stopping stream...');
    
    stopMetricsCollection();
    stopDurationTimer();
    stopClockSync();  // NEW: Stop clock synchronization
    
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
            console.error('Error collecting stats:', error);
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
    
    stats.forEach(report => {
        if (report.type === 'inbound-rtp' && report.kind === 'video') {
            // FPS
            if (lastStats && lastStats.framesReceived !== undefined) {
                const timeDelta = (now - lastStatsTime) / 1000;
                const framesDelta = report.framesReceived - lastStats.framesReceived;
                const fps = framesDelta / timeDelta;
                updateMetric('fps', Math.round(fps));
            }
            
            // Bitrate
            if (lastStats && lastStats.bytesReceived !== undefined) {
                const timeDelta = (now - lastStatsTime) / 1000;
                const bytesDelta = report.bytesReceived - lastStats.bytesReceived;
                const bitrate = (bytesDelta * 8) / timeDelta / 1000000;
                updateMetric('bitrate', bitrate.toFixed(2));
            }
            
            // Packet loss
            updateMetric('packetsLost', report.packetsLost || 0);
            
            // Jitter
            const jitter = report.jitter ? (report.jitter * 1000).toFixed(2) : 0;
            updateMetric('jitter', jitter);
            
            // Jitter buffer delay
            if (report.jitterBufferDelay && report.jitterBufferEmittedCount) {
                const jbDelay = (report.jitterBufferDelay / report.jitterBufferEmittedCount * 1000).toFixed(2);
                updateMetric('jitterBuffer', jbDelay);
            }
            
            lastStats = {
                framesReceived: report.framesReceived,
                bytesReceived: report.bytesReceived
            };
            lastStatsTime = now;
        }
        
        // Network RTT from candidate-pair stats
        if (report.type === 'candidate-pair' && report.state === 'succeeded') {
            if (report.currentRoundTripTime !== undefined && report.currentRoundTripTime > 0) {
                const rtt = (report.currentRoundTripTime * 1000).toFixed(2);
                updateMetric('latency', rtt);
            } else if (report.currentRoundTripTime === 0) {
                // Localhost or same machine - RTT is effectively 0
                updateMetric('latency', '< 1');
            }
        }
    });
}

function updateMetric(metric, value) {
    const timestamp = new Date().toLocaleTimeString();
    
    switch (metric) {
        case 'fps':
            const fpsEl = document.getElementById('fps-value');
            const overlayFpsEl = document.getElementById('overlay-fps');
            if (fpsEl) fpsEl.textContent = value;
            if (overlayFpsEl) overlayFpsEl.textContent = value;
            updateChart(fpsChart, timestamp, value);
            break;
            
        case 'resolution':
            const resEl = document.getElementById('resolution-value');
            const overlayResEl = document.getElementById('overlay-resolution');
            if (resEl) resEl.textContent = value;
            if (overlayResEl) overlayResEl.textContent = value;
            break;
            
        case 'latency':
            const latEl = document.getElementById('latency-value');
            if (latEl) latEl.textContent = value;
            updateChart(latencyChart, timestamp, parseFloat(value));
            break;
            
        case 'bitrate':
            const brEl = document.getElementById('bitrate-value');
            if (brEl) brEl.textContent = value;
            updateChart(bitrateChart, timestamp, parseFloat(value));
            break;
            
        case 'packetsLost':
            const plEl = document.getElementById('packets-lost-value');
            if (plEl) plEl.textContent = value;
            updateChart(packetLossChart, timestamp, value);
            break;
            
        case 'jitter':
            const jitEl = document.getElementById('jitter-value');
            if (jitEl) jitEl.textContent = value;
            break;
        
        case 'jitterBuffer':
            const jbEl = document.getElementById('jitter-buffer-value');
            if (jbEl) jbEl.textContent = value;
            break;
    }
}


// =============================================================================
// Duration Timer
// =============================================================================

function startDurationTimer() {
    if (durationInterval) return;
    
    durationInterval = setInterval(() => {
        if (connectionStartTime) {
            const duration = Date.now() - connectionStartTime;
            const seconds = Math.floor(duration / 1000) % 60;
            const minutes = Math.floor(duration / 60000) % 60;
            const hours = Math.floor(duration / 3600000);
            
            const formatted = `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
            const durEl = document.getElementById('duration');
            if (durEl) durEl.textContent = formatted;
        }
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
    console.log('🚀 Glass-to-Glass Latency Measurement Client (Adaptive Clock Sync)');
    console.log('   Auto-detects clock skew and applies compensation when needed');
    console.log('   Threshold: 1000ms - automatically switches between modes');
    
    initializeCharts();
    
    try {
        const response = await fetch('/config');
        const config = await response.json();
        const senderEl = document.getElementById('sender-url');
        if (senderEl) senderEl.textContent = config.sender_url;
        
        if (config.latency_supported) {
            console.log('✅ Server supports glass-to-glass latency measurement');
        }
    } catch (error) {
        console.error('Failed to load config:', error);
    }
    
    const startBtn = document.getElementById('start-btn');
    const stopBtn = document.getElementById('stop-btn');
    
    if (startBtn) startBtn.onclick = startStream;
    if (stopBtn) stopBtn.onclick = stopStream;
});

window.addEventListener('beforeunload', () => {
    stopStream();
});

window.startStream = startStream;
window.stopStream = stopStream;