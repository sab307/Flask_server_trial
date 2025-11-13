#!/usr/bin/env python3
"""
WebRTC Video Receiver
Connects to remote sender, receives video stream, and serves web interface for viewing.
"""

import argparse
import asyncio
import json
import logging
import os
from aiohttp import web
import aiohttp

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger(__name__)


class WebRTCReceiver:
    """
    WebRTC receiver that manages connection to sender and serves web interface.
    Acts as a proxy between web clients and the WebRTC sender.
    """
    
    def __init__(self, sender_url):
        """
        Initialize the receiver.
        
        Args:
            sender_url: URL of the WebRTC sender (e.g., http://192.168.1.100:8080)
        """
        self.sender_url = sender_url.rstrip('/')
        self.offer_endpoint = f"{self.sender_url}/offer"
        logger.info(f"Receiver configured for sender: {self.sender_url}")
    
    async def forward_offer(self, offer_data):
        """
        Forward WebRTC offer to sender and return answer.
        
        Args:
            offer_data: Dictionary containing SDP offer
            
        Returns:
            Dictionary containing SDP answer
            
        Raises:
            Exception: If connection to sender fails
        """
        try:
            async with aiohttp.ClientSession() as session:
                async with session.post(
                    self.offer_endpoint,
                    json=offer_data,
                    timeout=aiohttp.ClientTimeout(total=10)
                ) as response:
                    if response.status == 200:
                        answer = await response.json()
                        logger.info("Received answer from sender")
                        return answer
                    else:
                        error_text = await response.text()
                        raise Exception(f"Sender returned error {response.status}: {error_text}")
        except aiohttp.ClientError as e:
            logger.error(f"Failed to connect to sender: {e}")
            raise Exception(f"Cannot reach sender at {self.sender_url}: {e}")
        except asyncio.TimeoutError:
            logger.error(f"Timeout connecting to sender")
            raise Exception(f"Timeout connecting to sender at {self.sender_url}")


async def index_handler(request):
    """
    Serve the main HTML page with video player and graphs.
    
    Returns:
        HTML response with embedded page or file content
    """
    html_path = os.path.join(os.path.dirname(__file__), "index.html")
    
    if os.path.exists(html_path):
        with open(html_path, "r") as f:
            content = f.read()
    else:
        # Fallback HTML if file doesn't exist
        content = """
<!DOCTYPE html>
<html>
<head>
    <title>WebRTC Video Receiver</title>
    <style>
        body {
            font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
            margin: 0;
            padding: 20px;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            color: white;
        }
        .container {
            max-width: 1400px;
            margin: 0 auto;
        }
        h1 {
            text-align: center;
            margin-bottom: 30px;
        }
        .video-container {
            background: rgba(0, 0, 0, 0.3);
            border-radius: 10px;
            padding: 20px;
            margin-bottom: 20px;
        }
        video {
            width: 100%;
            max-width: 1280px;
            display: block;
            margin: 0 auto;
            border-radius: 8px;
            background: #000;
        }
        .controls {
            text-align: center;
            margin: 20px 0;
        }
        button {
            background: #4CAF50;
            color: white;
            border: none;
            padding: 12px 30px;
            font-size: 16px;
            border-radius: 5px;
            cursor: pointer;
            margin: 0 10px;
            transition: background 0.3s;
        }
        button:hover {
            background: #45a049;
        }
        button:disabled {
            background: #ccc;
            cursor: not-allowed;
        }
        .stop-btn {
            background: #f44336;
        }
        .stop-btn:hover {
            background: #da190b;
        }
        .metrics {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
            gap: 15px;
            margin: 20px 0;
        }
        .metric-card {
            background: rgba(255, 255, 255, 0.1);
            padding: 15px;
            border-radius: 8px;
            text-align: center;
        }
        .metric-value {
            font-size: 32px;
            font-weight: bold;
            margin: 10px 0;
        }
        .metric-label {
            font-size: 14px;
            opacity: 0.8;
        }
        .graphs {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(500px, 1fr));
            gap: 20px;
            margin-top: 20px;
        }
        .graph-container {
            background: rgba(255, 255, 255, 0.1);
            padding: 20px;
            border-radius: 10px;
        }
        .status {
            text-align: center;
            padding: 10px;
            margin: 10px 0;
            border-radius: 5px;
            background: rgba(0, 0, 0, 0.3);
        }
        .status.connected {
            background: rgba(76, 175, 80, 0.3);
        }
        .status.error {
            background: rgba(244, 67, 54, 0.3);
        }
    </style>
</head>
<body>
    <div class="container">
        <h1>🎥 WebRTC Video Receiver</h1>
        
        <div class="status" id="status">Disconnected</div>
        
        <div class="video-container">
            <video id="video" autoplay playsinline muted></video>
        </div>
        
        <div class="controls">
            <button id="start-btn">Start Stream</button>
            <button id="stop-btn" class="stop-btn" disabled>Stop Stream</button>
        </div>
        
        <div class="metrics">
            <div class="metric-card">
                <div class="metric-label">FPS</div>
                <div class="metric-value" id="fps-value">0</div>
            </div>
            <div class="metric-card">
                <div class="metric-label">Latency (ms)</div>
                <div class="metric-value" id="latency-value">0</div>
            </div>
            <div class="metric-card">
                <div class="metric-label">Bitrate (Mbps)</div>
                <div class="metric-value" id="bitrate-value">0</div>
            </div>
            <div class="metric-card">
                <div class="metric-label">Packets Lost</div>
                <div class="metric-value" id="packets-lost-value">0</div>
            </div>
        </div>
        
        <div class="graphs">
            <div class="graph-container">
                <canvas id="fps-chart"></canvas>
            </div>
            <div class="graph-container">
                <canvas id="latency-chart"></canvas>
            </div>
        </div>
    </div>
    
    <script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.min.js"></script>
    <script src="/client.js"></script>
</body>
</html>
        """
    
    return web.Response(content_type="text/html", text=content)


