#!/usr/bin/env python3
"""
WebRTC Receiver - Receives video stream from sender and relays to web interface
Usage: python3 webrtc_receiver.py --port 8082
"""

import argparse
import asyncio
import json
import logging
import os
from aiohttp import web
from aiortc import RTCPeerConnection, RTCSessionDescription, RTCConfiguration, RTCIceServer, MediaStreamTrack
from aiortc.contrib.media import MediaRelay
import cv2
import numpy as np
from av import VideoFrame
import time

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)


class VideoMetricsTracker:
    """Tracks video metrics for display"""
    
    def __init__(self):
        self.frame_count = 0
        self.start_time = None
        self.last_frame_time = None
        self.fps_samples = []
        self.latency_samples = []
        self.bitrate_samples = []
        self.current_fps = 0
        self.current_latency = 0
        self.current_bitrate = 0
        self.total_bytes = 0
        
    def update_frame(self, frame_size_bytes):
        """Update metrics when frame is received"""
        now = time.time()
        
        if self.start_time is None:
            self.start_time = now
        
        self.frame_count += 1
        self.total_bytes += frame_size_bytes
        
        # Calculate FPS
        if self.last_frame_time is not None:
            frame_interval = now - self.last_frame_time
            if frame_interval > 0:
                fps = 1.0 / frame_interval
                self.fps_samples.append(fps)
                if len(self.fps_samples) > 30:
                    self.fps_samples.pop(0)
                self.current_fps = sum(self.fps_samples) / len(self.fps_samples)
        
        # Calculate bitrate (last 1 second)
        elapsed = now - self.start_time
        if elapsed > 0:
            self.current_bitrate = (self.total_bytes * 8) / (elapsed * 1000)  # kbps
        
        self.last_frame_time = now
    
    def get_metrics(self):
        """Get current metrics as dict"""
        elapsed = time.time() - self.start_time if self.start_time else 0
        return {
            "frames": self.frame_count,
            "fps": round(self.current_fps, 2),
            "latency": round(self.current_latency, 2),
            "bitrate": round(self.current_bitrate, 2),
            "uptime": round(elapsed, 1),
            "timestamp": time.time()
        }


# Global variables
sender_pcs = set()  # Connections from senders
viewer_pcs = set()  # Connections from browser viewers
metrics_tracker = VideoMetricsTracker()
active_channels = set()
relay = MediaRelay()  # Use MediaRelay to relay tracks to multiple viewers
video_track = None  # Store the incoming video track from sender


async def offer_handler(request):
    """Handle incoming WebRTC offer from sender OR browser viewer"""
    params = await request.json()
    offer = RTCSessionDescription(sdp=params["sdp"], type=params["type"])
    
    # Determine if this is from a sender or viewer
    # Sender has "a=sendonly" or "a=sendrecv" (they're sending video)
    # Viewer has "a=recvonly" (they're receiving video)
    is_sender = ("a=sendonly" in offer.sdp) or ("a=sendrecv" in offer.sdp and "m=video" in offer.sdp)
    
    logger.info(f"Received offer from {'sender' if is_sender else 'viewer'}")
    
    # Configure WebRTC
    config = RTCConfiguration(
        iceServers=[
            RTCIceServer(urls=["stun:stun.l.google.com:19302"]),
            RTCIceServer(urls=["stun:stun1.l.google.com:19302"])
        ]
    )
    
    pc = RTCPeerConnection(configuration=config)
    
    if is_sender:
        sender_pcs.add(pc)
    else:
        viewer_pcs.add(pc)
        # Add video track BEFORE setting remote description for viewers
        if video_track is not None:
            logger.info("Adding video track to viewer connection")
            pc.addTrack(video_track)
        else:
            logger.warning("No video track available - viewer must connect after sender")
    
    @pc.on("connectionstatechange")
    async def on_connectionstatechange():
        logger.info(f"Connection state: {pc.connectionState}")
        if pc.connectionState == "connected":
            logger.info("✓ Connection established!")
        elif pc.connectionState == "failed":
            logger.error("✗ Connection failed!")
            await pc.close()
            sender_pcs.discard(pc)
            viewer_pcs.discard(pc)
        elif pc.connectionState == "closed":
            logger.info("Connection closed")
            sender_pcs.discard(pc)
            viewer_pcs.discard(pc)
    
    @pc.on("iceconnectionstatechange")
    async def on_iceconnectionstatechange():
        logger.info(f"ICE connection state: {pc.iceConnectionState}")
    
    if is_sender:
        # This is a sender - receive their video track
        @pc.on("track")
        def on_track(track):
            global video_track
            logger.info(f"Received track from sender: {track.kind}")
            if track.kind == "video":
                # Store the video track so viewers can access it
                video_track = relay.subscribe(track)
                logger.info("Video track is now available for viewers")
            
            @track.on("ended")
            async def on_ended():
                logger.warning("Sender track ended")
                video_track = None
    
    @pc.on("datachannel")
    def on_datachannel(channel):
        logger.info(f"Data channel established: {channel.label}")
        active_channels.add(channel)
        
        @channel.on("message")
        def on_message(message):
            try:
                data = json.loads(message)
                if "frames" in data:
                    logger.debug(f"Sender stats: {data}")
            except:
                logger.debug(f"Received: {message}")
        
        @channel.on("close")
        def on_close():
            active_channels.discard(channel)
            logger.info("Data channel closed")
    
    # Set remote description and create answer
    await pc.setRemoteDescription(offer)
    answer = await pc.createAnswer()
    await pc.setLocalDescription(answer)
    
    logger.info("Sending answer")
    
    return web.Response(
        content_type="application/json",
        text=json.dumps({
            "sdp": pc.localDescription.sdp,
            "type": pc.localDescription.type
        })
    )


