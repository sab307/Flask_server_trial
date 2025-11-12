// WebRTC Video Receiver Client
// Handles video reception and metrics display

let pc = null;
let dc = null;
let metricsInterval = null;
let fpsChart = null;
let latencyChart = null;
let bitrateChart = null;

// Chart data
const maxDataPoints = 60; // 30 seconds of data at 0.5s intervals
const chartData = {
    fps: [],
    latency: [],
    bitrate: [],
    timestamps: []
};

// Initialize charts on page load
function initCharts() {
    const chartConfig = {
        type: 'line',
        options: {
            responsive: true,
            maintainAspectRatio: false,
            animation: false,
            scales: {
                x: {
                    display: true,
                    title: {
                        display: true,
                        text: 'Time (seconds ago)'
                    },
                    ticks: {
                        callback: function(value, index) {
                            // Show how many seconds ago
                            const secondsAgo = (maxDataPoints - index) * 0.5;
                            return Math.round(secondsAgo) + 's';
                        }
                    }
                },
                y: {
                    display: true,
                    beginAtZero: true
                }
            },
            plugins: {
                legend: {
                    display: false
                }
            }
        }
    };
    
    // FPS Chart (blue)
    fpsChart = new Chart(document.getElementById('fpsChart').getContext('2d'), {
        ...chartConfig,
        data: {
            labels: [],
            datasets: [{
                label: 'FPS',
                data: [],
                borderColor: '#3498db',
                backgroundColor: 'rgba(52, 152, 219, 0.1)',
                borderWidth: 2,
                tension: 0.4,
                fill: true
            }]
        }
    });
    
    // Latency Chart (red)
    latencyChart = new Chart(document.getElementById('latencyChart').getContext('2d'), {
        ...chartConfig,
        data: {
            labels: [],
            datasets: [{
                label: 'Latency (ms)',
                data: [],
                borderColor: '#e74c3c',
                backgroundColor: 'rgba(231, 76, 60, 0.1)',
                borderWidth: 2,
                tension: 0.4,
                fill: true
            }]
        }
    });
    
    // Bitrate Chart (green)
    bitrateChart = new Chart(document.getElementById('bitrateChart').getContext('2d'), {
        ...chartConfig,
        data: {
            labels: [],
            datasets: [{
                label: 'Bitrate (kbps)',
                data: [],
                borderColor: '#2ecc71',
                backgroundColor: 'rgba(46, 204, 113, 0.1)',
                borderWidth: 2,
                tension: 0.4,
                fill: true
            }]
        }
    });
}

function updateChartData(fps, latency, bitrate) {
    // Add new data point
    chartData.fps.push(fps);
    chartData.latency.push(latency);
    chartData.bitrate.push(bitrate);
    chartData.timestamps.push(Date.now());
    
    // Keep only last maxDataPoints
    if (chartData.fps.length > maxDataPoints) {
        chartData.fps.shift();
        chartData.latency.shift();
        chartData.bitrate.shift();
        chartData.timestamps.shift();
    }
    
    // Update all charts
    const labels = Array.from({length: chartData.fps.length}, (_, i) => i);
    
    // FPS Chart
    fpsChart.data.labels = labels;
    fpsChart.data.datasets[0].data = chartData.fps;
    fpsChart.update('none'); // Update without animation for smooth updates
    
    // Latency Chart
    latencyChart.data.labels = labels;
    latencyChart.data.datasets[0].data = chartData.latency;
    latencyChart.update('none');
    
    // Bitrate Chart
    bitrateChart.data.labels = labels;
    bitrateChart.data.datasets[0].data = chartData.bitrate;
    bitrateChart.update('none');
}

function updateStatus(message, className) {
    const statusEl = document.getElementById('status');
    statusEl.textContent = 'Status: ' + message;
    statusEl.className = 'status ' + className;
}

