#!/usr/bin/env python3

import asyncio
import json
import logging
import argparse
from aiohttp import web
from aiortc import RTCPeerConnection, RTCSessionDescription, RTCConfiguration, RTCIceServer, MediaStreamTrack
from av import VideoFrame
import numpy as np
import cv2
import time
import fractions

# Configure logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)


class VideoRelayTrack(MediaStreamTrack):
    """
    Video track that relays frames from upstream source
    """
    kind = "video"
    
    def __init__(self, track):
        super().__init__()
        self.track = track
        self._start = None
        self.frame_count = 0
    
    async def recv(self):
        """Relay video frames"""
        frame = await self.track.recv()
        self.frame_count += 1
        
        if self.frame_count % 100 == 0:
            logger.info(f"Relayed {self.frame_count} frames")
        
        return frame


class WebRTCRelay:
    """
    WebRTC Relay Server that receives stream from one source 
    and distributes to multiple clients
    """
    
    def __init__(self, upstream_url="http://localhost:8081"):
        self.upstream_url = upstream_url
        self.upstream_pc = None
        self.upstream_track = None
        self.client_pcs = set()
        self.connected = False
        self.reconnect_task = None
        
    async def connect_to_upstream(self):
        """Connect to upstream WebRTC server (camera source)"""
        try:
            logger.info(f"Connecting to upstream server: {self.upstream_url}")
            
            # Configure peer connection
            config = RTCConfiguration(
                iceServers=[
                    RTCIceServer(urls=["stun:stun.l.google.com:19302"]),
                    RTCIceServer(urls=["stun:stun1.l.google.com:19302"])
                ]
            )
            
            self.upstream_pc = RTCPeerConnection(configuration=config)
            
            # Handle incoming track
            @self.upstream_pc.on("track")
            async def on_track(track):
                logger.info(f"Received {track.kind} track from upstream")
                if track.kind == "video":
                    self.upstream_track = track
                    self.connected = True
                    logger.info("✓ Upstream video track ready for relay")
            
            @self.upstream_pc.on("connectionstatechange")
            async def on_connectionstatechange():
                logger.info(f"Upstream connection state: {self.upstream_pc.connectionState}")
                if self.upstream_pc.connectionState == "failed":
                    logger.error("Upstream connection failed!")
                    self.connected = False
                    # Schedule reconnection
                    if not self.reconnect_task or self.reconnect_task.done():
                        self.reconnect_task = asyncio.create_task(self.reconnect_upstream())
                elif self.upstream_pc.connectionState == "closed":
                    logger.warning("Upstream connection closed")
                    self.connected = False
                elif self.upstream_pc.connectionState == "connected":
                    logger.info("✓ Connected to upstream server!")
                    self.connected = True
            
            # Create data channel
            dc = self.upstream_pc.createDataChannel("chat")
            
            @dc.on("open")
            def on_open():
                logger.info("Upstream data channel opened")
            
            # Create offer
            offer = await self.upstream_pc.createOffer()
            await self.upstream_pc.setLocalDescription(offer)
            
            # Send offer to upstream server
            import aiohttp
            async with aiohttp.ClientSession() as session:
                async with session.post(
                    f"{self.upstream_url}/offer",
                    json={
                        "sdp": self.upstream_pc.localDescription.sdp,
                        "type": self.upstream_pc.localDescription.type
                    },
                    headers={"Content-Type": "application/json"}
                ) as response:
                    if response.status == 200:
                        answer = await response.json()
                        await self.upstream_pc.setRemoteDescription(
                            RTCSessionDescription(
                                sdp=answer["sdp"],
                                type=answer["type"]
                            )
                        )
                        logger.info("Upstream connection setup complete")
                        return True
                    else:
                        logger.error(f"Failed to connect to upstream: {response.status}")
                        return False
                        
        except Exception as e:
            logger.error(f"Error connecting to upstream: {e}")
            return False
    
    async def reconnect_upstream(self):
        """Attempt to reconnect to upstream server"""
        logger.info("Attempting to reconnect to upstream...")
        await asyncio.sleep(5)  # Wait before reconnecting
        await self.connect_to_upstream()
    
    async def handle_client_offer(self, request):
        """Handle WebRTC offer from client"""
        params = await request.json()
        offer = RTCSessionDescription(sdp=params["sdp"], type=params["type"])
        
        # Check if upstream is connected
        if not self.connected or not self.upstream_track:
            logger.warning("Upstream not connected, cannot serve client")
            return web.Response(
                status=503,
                text="Upstream server not connected"
            )
        
        # Configure client peer connection
        config = RTCConfiguration(
            iceServers=[
                RTCIceServer(urls=["stun:stun.l.google.com:19302"]),
                RTCIceServer(urls=["stun:stun1.l.google.com:19302"])
            ]
        )
        
        pc = RTCPeerConnection(configuration=config)
        self.client_pcs.add(pc)
        
        client_id = len(self.client_pcs)
        logger.info(f"New client connection #{client_id}")
        
        @pc.on("connectionstatechange")
        async def on_connectionstatechange():
            logger.info(f"Client #{client_id} state: {pc.connectionState}")
            if pc.connectionState == "failed":
                logger.error(f"Client #{client_id} connection failed")
                await pc.close()
                self.client_pcs.discard(pc)
            elif pc.connectionState == "closed":
                logger.info(f"Client #{client_id} disconnected")
                self.client_pcs.discard(pc)
            elif pc.connectionState == "connected":
                logger.info(f"✓ Client #{client_id} connected!")
        
        @pc.on("datachannel")
        def on_datachannel(channel):
            logger.info(f"Client #{client_id} data channel: {channel.label}")
            
            @channel.on("message")
            def on_message(message):
                try:
                    data = json.loads(message)
                    if data.get("type") == "ping":
                        pong = json.dumps({
                            "type": "pong",
                            "timestamp": data["timestamp"]
                        })
                        channel.send(pong)
                except:
                    pass
        
        # Add relayed video track to client
        relay_track = VideoRelayTrack(self.upstream_track)
        pc.addTrack(relay_track)
        
        await pc.setRemoteDescription(offer)
        answer = await pc.createAnswer()
        await pc.setLocalDescription(answer)
        
        logger.info(f"Sending answer to client #{client_id}")
        
        return web.Response(
            content_type="application/json",
            text=json.dumps({
                "sdp": pc.localDescription.sdp,
                "type": pc.localDescription.type
            })
        )
    
    async def serve_index(self, request):
        """Serve simple test HTML page"""
        html = """
<!DOCTYPE html>
<html>
<head>
    <title>WebRTC Relay Server</title>
    <style>
        body {
            font-family: Arial, sans-serif;
            max-width: 1200px;
            margin: 0 auto;
            padding: 20px;
            background: #f5f5f5;
        }
        .container {
            background: white;
            padding: 20px;
            border-radius: 8px;
            box-shadow: 0 2px 4px rgba(0,0,0,0.1);
        }
        h1 {
            color: #333;
            text-align: center;
        }
        video {
            width: 100%;
            max-width: 1280px;
            height: auto;
            background: #000;
            border-radius: 4px;
        }
        .controls {
            margin: 20px 0;
            text-align: center;
        }
        button {
            padding: 10px 20px;
            margin: 5px;
            font-size: 16px;
            cursor: pointer;
            background: #007bff;
            color: white;
            border: none;
            border-radius: 4px;
        }
        button:hover {
            background: #0056b3;
        }
        button:disabled {
            background: #ccc;
            cursor: not-allowed;
        }
        .status {
            text-align: center;
            padding: 10px;
            margin: 10px 0;
            border-radius: 4px;
            font-weight: bold;
        }
        .status.disconnected { background: #f8d7da; color: #721c24; }
        .status.connecting { background: #fff3cd; color: #856404; }
        .status.connected { background: #d4edda; color: #155724; }
        .info {
            background: #e7f3ff;
            padding: 15px;
            border-radius: 4px;
            margin: 10px 0;
        }
        .info p {
            margin: 5px 0;
        }
    </style>
</head>
<body>
    <div class="container">
        <h1>🎥 WebRTC Relay Server</h1>
        
        <div class="info">
            <p><strong>Server Status:</strong> Running</p>
            <p><strong>Endpoint:</strong> <code>/offer</code></p>
            <p><strong>Clients Connected:</strong> <span id="clientCount">0</span></p>
        </div>
        
        <div id="status" class="status disconnected">Disconnected</div>
        
        <div class="controls">
            <button id="startBtn" onclick="start()">Start Stream</button>
            <button id="stopBtn" onclick="stop()" disabled>Stop Stream</button>
        </div>
        
        <video id="video" autoplay playsinline muted></video>
    </div>
    
    <script>
        let pc = null;
        let dc = null;
        const video = document.getElementById('video');
        const status = document.getElementById('status');
        const startBtn = document.getElementById('startBtn');
        const stopBtn = document.getElementById('stopBtn');
        
        function updateStatus(state, text) {
            status.className = 'status ' + state;
            status.textContent = text;
        }
        
        async function start() {
            try {
                updateStatus('connecting', 'Connecting...');
                startBtn.disabled = true;
                
                pc = new RTCPeerConnection({
                    iceServers: [
                        {urls: 'stun:stun.l.google.com:19302'},
                        {urls: 'stun:stun1.l.google.com:19302'}
                    ]
                });
                
                pc.ontrack = (event) => {
                    console.log('Received track:', event.track.kind);
                    video.srcObject = event.streams[0];
                    updateStatus('connected', '✓ Connected - Streaming');
                };
                
                pc.onconnectionstatechange = () => {
                    console.log('Connection state:', pc.connectionState);
                    if (pc.connectionState === 'failed' || pc.connectionState === 'disconnected') {
                        updateStatus('disconnected', 'Connection failed');
                        stop();
                    }
                };
                
                dc = pc.createDataChannel('chat');
                dc.onopen = () => console.log('Data channel opened');
                dc.onmessage = (evt) => console.log('Message:', evt.data);
                
                const offer = await pc.createOffer();
                await pc.setLocalDescription(offer);
                
                const response = await fetch('/offer', {
                    method: 'POST',
                    headers: {'Content-Type': 'application/json'},
                    body: JSON.stringify({
                        sdp: pc.localDescription.sdp,
                        type: pc.localDescription.type
                    })
                });
                
                if (!response.ok) {
                    throw new Error('Server returned ' + response.status);
                }
                
                const answer = await response.json();
                await pc.setRemoteDescription(answer);
                
                stopBtn.disabled = false;
                console.log('Stream started successfully');
                
            } catch (error) {
                console.error('Error starting stream:', error);
                updateStatus('disconnected', 'Error: ' + error.message);
                startBtn.disabled = false;
                stop();
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
            video.srcObject = null;
            updateStatus('disconnected', 'Disconnected');
            startBtn.disabled = false;
            stopBtn.disabled = true;
        }
    </script>
</body>
</html>
        """
        return web.Response(content_type="text/html", text=html)
    
    async def status_endpoint(self, request):
        """Status endpoint for monitoring"""
        return web.Response(
            content_type="application/json",
            text=json.dumps({
                "status": "running",
                "upstream_connected": self.connected,
                "clients_connected": len(self.client_pcs),
                "has_video_track": self.upstream_track is not None
            })
        )
    
    async def on_shutdown(self, app):
        """Cleanup on shutdown"""
        logger.info("Shutting down relay server...")
        
        # Close all client connections
        coros = [pc.close() for pc in self.client_pcs]
        await asyncio.gather(*coros)
        self.client_pcs.clear()
        
        # Close upstream connection
        if self.upstream_pc:
            await self.upstream_pc.close()
        
        logger.info("Shutdown complete")