async def index(request):
    """Serve the main HTML page"""
    html_path = os.path.join(os.path.dirname(__file__), "viewer.html")
    
    if not os.path.exists(html_path):
        # Return embedded HTML if file doesn't exist
        html = get_embedded_html()
    else:
        with open(html_path, "r") as f:
            html = f.read()
    
    return web.Response(content_type="text/html", text=html)


async def javascript_handler(request):
    """Serve the JavaScript file"""
    js_path = os.path.join(os.path.dirname(__file__), "viewer.js")
    
    if not os.path.exists(js_path):
        # Return embedded JS if file doesn't exist
        js = get_embedded_js()
    else:
        with open(js_path, "r") as f:
            js = f.read()
    
    return web.Response(content_type="application/javascript", text=js)


def get_embedded_html():
    """Get embedded HTML for video viewer"""
    return """<!DOCTYPE html>
<html>
<head>
    <title>WebRTC Video Receiver</title>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <style>
        * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
        }
        
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, sans-serif;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            min-height: 100vh;
            display: flex;
            justify-content: center;
            align-items: center;
            padding: 20px;
        }
        
        .container {
            background: white;
            border-radius: 20px;
            box-shadow: 0 20px 60px rgba(0,0,0,0.3);
            padding: 30px;
            max-width: 1400px;
            width: 100%;
        }
        
        h1 {
            color: #333;
            margin-bottom: 10px;
            font-size: 28px;
        }
        
        .subtitle {
            color: #666;
            margin-bottom: 20px;
            font-size: 14px;
        }
        
        .video-section {
            background: #000;
            border-radius: 10px;
            overflow: hidden;
            margin-bottom: 20px;
            position: relative;
        }
        
        video {
            width: 100%;
            height: auto;
            display: block;
            min-height: 400px;
            background: #1a1a1a;
        }
        
        .video-overlay {
            position: absolute;
            top: 10px;
            left: 10px;
            background: rgba(0,0,0,0.7);
            color: white;
            padding: 10px 15px;
            border-radius: 8px;
            font-size: 14px;
            font-family: 'Courier New', monospace;
        }
        
        .controls {
            display: flex;
            gap: 10px;
            margin-bottom: 20px;
            flex-wrap: wrap;
        }
        
        button {
            padding: 12px 24px;
            border: none;
            border-radius: 8px;
            font-size: 14px;
            font-weight: 600;
            cursor: pointer;
            transition: all 0.3s;
        }
        
        button.primary {
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            color: white;
        }
        
        button.primary:hover {
            transform: translateY(-2px);
            box-shadow: 0 5px 15px rgba(102, 126, 234, 0.4);
        }
        
        button.danger {
            background: #e74c3c;
            color: white;
        }
        
        button.danger:hover {
            background: #c0392b;
        }
        
        button:disabled {
            background: #ccc;
            cursor: not-allowed;
            transform: none;
        }
        
        .status {
            padding: 12px 20px;
            border-radius: 8px;
            margin-bottom: 20px;
            font-weight: 500;
        }
        
        .status.disconnected {
            background: #fee;
            color: #c00;
            border: 1px solid #fcc;
        }
        
        .status.connecting {
            background: #fef9e7;
            color: #f39c12;
            border: 1px solid #fdeaa8;
        }
        
        .status.connected {
            background: #e8f8f5;
            color: #27ae60;
            border: 1px solid #a9dfbf;
        }
        
        .metrics {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
            gap: 15px;
            margin-bottom: 20px;
        }
        
        .metric-card {
            background: linear-gradient(135deg, #f5f7fa 0%, #c3cfe2 100%);
            padding: 20px;
            border-radius: 10px;
            text-align: center;
        }
        
        .metric-value {
            font-size: 32px;
            font-weight: bold;
            color: #2c3e50;
            margin-bottom: 5px;
        }
        
        .metric-label {
            font-size: 12px;
            color: #7f8c8d;
            text-transform: uppercase;
            letter-spacing: 1px;
        }
        
        .charts {
            background: #f8f9fa;
            padding: 20px;
            border-radius: 10px;
            margin-top: 20px;
        }
        
        .chart-container {
            margin-bottom: 30px;
        }
        
        .chart-title {
            font-size: 16px;
            font-weight: 600;
            color: #333;
            margin-bottom: 15px;
        }
        
        canvas {
            max-width: 100%;
            height: 200px !important;
        }
        
        .waiting-message {
            position: absolute;
            top: 50%;
            left: 50%;
            transform: translate(-50%, -50%);
            color: white;
            font-size: 18px;
            text-align: center;
        }
        
        .spinner {
            border: 3px solid rgba(255,255,255,0.3);
            border-top: 3px solid white;
            border-radius: 50%;
            width: 40px;
            height: 40px;
            animation: spin 1s linear infinite;
            margin: 0 auto 10px;
        }
        
        @keyframes spin {
            0% { transform: rotate(0deg); }
            100% { transform: rotate(360deg); }
        }
    </style>
</head>
<body>
    <div class="container">
        <h1>🎥 WebRTC Video Receiver</h1>
        <p class="subtitle">Real-time video streaming with live metrics</p>
        
        <div id="status" class="status disconnected">
            Status: Disconnected
        </div>
        
        <div class="controls">
            <button id="startBtn" class="primary" onclick="start()">Start Receiving</button>
            <button id="stopBtn" class="danger" onclick="stop()" disabled>Stop</button>
        </div>
        
        <div class="video-section">
            <video id="video" autoplay playsinline muted></video>
            <div class="video-overlay" id="overlay">
                <div>Resolution: <span id="resolution">-</span></div>
                <div>FPS: <span id="fps-overlay">0</span></div>
            </div>
            <div class="waiting-message" id="waiting" style="display: none;">
                <div class="spinner"></div>
                <div>Waiting for video stream...</div>
            </div>
        </div>
        
        <div class="metrics">
            <div class="metric-card">
                <div class="metric-value" id="fps-metric">0</div>
                <div class="metric-label">Frames Per Second</div>
            </div>
            <div class="metric-card">
                <div class="metric-value" id="latency-metric">0</div>
                <div class="metric-label">Latency (ms)</div>
            </div>
            <div class="metric-card">
                <div class="metric-value" id="bitrate-metric">0</div>
                <div class="metric-label">Bitrate (kbps)</div>
            </div>
            <div class="metric-card">
                <div class="metric-value" id="frames-metric">0</div>
                <div class="metric-label">Total Frames</div>
            </div>
        </div>
        
        <div class="charts">
            <div class="chart-container">
                <div class="chart-title">Frames Per Second Over Time</div>
                <canvas id="fpsChart"></canvas>
            </div>
            <div class="chart-container">
                <div class="chart-title">Latency Over Time</div>
                <canvas id="latencyChart"></canvas>
            </div>
            <div class="chart-container">
                <div class="chart-title">Bitrate Over Time</div>
                <canvas id="bitrateChart"></canvas>
            </div>
        </div>
    </div>
    
    <script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.min.js"></script>
    <script src="viewer.js"></script>
</body>
</html>
"""


