/**
 * WebRTC Video Receiver Client with Latency Measurement
 * Handles WebRTC connection, metrics collection, and real-time visualization
 */

// Global state
let pc = null;
let dc = null;
let metricsInterval = null;
let durationInterval = null;
let connectionStartTime = null;

// Chart instances
let fpsChart = null;
let latencyChart = null;
let bitrateChart = null;
let packetLossChart = null;

// Metrics history
const MAX_HISTORY = 60;

// Statistics
let lastStats = null;
let lastStatsTime = null;

/**
 * Initialize the application when page loads
 */
window.addEventListener('DOMContentLoaded', async () => {
    console.log('WebRTC Receiver Client initialized');
    
    initializeCharts();
    
    try {
        const response = await fetch('/config');
        const config = await response.json();
        document.getElementById('sender-url').textContent = config.sender_url;
    } catch (error) {
        console.error('Failed to load config:', error);
    }
    
    const startBtn = document.getElementById('start-btn');
    const stopBtn = document.getElementById('stop-btn');
    
    if (startBtn) startBtn.onclick = startStream;
    if (stopBtn) stopBtn.onclick = stopStream;
});

/**
 * Initialize Chart.js charts
 */
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
        chartConfig('Latency', '#FF9800', 'Milliseconds')
    );
    
    bitrateChart = new Chart(
        document.getElementById('bitrate-chart'),
        chartConfig('Bitrate', '#2196F3', 'Mbps')
    );
    
    packetLossChart = new Chart(
        document.getElementById('packet-loss-chart'),
        chartConfig('Packet Loss', '#F44336', 'Packets')
    );
}

/**
 * Update chart with new data point
 */
function updateChart(chart, label, value) {
    if (chart.data.labels.length >= MAX_HISTORY) {
        chart.data.labels.shift();
        chart.data.datasets[0].data.shift();
    }
    
    chart.data.labels.push(label);
    chart.data.datasets[0].data.push(value);
    chart.update('none');
}

/**
 * Update status banner
 */
function updateStatus(status, message) {
    const banner = document.getElementById('status-banner');
    const text = document.getElementById('status-text');
    
    banner.className = 'status-banner ' + status;
    text.textContent = message;
}

/**
 * Start the WebRTC video stream
 */
async function startStream() {
    const startBtn = document.getElementById('start-btn');
    const stopBtn = document.getElementById('stop-btn');
    
    try {
        startBtn.disabled = true;
        updateStatus('connecting', 'Connecting...');
        
        pc = new RTCPeerConnection({
            iceServers: [
                { urls: 'stun:stun.l.google.com:19302' },
                { urls: 'stun:stun1.l.google.com:19302' }
            ]
        });
        
        console.log('RTCPeerConnection created');
        
        pc.onconnectionstatechange = () => {
            console.log('Connection state:', pc.connectionState);
            document.getElementById('connection-state').textContent = pc.connectionState;
            
            if (pc.connectionState === 'connected') {
                updateStatus('connected', '✓ Connected - Streaming');
                document.getElementById('video-overlay').style.display = 'block';
                connectionStartTime = Date.now();
                startDurationTimer();
            } else if (pc.connectionState === 'disconnected') {
                updateStatus('disconnected', 'Disconnected');
                stopStream();
            } else if (pc.connectionState === 'failed') {
                updateStatus('error', 'Connection Failed');
                stopStream();
            }
        };
        
        pc.oniceconnectionstatechange = () => {
            console.log('ICE connection state:', pc.iceConnectionState);
            document.getElementById('ice-state').textContent = pc.iceConnectionState;
        };
        
        pc.ontrack = (event) => {
            console.log('✅ Received remote track:', event.track.kind);
            console.log('Track settings:', event.track.getSettings());
    
            if (event.track.kind === 'video') {
                const video = document.getElementById('video');
        
                console.log('Setting srcObject on video element');
                video.srcObject = event.streams[0];
        
                video.onloadedmetadata = () => {
                    const resolution = `${video.videoWidth}x${video.videoHeight}`;
                    document.getElementById('resolution-value').textContent = resolution;
                    console.log('✅ Video metadata loaded:', resolution);
                };
        
                video.onloadeddata = () => {
                    console.log('✅ Video data loaded');
                };
        
                video.onplay = () => {
                    console.log('✅ Video started playing');
                };
        
                video.onerror = (e) => {
                    console.error('❌ Video element error:', e);
                    console.error('Video error code:', video.error?.code);
                    console.error('Video error message:', video.error?.message);
                };
        
                video.onstalled = () => {
                    console.warn('⚠️  Video stalled');
                };
        
                setTimeout(() => {
                    console.log('Attempting to play video...');
                    video.play().then(() => {
                        console.log('✅ Video play successful');
                    }).catch(err => {
                        console.error('❌ Video play failed:', err);
                    });
                }, 1000);
            }   
        };
        
        // Add transceiver for receiving video
        pc.addTransceiver('video', { direction: 'recvonly' });
        
        // Create offer
        const offer = await pc.createOffer();
        
        console.log('📤 LOCAL SDP (Offer):\n', offer.sdp);

        await pc.setLocalDescription(offer);
        console.log('Created offer, sending to server...');
        
        // Send offer to Go server
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
        console.log('📥 REMOTE SDP (Answer):\n', answer.sdp);
        console.log('Set remote description (answer)');
        
        startMetricsCollection();
        
        stopBtn.disabled = false;
        
    } catch (error) {
        console.error('Error starting stream:', error);
        updateStatus('error', 'Error: ' + error.message);
        startBtn.disabled = false;
        stopStream();
    }
}

