#!/usr/bin/env python3
"""
WebRTC Receiver - Receives video stream from sender
Usage: python3 webrtc_receiver.py --port 8082
"""

import argparse
import asyncio
import json
import logging
from aiohttp import web
from aiortc import RTCPeerConnection, RTCSessionDescription, RTCConfiguration, RTCIceServer
import cv2
import numpy as np
from av import VideoFrame
import time

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)


class VideoReceiver:
    """Handles incoming video frames"""
    
    def __init__(self, display=True, save_to_file=None):
        self.display = display
        self.save_to_file = save_to_file
        self.frame_count = 0
        self.start_time = None
        self.video_writer = None
        self.latest_frame = None
        
        if save_to_file:
            # Initialize video writer (will be configured with first frame)
            self.fourcc = cv2.VideoWriter_fourcc(*'mp4v')
            logger.info(f"Will save video to: {save_to_file}")
    
    async def process_track(self, track):
        """Process incoming video track"""
        logger.info("✓ Receiving video track...")
        
        try:
            while True:
                frame = await track.recv()
                
                if self.start_time is None:
                    self.start_time = time.time()
                    logger.info("✓ First frame received! Starting display...")
                
                # Convert VideoFrame to numpy array
                img = frame.to_ndarray(format="bgr24")
                self.latest_frame = img
                self.frame_count += 1
                
                # Initialize video writer with first frame dimensions
                if self.save_to_file and self.video_writer is None:
                    height, width = img.shape[:2]
                    self.video_writer = cv2.VideoWriter(
                        self.save_to_file, 
                        self.fourcc, 
                        30.0, 
                        (width, height)
                    )
                    logger.info(f"Initialized video writer: {width}x{height}")
                
                # Save frame
                if self.video_writer:
                    self.video_writer.write(img)
                
                # Display frame
                if self.display:
                    # Add frame info
                    elapsed = time.time() - self.start_time
                    fps = self.frame_count / elapsed if elapsed > 0 else 0
                    
                    cv2.putText(img, f"Frame: {self.frame_count}", (10, 30),
                               cv2.FONT_HERSHEY_SIMPLEX, 0.7, (0, 255, 0), 2)
                    cv2.putText(img, f"FPS: {fps:.1f}", (10, 60),
                               cv2.FONT_HERSHEY_SIMPLEX, 0.7, (0, 255, 0), 2)
                    
                    cv2.imshow("WebRTC Receiver", img)
                    
                    # Break on 'q' key
                    if cv2.waitKey(1) & 0xFF == ord('q'):
                        logger.info("User requested quit")
                        break
                
        except Exception as e:
            logger.error(f"Error processing track: {e}")
        finally:
            if self.video_writer:
                self.video_writer.release()
                logger.info(f"Video saved to {self.save_to_file}")
            if self.display:
                cv2.destroyAllWindows()
            
            logger.info(f"Total frames received: {self.frame_count}")


# Global variables
pcs = set()
video_receiver = None


async def offer_handler(request):
    """Handle incoming WebRTC offer from sender"""
    params = await request.json()
    offer = RTCSessionDescription(sdp=params["sdp"], type=params["type"])
    
    logger.info("Received offer from sender")
    
    # Configure WebRTC
    config = RTCConfiguration(
        iceServers=[
            RTCIceServer(urls=["stun:stun.l.google.com:19302"]),
            RTCIceServer(urls=["stun:stun1.l.google.com:19302"])
        ]
    )
    
    pc = RTCPeerConnection(configuration=config)
    pcs.add(pc)
    
    @pc.on("connectionstatechange")
    async def on_connectionstatechange():
        logger.info(f"Connection state: {pc.connectionState}")
        if pc.connectionState == "connected":
            logger.info("✓ Connection established!")
        elif pc.connectionState == "failed":
            logger.error("✗ Connection failed!")
            await pc.close()
            pcs.discard(pc)
        elif pc.connectionState == "closed":
            logger.info("Connection closed")
            pcs.discard(pc)
    
    @pc.on("iceconnectionstatechange")
    async def on_iceconnectionstatechange():
        logger.info(f"ICE connection state: {pc.iceConnectionState}")
    
    @pc.on("track")
    def on_track(track):
        logger.info(f"Received track: {track.kind}")
        if track.kind == "video":
            asyncio.ensure_future(video_receiver.process_track(track))
        
        @track.on("ended")
        async def on_ended():
            logger.warning("Track ended")
    
    @pc.on("datachannel")
    def on_datachannel(channel):
        logger.info(f"Data channel established: {channel.label}")
        
        @channel.on("message")
        def on_message(message):
            try:
                data = json.loads(message)
                if "frames" in data:
                    logger.debug(f"Sender stats: {data}")
            except:
                logger.debug(f"Received: {message}")
    
    # Set remote description and create answer
    await pc.setRemoteDescription(offer)
    answer = await pc.createAnswer()
    await pc.setLocalDescription(answer)
    
    logger.info("Sending answer to sender")
    
    return web.Response(
        content_type="application/json",
        text=json.dumps({
            "sdp": pc.localDescription.sdp,
            "type": pc.localDescription.type
        })
    )