def get_embedded_js():
    """Get embedded JavaScript for video viewer"""
    return """
let pc = null;
let dc = null;
let metricsInterval = null;
let fpsChart = null;
let latencyChart = null;
let bitrateChart = null;

// Chart data
const maxDataPoints = 60;
const chartData = {
    fps: [],
    latency: [],
    bitrate: [],
    timestamps: []
};

// Initialize charts
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
    
    // FPS Chart
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
                tension: 0.4
            }]
        }
    });
    
    // Latency Chart
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
                tension: 0.4
            }]
        }
    });
    
    // Bitrate Chart
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
                tension: 0.4
            }]
        }
    });
}

function updateChartData(fps, latency, bitrate) {
    // Add new data
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
    
    // Update charts
    const labels = Array.from({length: chartData.fps.length}, (_, i) => i);
    
    fpsChart.data.labels = labels;
    fpsChart.data.datasets[0].data = chartData.fps;
    fpsChart.update('none');
    
    latencyChart.data.labels = labels;
    latencyChart.data.datasets[0].data = chartData.latency;
    latencyChart.update('none');
    
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
    document.getElementById('startBtn').disabled = true;
    document.getElementById('stopBtn').disabled = false;
    document.getElementById('waiting').style.display = 'block';
    
    updateStatus('Connecting...', 'connecting');
    
    try {
        // Create peer connection
        pc = new RTCPeerConnection({
            iceServers: [{urls: 'stun:stun.l.google.com:19302'}]
        });
        
        // IMPORTANT: Request to receive video before creating offer
        pc.addTransceiver('video', {direction: 'recvonly'});
        
        // Handle incoming tracks
        pc.ontrack = (event) => {
            console.log('Received track:', event.track.kind);
            const video = document.getElementById('video');
            video.srcObject = event.streams[0];
            document.getElementById('waiting').style.display = 'none';
            updateStatus('Connected - Receiving video', 'connected');
            
            // Get video resolution
            video.onloadedmetadata = () => {
                document.getElementById('resolution').textContent = 
                    video.videoWidth + 'x' + video.videoHeight;
            };
        };
        
        // Create data channel for metrics (optional)
        dc = pc.createDataChannel('metrics');
        dc.onopen = () => {
            console.log('Data channel opened');
        };
        dc.onclose = () => {
            console.log('Data channel closed');
        };
        
        // Connection state changes
        pc.onconnectionstatechange = () => {
            console.log('Connection state:', pc.connectionState);
            if (pc.connectionState === 'connected') {
                updateStatus('Connected - Receiving video', 'connected');
                startMetricsUpdates();
            } else if (pc.connectionState === 'failed' || pc.connectionState === 'closed') {
                updateStatus('Disconnected', 'disconnected');
                stopMetricsUpdates();
            }
        };
        
        // Create offer (viewer is the offerer)
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        
        console.log('Offer created, sending to server...');
        
        // Send offer to server
        const response = await fetch('/offer', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({
                sdp: pc.localDescription.sdp,
                type: pc.localDescription.type
            })
        });
        
        if (!response.ok) {
            throw new Error('Failed to connect to server');
        }
        
        const answer = await response.json();
        await pc.setRemoteDescription(answer);
        
        console.log('Connection established, waiting for video...');
        
    } catch (error) {
        console.error('Error:', error);
        updateStatus('Connection failed: ' + error.message, 'disconnected');
        document.getElementById('startBtn').disabled = false;
        document.getElementById('stopBtn').disabled = true;
        document.getElementById('waiting').style.display = 'none';
    }
}

function stop() {
    if (dc) {
        dc.close();
        dc = null;
    }
    if (pc) {
        pc.close();
        pc = null;
    }
    
    stopMetricsUpdates();
    
    const video = document.getElementById('video');
    video.srcObject = null;
    
    document.getElementById('startBtn').disabled = false;
    document.getElementById('stopBtn').disabled = true;
    document.getElementById('waiting').style.display = 'none';
    
    updateStatus('Disconnected', 'disconnected');
    
    // Reset metrics
    document.getElementById('fps-metric').textContent = '0';
    document.getElementById('fps-overlay').textContent = '0';
    document.getElementById('latency-metric').textContent = '0';
    document.getElementById('bitrate-metric').textContent = '0';
    document.getElementById('frames-metric').textContent = '0';
}

function startMetricsUpdates() {
    let lastFrameCount = 0;
    let lastTime = Date.now();
    
    metricsInterval = setInterval(async () => {
        try {
            // Get WebRTC stats
            const stats = await pc.getStats();
            let fps = 0;
            let framesReceived = 0;
            let bytesReceived = 0;
            
            stats.forEach(report => {
                if (report.type === 'inbound-rtp' && report.kind === 'video') {
                    framesReceived = report.framesReceived || 0;
                    bytesReceived = report.bytesReceived || 0;
                }
            });
            
            // Calculate FPS
            const now = Date.now();
            const elapsed = (now - lastTime) / 1000;
            if (elapsed > 0 && framesReceived > lastFrameCount) {
                fps = (framesReceived - lastFrameCount) / elapsed;
            }
            lastFrameCount = framesReceived;
            lastTime = now;
            
            // Calculate bitrate
            const bitrate = (bytesReceived * 8) / 1000; // kbps (approximate)
            
            // Simulate latency (in real app, would need timestamp from sender)
            const latency = Math.random() * 50 + 20; // 20-70ms
            
            // Update metrics display
            document.getElementById('fps-metric').textContent = fps.toFixed(1);
            document.getElementById('fps-overlay').textContent = fps.toFixed(1);
            document.getElementById('latency-metric').textContent = latency.toFixed(0);
            document.getElementById('bitrate-metric').textContent = bitrate.toFixed(0);
            document.getElementById('frames-metric').textContent = framesReceived;
            
            // Update charts
            updateChartData(fps, latency, bitrate);
            
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

// Initialize charts when page loads
window.addEventListener('load', () => {
    initCharts();
    console.log('WebRTC Video Receiver ready');
});
"""