/**
 * Stop the WebRTC stream
 */
function stopStream() {
    console.log('Stopping stream...');
    
    stopMetricsCollection();
    stopDurationTimer();
    
    if (pc) {
        pc.close();
        pc = null;
    }
    
    const video = document.getElementById('video');
    video.srcObject = null;
    
    document.getElementById('video-overlay').style.display = 'none';
    document.getElementById('start-btn').disabled = false;
    document.getElementById('stop-btn').disabled = true;
    updateStatus('disconnected', 'Disconnected');
    
    document.getElementById('connection-state').textContent = '-';
    document.getElementById('ice-state').textContent = '-';
    document.getElementById('duration').textContent = '-';
    
    console.log('Stream stopped');
}

/**
 * Start metrics collection
 */
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

/**
 * Stop metrics collection
 */
function stopMetricsCollection() {
    if (metricsInterval) {
        clearInterval(metricsInterval);
        metricsInterval = null;
    }
    lastStats = null;
    lastStatsTime = null;
}

/**
 * Process WebRTC statistics
 */
function processStats(stats) {
    const now = Date.now();
    
    stats.forEach(report => {
        // Process video inbound-rtp stats
        if (report.type === 'inbound-rtp' && report.kind === 'video') {
            // Calculate FPS
            if (lastStats && lastStats.framesReceived !== undefined) {
                const timeDelta = (now - lastStatsTime) / 1000;
                const framesDelta = report.framesReceived - lastStats.framesReceived;
                const fps = framesDelta / timeDelta;
                updateMetric('fps', Math.round(fps));
            }
            
            // Calculate bitrate
            if (lastStats && lastStats.bytesReceived !== undefined) {
                const timeDelta = (now - lastStatsTime) / 1000;
                const bytesDelta = report.bytesReceived - lastStats.bytesReceived;
                const bitrate = (bytesDelta * 8) / timeDelta / 1000000;
                updateMetric('bitrate', bitrate.toFixed(2));
            }
            
            // Packet loss
            const packetsLost = report.packetsLost || 0;
            updateMetric('packetsLost', packetsLost);
            
            // Jitter
            const jitter = report.jitter ? (report.jitter * 1000).toFixed(2) : 0;
            updateMetric('jitter', jitter);
            
            lastStats = {
                framesReceived: report.framesReceived,
                bytesReceived: report.bytesReceived
            };
            lastStatsTime = now;
        }
        
        // ✅ NEW: Process candidate-pair stats for latency (RTT)
        if (report.type === 'candidate-pair' && report.state === 'succeeded') {
            if (report.currentRoundTripTime !== undefined) {
                // Convert from seconds to milliseconds
                const latency = (report.currentRoundTripTime * 1000).toFixed(2);
                updateMetric('latency', latency);
            }
        }
    });
}

/**
 * Update metric display and chart
 */
function updateMetric(metric, value) {
    const timestamp = new Date().toLocaleTimeString();
    
    switch (metric) {
        case 'fps':
            document.getElementById('fps-value').textContent = value;
            updateChart(fpsChart, timestamp, value);
            break;
            
        case 'latency':
            document.getElementById('latency-value').textContent = value;
            updateChart(latencyChart, timestamp, value);
            break;
            
        case 'bitrate':
            document.getElementById('bitrate-value').textContent = value;
            updateChart(bitrateChart, timestamp, value);
            break;
            
        case 'packetsLost':
            document.getElementById('packets-lost-value').textContent = value;
            updateChart(packetLossChart, timestamp, value);
            break;
            
        case 'jitter':
            document.getElementById('jitter-value').textContent = value;
            break;
    }
}

/**
 * Start duration timer
 */
function startDurationTimer() {
    if (durationInterval) return;
    
    durationInterval = setInterval(() => {
        if (connectionStartTime) {
            const duration = Date.now() - connectionStartTime;
            const seconds = Math.floor(duration / 1000) % 60;
            const minutes = Math.floor(duration / 60000) % 60;
            const hours = Math.floor(duration / 3600000);
            
            const formatted = `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
            document.getElementById('duration').textContent = formatted;
        }
    }, 1000);
}

/**
 * Stop duration timer
 */
function stopDurationTimer() {
    if (durationInterval) {
        clearInterval(durationInterval);
        durationInterval = null;
    }
    connectionStartTime = null;
}

window.addEventListener('beforeunload', () => {
    stopStream();
});

window.startStream = startStream;
window.stopStream = stopStream;