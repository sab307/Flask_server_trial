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
 * =============================================================================
 */

// =============================================================================
// Global State
// =============================================================================

let pc = null;
// =============================================================================
// NEW: DataChannel for receiving timestamps
// =============================================================================
// PREVIOUS (in client.js): (not present)
let timestampChannel = null;  // NEW: DataChannel for timestamps
// =============================================================================
let metricsInterval = null;
let durationInterval = null;
let connectionStartTime = null;

// Chart instances
let fpsChart = null;
let latencyChart = null;
let bitrateChart = null;
let packetLossChart = null;
// =============================================================================
// NEW: Glass-to-glass latency chart
// =============================================================================
// PREVIOUS (in client.js): (not present)
let glassLatencyChart = null;  // NEW: Glass-to-glass latency chart
// =============================================================================

// Metrics history
const MAX_HISTORY = 60;

// Statistics
let lastStats = null;
let lastStatsTime = null;

// =============================================================================
// NEW: Glass-to-Glass Latency Measurement Variables
// =============================================================================
// PREVIOUS (in client.js): (none of these were present)

// Timestamp correlation - stores timestamps received via DataChannel
const timestampBuffer = new Map();  // seq -> {capture_ms, relay_ms, receive_ms}
const MAX_TIMESTAMP_BUFFER = 100;

// Clock synchronization - accounts for clock difference between sender and receiver
let clockOffset = 0;  // Difference between sender and receiver clocks (ms)
let clockSyncSamples = [];
const CLOCK_SYNC_SAMPLES = 5;

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

// END OF NEW Variables
// =============================================================================


// =============================================================================
// NEW: Process received timestamp from DataChannel
// =============================================================================
// PREVIOUS (in client.js): (not present)
//
// NEW: Function to handle incoming timestamp messages
function processTimestamp(data) {
    const receiveTime = performance.now() + performance.timeOrigin;
    
    if (data.type === 'frame_timestamp') {
        // =================================================================
        // PREVIOUS CODE (no debug logging):
        // =================================================================
        // // Store timestamp for correlation with displayed frames
        // timestampBuffer.set(data.frame_num, {
        //     seq: data.seq,
        //     capture_ms: data.capture_ms,
        //     relay_ms: data.relay_time_ms || data.send_time_ms,
        //     receive_ms: receiveTime,
        //     frame_num: data.frame_num
        // });
        // 
        // // Cleanup old entries to prevent memory leak
        // if (timestampBuffer.size > MAX_TIMESTAMP_BUFFER) {
        //     const oldestKey = timestampBuffer.keys().next().value;
        //     timestampBuffer.delete(oldestKey);
        // }
        // 
        // // Calculate latency using most recent timestamp
        // const networkLatency = receiveTime - data.capture_ms - clockOffset;
        // 
        // // Update current latency estimate (with sanity check)
        // if (networkLatency > 0 && networkLatency < 5000) {
        //     updateGlassLatency(networkLatency);
        // }
        // =================================================================
        
        // =================================================================
        // NEW CODE (with debug logging):
        // =================================================================
        // Debug logging
        console.log(`📡 Timestamp received: frame=${data.frame_num}, capture=${data.capture_ms?.toFixed(0)}, clockOffset=${clockOffset.toFixed(2)}`);
        
        // Store timestamp for correlation with displayed frames
        timestampBuffer.set(data.frame_num, {
            seq: data.seq,
            capture_ms: data.capture_ms,
            relay_ms: data.relay_time_ms || data.send_time_ms,
            receive_ms: receiveTime,
            frame_num: data.frame_num
        });
        
        // Cleanup old entries to prevent memory leak
        if (timestampBuffer.size > MAX_TIMESTAMP_BUFFER) {
            const oldestKey = timestampBuffer.keys().next().value;
            timestampBuffer.delete(oldestKey);
        }
        
        // Calculate latency using most recent timestamp
        // This gives us network + processing latency (not including display)
        const networkLatency = receiveTime - data.capture_ms - clockOffset;
        
        // Debug logging
        console.log(`📊 Network latency: ${networkLatency.toFixed(1)}ms (receiveTime=${receiveTime.toFixed(0)}, capture=${data.capture_ms?.toFixed(0)}, offset=${clockOffset.toFixed(2)})`);
        
        // Update current latency estimate (with sanity check)
        if (networkLatency > 0 && networkLatency < 5000) {
            updateGlassLatency(networkLatency);
        } else {
            console.warn(`⚠️ Invalid latency: ${networkLatency.toFixed(1)}ms - clock may not be synced yet`);
        }
        // =================================================================
    } else if (data.type === 'pong') {
        // Clock sync response from server
        // =================================================================
        // PREVIOUS CODE: processClockSync(data);
        // NEW CODE (with logging):
        // =================================================================
        console.log(`🕐 Clock sync pong received`);
        processClockSync(data);
        // =================================================================
    }
}
// END OF NEW processTimestamp
// =============================================================================