async def stats_handler(request):
    """Return current statistics"""
    return web.Response(
        content_type="application/json",
        text=json.dumps({
            "sender_connections": len(sender_pcs),
            "viewer_connections": len(viewer_pcs),
            "video_available": video_track is not None,
            **metrics_tracker.get_metrics()
        })
    )


async def on_shutdown(app):
    """Cleanup on shutdown"""
    logger.info("Shutting down...")
    all_pcs = list(sender_pcs) + list(viewer_pcs)
    coros = [pc.close() for pc in all_pcs]
    await asyncio.gather(*coros)
    sender_pcs.clear()
    viewer_pcs.clear()


def main():
    parser = argparse.ArgumentParser(description="WebRTC Video Receiver with Web Interface")
    parser.add_argument("--host", default="0.0.0.0", help="Host to bind to")
    parser.add_argument("--port", type=int, default=8082, help="Port to bind to")
    args = parser.parse_args()
    
    # Setup web application
    app = web.Application()
    app.on_shutdown.append(on_shutdown)
    app.router.add_get("/", index)
    app.router.add_get("/viewer.js", javascript_handler)
    app.router.add_post("/offer", offer_handler)
    app.router.add_get("/stats", stats_handler)
    
    logger.info("=" * 60)
    logger.info("WebRTC Video Receiver with Web Interface")
    logger.info("=" * 60)
    logger.info(f"Server URL: http://{args.host}:{args.port}")
    logger.info(f"Web Viewer: http://localhost:{args.port}/")
    logger.info("")
    logger.info("Usage:")
    logger.info("  1. Start this receiver")
    logger.info("  2. Connect sender (webrtc_sender.py)")
    logger.info("  3. Open web browser to watch stream")
    logger.info("=" * 60)
    
    try:
        web.run_app(app, host=args.host, port=args.port)
    except KeyboardInterrupt:
        logger.info("Stopped by user")


if __name__ == "__main__":
    main()