async def index(request):
    """Simple status page"""
    html = f"""
    <!DOCTYPE html>
    <html>
    <head>
        <title>WebRTC Receiver</title>
        <style>
            body {{ 
                font-family: Arial; 
                padding: 40px; 
                background: #f0f0f0;
                max-width: 800px;
                margin: 0 auto;
            }}
            .status {{ 
                background: white; 
                padding: 30px; 
                border-radius: 10px;
                box-shadow: 0 2px 10px rgba(0,0,0,0.1);
            }}
            h1 {{ color: #333; }}
            .info {{ 
                background: #e8f5e9; 
                padding: 15px; 
                border-radius: 5px;
                margin: 20px 0;
            }}
            code {{ 
                background: #f5f5f5; 
                padding: 2px 6px; 
                border-radius: 3px;
                font-family: monospace;
            }}
            .connections {{
                margin-top: 20px;
                padding: 15px;
                background: #fff3cd;
                border-radius: 5px;
            }}
        </style>
    </head>
    <body>
        <div class="status">
            <h1>🎥 WebRTC Receiver</h1>
            <div class="info">
                <strong>Status:</strong> Ready to receive streams<br>
                <strong>Active connections:</strong> <span id="connections">{len(pcs)}</span><br>
                <strong>Frames received:</strong> <span id="frames">{video_receiver.frame_count if video_receiver else 0}</span>
            </div>
            
            <h2>How to connect:</h2>
            <div class="connections">
                <p>From the sender machine, run:</p>
                <code>python3 webrtc_sender.py --receiver-ip YOUR_IP --receiver-port {request.host.split(':')[1] if ':' in request.host else 8082}</code>
            </div>
            
            <p><small>This page auto-refreshes every 2 seconds</small></p>
        </div>
        
        <script>
            setInterval(() => {{
                fetch('/stats')
                    .then(r => r.json())
                    .then(data => {{
                        document.getElementById('connections').textContent = data.connections;
                        document.getElementById('frames').textContent = data.frames;
                    }});
            }}, 2000);
        </script>
    </body>
    </html>
    """
    return web.Response(content_type="text/html", text=html)


async def stats_handler(request):
    """Return current statistics"""
    return web.Response(
        content_type="application/json",
        text=json.dumps({
            "connections": len(pcs),
            "frames": video_receiver.frame_count if video_receiver else 0
        })
    )


async def on_shutdown(app):
    """Cleanup on shutdown"""
    logger.info("Shutting down...")
    coros = [pc.close() for pc in pcs]
    await asyncio.gather(*coros)
    pcs.clear()


def main():
    global video_receiver
    
    parser = argparse.ArgumentParser(description="WebRTC Video Receiver")
    parser.add_argument("--host", default="0.0.0.0", help="Host to bind to")
    parser.add_argument("--port", type=int, default=8082, help="Port to bind to")
    parser.add_argument("--no-display", action="store_true", help="Disable video display window")
    parser.add_argument("--save-video", help="Save received video to file (e.g., output.mp4)")
    args = parser.parse_args()
    
    # Initialize video receiver
    video_receiver = VideoReceiver(
        display=not args.no_display,
        save_to_file=args.save_video
    )
    
    # Setup web application
    app = web.Application()
    app.on_shutdown.append(on_shutdown)
    app.router.add_get("/", index)
    app.router.add_post("/offer", offer_handler)
    app.router.add_get("/stats", stats_handler)
    
    logger.info("=" * 60)
    logger.info("WebRTC Video Receiver")
    logger.info("=" * 60)
    logger.info(f"Listening on: http://{args.host}:{args.port}")
    logger.info(f"Display video: {not args.no_display}")
    if args.save_video:
        logger.info(f"Save to file: {args.save_video}")
    logger.info("=" * 60)
    logger.info(f"Waiting for sender to connect...")
    logger.info(f"Status page: http://localhost:{args.port}/")
    logger.info("=" * 60)
    
    try:
        web.run_app(app, host=args.host, port=args.port)
    except KeyboardInterrupt:
        logger.info("Stopped by user")


if __name__ == "__main__":
    main()