async def javascript_handler(request):
    """
    Serve the JavaScript client code.
    
    Returns:
        JavaScript response with embedded code or file content
    """
    js_path = os.path.join(os.path.dirname(__file__), "client.js")
    
    if os.path.exists(js_path):
        with open(js_path, "r") as f:
            content = f.read()
    else:
        # Fallback minimal JavaScript
        content = """
console.log('Warning: Using fallback client.js. Please create client.js file.');
alert('client.js not found. Please create the client.js file.');
        """
    
    return web.Response(content_type="application/javascript", text=content)


async def offer_proxy_handler(request):
    """
    Proxy WebRTC offer from web client to sender.
    
    Args:
        request: aiohttp request containing offer from web client
        
    Returns:
        JSON response with answer from sender
    """
    try:
        offer_data = await request.json()
        receiver = request.app['receiver']
        
        logger.info("Forwarding offer to sender...")
        answer = await receiver.forward_offer(offer_data)
        
        return web.Response(
            content_type="application/json",
            text=json.dumps(answer)
        )
        
    except Exception as e:
        logger.error(f"Error proxying offer: {e}")
        return web.Response(
            status=500,
            content_type="application/json",
            text=json.dumps({"error": str(e)})
        )


async def config_handler(request):
    """
    Provide configuration to web client.
    
    Returns:
        JSON response with sender URL and other config
    """
    receiver = request.app['receiver']
    return web.Response(
        content_type="application/json",
        text=json.dumps({
            "sender_url": receiver.sender_url
        })
    )


def main():
    """Main entry point for the WebRTC receiver application."""
    
    parser = argparse.ArgumentParser(
        description="WebRTC Video Receiver - Display remote video stream in browser"
    )
    parser.add_argument(
        "--sender-url",
        required=True,
        help="URL of the WebRTC sender (e.g., http://192.168.1.100:8080)"
    )
    parser.add_argument(
        "--host",
        default="0.0.0.0",
        help="Host address to bind to (default: 0.0.0.0)"
    )
    parser.add_argument(
        "--port",
        type=int,
        default=8082,
        help="Port to bind to (default: 8082)"
    )
    
    args = parser.parse_args()
    
    # Create receiver instance
    receiver = WebRTCReceiver(args.sender_url)
    
    # Setup web application
    app = web.Application()
    app['receiver'] = receiver
    
    # Add routes
    app.router.add_get("/", index_handler)
    app.router.add_get("/client.js", javascript_handler)
    app.router.add_post("/offer", offer_proxy_handler)
    app.router.add_get("/config", config_handler)
    
    # Log startup information
    logger.info("=" * 60)
    logger.info(f"WebRTC Receiver starting on {args.host}:{args.port}")
    logger.info(f"Sender URL: {args.sender_url}")
    logger.info(f"Web interface: http://{args.host}:{args.port}")
    logger.info("=" * 60)
    logger.info("Open the web interface in your browser to start streaming")
    
    try:
        web.run_app(app, host=args.host, port=args.port)
    except KeyboardInterrupt:
        logger.info("Received interrupt signal")
    finally:
        logger.info("Shutdown complete")


if __name__ == "__main__":
    main()