// =============================================================================
// NEW: Process clock synchronization pong
// =============================================================================
// PREVIOUS (in client.js): (not present)
//
// NEW: Calculate clock offset between sender and receiver
function processClockSync(data) {
    const receiveTime = performance.now() + performance.timeOrigin;
    const rtt = receiveTime - data.client_time;
    const oneWayDelay = rtt / 2;
    
    // Calculate clock offset: server_time + one_way_delay should equal our receive_time
    const offset = data.server_time + oneWayDelay - receiveTime;
    
    clockSyncSamples.push({
        offset: offset,
        rtt: rtt
    });
    
    // Keep only recent samples
    if (clockSyncSamples.length > CLOCK_SYNC_SAMPLES) {
        clockSyncSamples.shift();
    }
    
    // Use median offset (more robust than mean)
    if (clockSyncSamples.length >= 3) {
        const offsets = clockSyncSamples.map(s => s.offset).sort((a, b) => a - b);
        clockOffset = offsets[Math.floor(offsets.length / 2)];
        console.log(`Clock offset: ${clockOffset.toFixed(2)}ms (RTT: ${rtt.toFixed(2)}ms)`);
    }
}
// END OF NEW processClockSync
// =============================================================================


// =============================================================================
// NEW: Send clock sync ping via DataChannel
// =============================================================================
// PREVIOUS (in client.js): (not present)
//
// NEW: Send ping to server for clock synchronization
function sendClockSyncPing() {
    // =========================================================================
    // PREVIOUS CODE (no debug logging):
    // =========================================================================
    // if (timestampChannel && timestampChannel.readyState === 'open') {
    //     const ping = {
    //         type: 'ping',
    //         client_time: performance.now() + performance.timeOrigin
    //     };
    //     timestampChannel.send(JSON.stringify(ping));
    // }
    // =========================================================================
    
    // =========================================================================
    // NEW CODE (with debug logging):
    // =========================================================================
    if (timestampChannel && timestampChannel.readyState === 'open') {
        const ping = {
            type: 'ping',
            client_time: performance.now() + performance.timeOrigin
        };
        console.log(`🕐 Sending clock sync ping: client_time=${ping.client_time.toFixed(0)}`);
        timestampChannel.send(JSON.stringify(ping));
    } else {
        console.warn(`⚠️ Cannot send clock sync - DataChannel state: ${timestampChannel?.readyState}`);
    }
    // =========================================================================
}
// END OF NEW sendClockSyncPing
// =============================================================================


// =============================================================================
// NEW: Update glass-to-glass latency display
// =============================================================================
// PREVIOUS (in client.js): (not present)
//
// NEW: Calculate statistics and update UI
function updateGlassLatency(latencyMs) {
    // =========================================================================
    // PREVIOUS CODE (minimal implementation):
    // =========================================================================
    // // Sanity check
    // if (latencyMs < 0 || latencyMs > 10000) return;
    // 
    // latencyStats.current = latencyMs;
    // latencyStats.samples.push(latencyMs);
    // 
    // // Keep last 30 samples
    // if (latencyStats.samples.length > 30) {
    //     latencyStats.samples.shift();
    // }
    // 
    // // Calculate statistics
    // latencyStats.min = Math.min(latencyStats.min, latencyMs);
    // latencyStats.max = Math.max(latencyStats.max, latencyMs);
    // latencyStats.avg = latencyStats.samples.reduce((a, b) => a + b, 0) / latencyStats.samples.length;
    // 
    // // Update display elements
    // const glassLatencyEl = document.getElementById('glass-latency-value');
    // if (glassLatencyEl) {
    //     glassLatencyEl.textContent = latencyMs.toFixed(1);
    // }
    // 
    // const glassLatencyMinEl = document.getElementById('glass-latency-min');
    // if (glassLatencyMinEl) {
    //     glassLatencyMinEl.textContent = latencyStats.min.toFixed(1);
    // }
    // 
    // const glassLatencyMaxEl = document.getElementById('glass-latency-max');
    // if (glassLatencyMaxEl) {
    //     glassLatencyMaxEl.textContent = latencyStats.max.toFixed(1);
    // }
    // 
    // const glassLatencyAvgEl = document.getElementById('glass-latency-avg');
    // if (glassLatencyAvgEl) {
    //     glassLatencyAvgEl.textContent = latencyStats.avg.toFixed(1);
    // }
    // 
    // // Update chart
    // if (glassLatencyChart) {
    //     const timestamp = new Date().toLocaleTimeString();
    //     updateChart(glassLatencyChart, timestamp, latencyMs);
    // }
    // =========================================================================
    
    // =========================================================================
    // NEW CODE (with debug logging and element warnings):
    // =========================================================================
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
    } else {
        console.warn('⚠️ glass-latency-value element not found');
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
    // =========================================================================
}
// END OF NEW updateGlassLatency
// =============================================================================