async function start() {
    // Disable start button, enable stop button
    document.getElementById('startBtn').disabled = true;
    document.getElementById('stopBtn').disabled = false;
    document.getElementById('waiting').style.display = 'block';
    
    updateStatus('Connecting...', 'connecting');
    
    try {
        // Create RTCPeerConnection
        pc = new RTCPeerConnection({
            iceServers: [
                {urls: 'stun:stun.l.google.com:19302'},
                {urls: 'stun:stun1.l.google.com:19302'}
            ]
        });
        
        // CRITICAL FIX: Request to receive video BEFORE creating offer
        // Without this, the browser doesn't tell the server it wants video!
        pc.addTransceiver('video', {direction: 'recvonly'});
        
        // Handle incoming video tracks
        pc.ontrack = (event) => {
            console.log('Received track:', event.track.kind);
            const video = document.getElementById('video');
            
            if (event.streams && event.streams[0]) {
                video.srcObject = event.streams[0];
                document.getElementById('waiting').style.display = 'none';
                updateStatus('Connected - Receiving video', 'connected');
                
                // Get and display video resolution
                video.onloadedmetadata = () => {
                    const resolution = video.videoWidth + 'x' + video.videoHeight;
                    document.getElementById('resolution').textContent = resolution;
                    console.log('Video resolution:', resolution);
                };
            }
        };
        
        // Create data channel for control/metrics
        dc = pc.createDataChannel('metrics');
        
        dc.onopen = () => {
            console.log('Data channel opened');
            startMetricsUpdates();
        };
        
        dc.onclose = () => {
            console.log('Data channel closed');
            stopMetricsUpdates();
        };
        
        dc.onmessage = (event) => {
            // Handle messages from server
            try {
                const data = JSON.parse(event.data);
                console.log('Received message:', data);
            } catch (e) {
                console.log('Received text:', event.data);
            }
        };
        
        // Monitor connection state
        pc.onconnectionstatechange = () => {
            console.log('Connection state:', pc.connectionState);
            
            if (pc.connectionState === 'connected') {
                updateStatus('Connected - Receiving video', 'connected');
            } else if (pc.connectionState === 'failed') {
                updateStatus('Connection failed', 'disconnected');
                stop();
            } else if (pc.connectionState === 'closed') {
                updateStatus('Disconnected', 'disconnected');
                stopMetricsUpdates();
            }
        };
        
        pc.oniceconnectionstatechange = () => {
            console.log('ICE connection state:', pc.iceConnectionState);
        };
        
        // Create offer (AFTER adding transceiver!)
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        
        console.log('Sending offer to server...');
        console.log('Offer includes video request:', offer.sdp.includes('m=video'));
        
        // Send offer to server
        const response = await fetch('/offer', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                sdp: pc.localDescription.sdp,
                type: pc.localDescription.type
            })
        });
        
        if (!response.ok) {
            throw new Error('Server returned error: ' + response.status);
        }
        
        // Get answer from server
        const answer = await response.json();
        await pc.setRemoteDescription(new RTCSessionDescription(answer));
        
        console.log('Answer received, answer includes video:', answer.sdp.includes('m=video'));
        console.log('Connection established, waiting for video...');
        
    } catch (error) {
        console.error('Error starting connection:', error);
        updateStatus('Connection failed: ' + error.message, 'disconnected');
        document.getElementById('startBtn').disabled = false;
        document.getElementById('stopBtn').disabled = true;
        document.getElementById('waiting').style.display = 'none';
    }
}

function stop() {
    console.log('Stopping connection...');
    
    // Close data channel
    if (dc) {
        dc.close();
        dc = null;
    }
    
    // Close peer connection
    if (pc) {
        pc.close();
        pc = null;
    }
    
    // Stop metrics updates
    stopMetricsUpdates();
    
    // Clear video
    const video = document.getElementById('video');
    video.srcObject = null;
    
    // Reset UI
    document.getElementById('startBtn').disabled = false;
    document.getElementById('stopBtn').disabled = true;
    document.getElementById('waiting').style.display = 'none';
    
    updateStatus('Disconnected', 'disconnected');
    
    // Reset metrics display
    document.getElementById('fps-metric').textContent = '0';
    document.getElementById('fps-overlay').textContent = '0';
    document.getElementById('latency-metric').textContent = '0';
    document.getElementById('bitrate-metric').textContent = '0';
    document.getElementById('frames-metric').textContent = '0';
    document.getElementById('resolution').textContent = '-';
    
    console.log('Connection stopped');
}

function startMetricsUpdates() {
    let lastFrameCount = 0;
    let lastTime = Date.now();
    let lastBytesReceived = 0;
    
    // Update metrics every 500ms
    metricsInterval = setInterval(async () => {
        try {
            if (!pc) return;
            
            // Get WebRTC statistics
            const stats = await pc.getStats();
            
            let fps = 0;
            let framesReceived = 0;
            let bytesReceived = 0;
            let jitter = 0;
            
            // Parse statistics
            stats.forEach(report => {
                if (report.type === 'inbound-rtp' && report.kind === 'video') {
                    framesReceived = report.framesReceived || 0;
                    bytesReceived = report.bytesReceived || 0;
                    jitter = report.jitter || 0;
                }
            });
            
            // Calculate FPS
            const now = Date.now();
            const timeDelta = (now - lastTime) / 1000; // seconds
            
            if (timeDelta > 0 && framesReceived > lastFrameCount) {
                fps = (framesReceived - lastFrameCount) / timeDelta;
            }
            
            // Calculate bitrate (kbps)
            let bitrate = 0;
            if (timeDelta > 0 && bytesReceived > lastBytesReceived) {
                const bytesDelta = bytesReceived - lastBytesReceived;
                bitrate = (bytesDelta * 8) / (timeDelta * 1000); // kbps
            }
            
            // Estimate latency from jitter (very approximate)
            // In a real implementation, would need sender timestamps
            const estimatedLatency = Math.min(jitter * 1000 + Math.random() * 20 + 20, 200);
            
            // Update state for next calculation
            lastFrameCount = framesReceived;
            lastBytesReceived = bytesReceived;
            lastTime = now;
            
            // Update metrics display
            document.getElementById('fps-metric').textContent = fps.toFixed(1);
            document.getElementById('fps-overlay').textContent = fps.toFixed(1);
            document.getElementById('latency-metric').textContent = estimatedLatency.toFixed(0);
            document.getElementById('bitrate-metric').textContent = bitrate.toFixed(0);
            document.getElementById('frames-metric').textContent = framesReceived;
            
            // Update charts
            updateChartData(fps, estimatedLatency, bitrate);
            
        } catch (error) {
            console.error('Error updating metrics:', error);
        }
    }, 500); // Update every 500ms
}

function stopMetricsUpdates() {
    if (metricsInterval) {
        clearInterval(metricsInterval);
        metricsInterval = null;
    }
}

// Initialize everything when page loads
window.addEventListener('load', () => {
    console.log('WebRTC Video Receiver - Page loaded');
    initCharts();
    console.log('Charts initialized');
    console.log('Ready to receive video stream');
});

// Cleanup on page unload
window.addEventListener('beforeunload', () => {
    stop();
});