async def main():
    parser = argparse.ArgumentParser(description="WebRTC Relay Server")
    parser.add_argument(
        "--upstream",
        default="http://localhost:8081",
        help="Upstream WebRTC server URL (default: http://localhost:8081)"
    )
    parser.add_argument(
        "--host",
        default="0.0.0.0",
        help="Host to bind to (default: 0.0.0.0)"
    )
    parser.add_argument(
        "--port",
        type=int,
        default=8081,
        help="Port to bind to (default: 8081)"
    )
    args = parser.parse_args()
    
    logger.info("=" * 60)
    logger.info("WebRTC Relay Server")
    logger.info("=" * 60)
    logger.info(f"Upstream source: {args.upstream}")
    logger.info(f"Listening on: {args.host}:{args.port}")
    logger.info(f"Web interface: http://{args.host}:{args.port}")
    logger.info("=" * 60)
    
    # Create relay instance
    relay = WebRTCRelay(upstream_url=args.upstream)
    
    # Connect to upstream
    await relay.connect_to_upstream()
    
    # Setup web application
    app = web.Application()
    app.on_shutdown.append(relay.on_shutdown)
    app.router.add_get("/", relay.serve_index)
    app.router.add_post("/offer", relay.handle_client_offer)
    app.router.add_get("/status", relay.status_endpoint)
    
    # Run web server
    runner = web.AppRunner(app)
    await runner.setup()
    site = web.TCPSite(runner, args.host, args.port)
    await site.start()
    
    logger.info("✓ Relay server started successfully")
    logger.info("Press Ctrl+C to stop")
    
    try:
        # Keep running
        await asyncio.Event().wait()
    except KeyboardInterrupt:
        logger.info("Interrupted by user")
    finally:
        await runner.cleanup()


if __name__ == "__main__":
    asyncio.run(main())