// =============================================================================
// NEW: Setup requestVideoFrameCallback for precise frame timing
// =============================================================================
// PREVIOUS (in client.js): (not present)
//
// NEW: Use Video Frame Callback API for frame-accurate timing
function setupFrameCallback(video) {
    if (!('requestVideoFrameCallback' in HTMLVideoElement.prototype)) {
        console.warn('requestVideoFrameCallback not supported');
        return;
    }
    
    const frameCallback = (now, metadata) => {
        frameCount++;
        
        // metadata contains:
        // - presentationTime: when the frame was presented
        // - expectedDisplayTime: when it should be displayed
        // - mediaTime: media timeline position
        // - presentedFrames: total frames presented
        
        if (metadata.presentationTime) {
            const displayTime = metadata.presentationTime;
            
            // Try to correlate with a timestamp from buffer
            const approxFrameNum = metadata.presentedFrames || frameCount;
            
            // Look for matching timestamp in buffer (with some tolerance)
            for (const [frameNum, tsData] of timestampBuffer) {
                if (Math.abs(frameNum - approxFrameNum) < 5) {
                    // Calculate glass-to-glass latency
                    const captureTime = tsData.capture_ms;
                    const adjustedCaptureTime = captureTime + clockOffset;
                    const displayTimeMs = displayTime;
                    
                    const glassLatency = displayTimeMs - adjustedCaptureTime;
                    
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
// END OF NEW setupFrameCallback
// =============================================================================


// =============================================================================
// Chart Initialization
// =============================================================================
// CHANGED: Added glassLatencyChart initialization

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
    
    // =========================================================================
    // NEW: Initialize glass-to-glass latency chart
    // =========================================================================
    // PREVIOUS (in client.js): (not present)
    const glassChartEl = document.getElementById('glass-latency-chart');
    if (glassChartEl) {
        glassLatencyChart = new Chart(
            glassChartEl,
            chartConfig('Glass-to-Glass Latency', '#9C27B0', 'ms')
        );
    }
    // =========================================================================
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
// CHANGED: Added DataChannel handling and latency measurement setup

async function startStream() {
    const startBtn = document.getElementById('start-btn');
    const stopBtn = document.getElementById('stop-btn');
    
    try {
        startBtn.disabled = true;
        updateStatus('connecting', 'Connecting...');
        
        // =====================================================================
        // NEW: Reset latency stats on new connection
        // =====================================================================
        // PREVIOUS (in client.js): (not present)
        latencyStats = { samples: [], min: Infinity, max: 0, avg: 0, current: 0 };
        clockSyncSamples = [];
        timestampBuffer.clear();
        // =====================================================================
        
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
        
        // =====================================================================
        // NEW: Handle DataChannel for timestamps
        // =====================================================================
        // PREVIOUS (in client.js): (not present - no DataChannel handling)
        //
        // =============================================================
        // PREVIOUS APPROACH (server creates DataChannel - DIDN'T WORK):
        // =============================================================
        // The server created DataChannel after receiving offer, but this
        // caused DataChannel to stay in "connecting" state forever because
        // it wasn't included in the SDP negotiation.
        //
        // pc.ondatachannel = (event) => {
        //     if (event.channel.label === 'timestamps') {
        //         timestampChannel = event.channel;
        //         // ... handlers
        //     }
        // };
        // =============================================================
        
        // =============================================================
        // NEW APPROACH: Browser creates DataChannel (included in offer)
        // =============================================================
        // Browser creates DataChannel BEFORE creating offer, so it's
        // included in the SDP. Server receives it via ondatachannel.
        timestampChannel = pc.createDataChannel('timestamps', {
            ordered: true
        });
        console.log('📡 Created DataChannel: timestamps');
        
        timestampChannel.onopen = () => {
            console.log('📡 Timestamp DataChannel OPEN - starting clock sync');
            
            // Start clock synchronization
            sendClockSyncPing();
            setInterval(sendClockSyncPing, 5000);  // Sync every 5 seconds
        };
        
        timestampChannel.onclose = () => {
            console.log('📡 Timestamp DataChannel CLOSED');
        };
        
        timestampChannel.onerror = (error) => {
            console.error('📡 Timestamp DataChannel ERROR:', error);
        };
        
        timestampChannel.onmessage = (event) => {
            try {
                // =========================================================
                // PREVIOUS CODE (assumed string data):
                // =========================================================
                // const data = JSON.parse(event.data);
                // processTimestamp(data);
                // =========================================================
                
                // =========================================================
                // NEW CODE (handle both string and binary data):
                // =========================================================
                // DataChannel can receive either string (text) or ArrayBuffer (binary)
                // Go's SendText() sends string, Send() sends binary
                let jsonString;
                if (typeof event.data === 'string') {
                    jsonString = event.data;
                } else if (event.data instanceof ArrayBuffer) {
                    // Convert ArrayBuffer to string
                    jsonString = new TextDecoder().decode(event.data);
                } else if (event.data instanceof Blob) {
                    // Handle Blob (shouldn't happen but just in case)
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
                // =========================================================
            } catch (e) {
                console.error('Failed to parse timestamp:', e, 'Raw data:', event.data);
            }
        };
        // =============================================================
        // END OF NEW DataChannel handling
        // =====================================================================
        
        pc.onconnectionstatechange = () => {
            console.log('Connection state:', pc.connectionState);
            const stateEl = document.getElementById('connection-state');
            if (stateEl) stateEl.textContent = pc.connectionState;
            
            if (pc.connectionState === 'connected') {
                // CHANGED: Updated status message
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
                    // =============================================================
                    // PREVIOUS CODE (single element update):
                    // =============================================================
                    // const resEl = document.getElementById('resolution-value');
                    // if (resEl) resEl.textContent = resolution;
                    // =============================================================
                    
                    // =============================================================
                    // NEW CODE (update both sidebar and overlay):
                    // =============================================================
                    const resEl = document.getElementById('resolution-value');
                    const overlayResEl = document.getElementById('overlay-resolution');
                    if (resEl) resEl.textContent = resolution;
                    if (overlayResEl) overlayResEl.textContent = resolution;
                    // =============================================================
                    console.log('✅ Video metadata:', resolution);
                    
                    // =============================================================
                    // NEW: Setup precise frame timing callback
                    // =============================================================
                    // PREVIOUS (in client.js): (not present)
                    setupFrameCallback(video);
                    // =============================================================
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
        
        // =================================================================
        // NEW: Debug logging to verify DataChannel is in offer SDP
        // =================================================================
        console.log('📋 Offer SDP created');
        if (offer.sdp.includes('m=application')) {
            console.log('✅ DataChannel IS in offer SDP (m=application found)');
        } else {
            console.error('❌ DataChannel NOT in offer SDP - check createDataChannel!');
        }
        // =================================================================
        
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
// CHANGED: stopStream now cleans up latency measurement resources
// =============================================================================
function stopStream() {
    console.log('Stopping stream...');
    
    stopMetricsCollection();
    stopDurationTimer();
    
    // =========================================================================
    // NEW: Cancel frame callback
    // =========================================================================
    // PREVIOUS (in client.js): (not present)
    if (frameCallbackId !== null) {
        const video = document.getElementById('video');
        if (video && video.cancelVideoFrameCallback) {
            video.cancelVideoFrameCallback(frameCallbackId);
        }
        frameCallbackId = null;
    }
    // =========================================================================
    
    if (pc) {
        pc.close();
        pc = null;
    }
    
    // =========================================================================
    // NEW: Clear timestamp channel
    // =========================================================================
    // PREVIOUS (in client.js): (not present)
    timestampChannel = null;
    // =========================================================================
    
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
// Metrics Collection (mostly unchanged)
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

// =============================================================================
// CHANGED: processStats now also extracts jitter buffer delay
// =============================================================================
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
            
            // =================================================================
            // NEW: Extract jitter buffer delay
            // =================================================================
            // PREVIOUS (in client.js): (not present)
            if (report.jitterBufferDelay && report.jitterBufferEmittedCount) {
                const jbDelay = (report.jitterBufferDelay / report.jitterBufferEmittedCount * 1000).toFixed(2);
                updateMetric('jitterBuffer', jbDelay);
            }
            // =================================================================
            
            lastStats = {
                framesReceived: report.framesReceived,
                bytesReceived: report.bytesReceived
            };
            lastStatsTime = now;
        }
        
        // =====================================================================
        // CHANGED: Network RTT calculation
        // =====================================================================
        // PREVIOUS CODE (only works for sender, not receiver):
        // =====================================================================
        // // Network RTT from remote-inbound-rtp (only available on sender side)
        // if (report.type === 'remote-inbound-rtp' && report.kind === 'video') {
        //     if (report.roundTripTime !== undefined && report.roundTripTime > 0) {
        //         const rtt = (report.roundTripTime * 1000).toFixed(2);
        //         updateMetric('latency', rtt);
        //     }
        // }
        // =====================================================================
        
        // =====================================================================
        // NEW CODE: Use candidate-pair stats for RTT (works for receiver)
        // =====================================================================
        // The 'candidate-pair' stats contain currentRoundTripTime which is
        // measured via STUN connectivity checks and works for both sender/receiver
        if (report.type === 'candidate-pair' && report.state === 'succeeded') {
            if (report.currentRoundTripTime !== undefined && report.currentRoundTripTime > 0) {
                const rtt = (report.currentRoundTripTime * 1000).toFixed(2);
                updateMetric('latency', rtt);
            }
        }
        // =====================================================================
    });
}

// =============================================================================
// CHANGED: updateMetric now handles jitterBuffer metric
// =============================================================================
// =============================================================================
// CHANGED: updateMetric now handles jitterBuffer metric and updates both overlay and sidebar
// =============================================================================
function updateMetric(metric, value) {
    const timestamp = new Date().toLocaleTimeString();
    
    switch (metric) {
        case 'fps':
            // =============================================================
            // PREVIOUS CODE (single element update):
            // =============================================================
            // const fpsEl = document.getElementById('fps-value');
            // if (fpsEl) fpsEl.textContent = value;
            // updateChart(fpsChart, timestamp, value);
            // =============================================================
            
            // =============================================================
            // NEW CODE (update both sidebar and overlay):
            // =============================================================
            const fpsEl = document.getElementById('fps-value');
            const overlayFpsEl = document.getElementById('overlay-fps');
            if (fpsEl) fpsEl.textContent = value;
            if (overlayFpsEl) overlayFpsEl.textContent = value;
            updateChart(fpsChart, timestamp, value);
            // =============================================================
            break;
            
        case 'resolution':
            // =============================================================
            // NEW: Update both sidebar and overlay for resolution
            // =============================================================
            const resEl = document.getElementById('resolution-value');
            const overlayResEl = document.getElementById('overlay-resolution');
            if (resEl) resEl.textContent = value;
            if (overlayResEl) overlayResEl.textContent = value;
            // =============================================================
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
        
        // =================================================================
        // NEW: Handle jitter buffer metric
        // =================================================================
        // PREVIOUS (in client.js): (not present)
        case 'jitterBuffer':
            const jbEl = document.getElementById('jitter-buffer-value');
            if (jbEl) jbEl.textContent = value;
            break;
        // =================================================================
    }
}

// =============================================================================
// Duration Timer (unchanged)
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
// CHANGED: Added check for latency support in config

window.addEventListener('DOMContentLoaded', async () => {
    // CHANGED: Updated log message
    console.log('🚀 Glass-to-Glass Latency Measurement Client initialized');
    
    initializeCharts();
    
    try {
        const response = await fetch('/config');
        const config = await response.json();
        const senderEl = document.getElementById('sender-url');
        if (senderEl) senderEl.textContent = config.sender_url;
        
        // =================================================================
        // NEW: Check if server supports latency measurement
        // =================================================================
        // PREVIOUS (in client.js): (not present)
        if (config.latency_supported) {
            console.log('✅ Server supports glass-to-glass latency measurement');
        }
        // =================================================================
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