import asyncio
import aiohttp
import json 
import logging
import argparse
import numpy as np
import cv2
from aiortc import RTCPeerConnection, RTCConfiguration, RTCIceServer
from av import VideoFrame

# Configure logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

class WebRTCClient:
    # Python WebRTC Client to receive video stream from server
    
    def __init__(self, server_url="http://localhost:8081"):
        self.server_url = server_url
        self.pc = None
        self.dc = None
        self.running = False
        self.latest_frame = None
        self.frame_count = 0
        
    async def connect(self):
        # Establish WebRTC connection to the server
        try:
            # Configure peer connection with STUN servers
            config = RTCConfiguration(
                iceServers=[
                    RTCIceServer(urls=["stun:stun.l.google.com:19302"]),
                    RTCIceServer(urls=["stun:stun1.l.google.com:19302"])
                ]
            )
            
            self.pc = RTCPeerConnection(configuration=config)
            self.running = True
            
            # Set up event handlers
            @self.pc.on("track")
            async def on_track(track):
                logger.info(f"Receiving {track.kind} track")
                
                if track.kind == "video":
                    logger.info("Video track received, starting frame processing...")
                    try:
                        while self.running:
                            frame = await track.recv()
                            await self.process_frame(frame)
                    except Exception as e:
                        logger.error(f"Error receiving frames: {e}")
                        
            @self.pc.on("datachannel")
            def on_datachannel(channel):
                logger.info(f"Data channel established: {channel.label}")
                self.dc = channel
                
                @channel.on("message")
                def on_message(message):
                    logger.debug(f"Received message: {message}")
                    try:
                        data = json.loads(message)
                        if data.get("type") == "pong":
                            # Calculate RTT
                            rtt = asyncio.get_event_loop().time() - data["timestamp"]
                            logger.debug(f"RTT: {rtt*1000:.2f}ms")
                    except:
                        pass
                    
            @self.pc.on("connectionstatechange")
            async def on_connectionstatechange():
                logger.info(f"Connection state: {self.pc.connectionState}")
                if self.pc.connectionState == 'connected':
                    logger.info("Successfully connected to server!")
                elif self.pc.connectionState == 'failed':
                    logger.info("Connection failed!")
                    self.running = False
                elif self.pc.connectionState == 'closed':
                    logger.info("Connection closed!")
                    self.running = False
                    
            # Create data channel
            self.dc = self.pc.createDataChannel("chat")
            
            @self.dc.on("open")
            def on_open():
                logger.info("Data channel opened")
                
            # Create and send offer
            logger.info("Creating offer ...")
            offer = await self.pc.createOffer()
            await self.pc.setLocalDescription(offer)
            
            # Send offer to server
            logger.info(f"Sending offer to {self.server_url}/offer")
            async with aiohttp.ClientSession() as session:
                async with session.post(
                    f"{self.server_url}/offer",
                    json={
                        "sdp": self.pc.localDescription.sdp,
                        "type": self.pc.localDescription.type
                    },
                    headers={"Content-Type": "application/json"}
                ) as response:
                    if response.status == 200:
                        answer = await response.json()
                        logger.info("Received answer from server")
                        
                        # Set remote description
                        from aiortc import RTCSessionDescription
                        await self.pc.setRemoteDescription(
                            RTCSessionDescription(
                                sdp = answer["sdp"],
                                type= answer["type"]
                            )
                        )
                        logger.info("Connection setup complete, waiting for video...")
                    else:
                        logger.error(f"Failed to get anwer: {response.status}")
                        return False
                    
            return False
        except Exception as e:
            logger.error(f"Connection error: {e}")
            return False
        
    async def process_frame(self, frame: VideoFrame):
        """Process received video frame"""
        try:
            # Convert VideoFrame to numpy array
            img = frame.to_ndarray(format="bgr24")
            
            self.latest_frame = img
            self.frame_count += 1
            
            # Display frame
            cv2.imshow("WebRTC Stream", img)
            
            # Handle key press (1ms wait)
            key = cv2.waitKey(1) & 0xFF
            if key == ord('q'):
                logger.info("Quit key pressed")
                self.running = False
            elif key == ord('s'):
                # Save screenshot
                filename = f"screenshot_{self.frame_count}.jpg"
                cv2.imwrite(filename, img)
                logger.info(f"Screenshot saved: {filename}")
            
            # Log frame info periodically
            if self.frame_count % 100 == 0:
                logger.info(f"Frames received: {self.frame_count}, Size: {img.shape}")
                
        except Exception as e:
            logger.error(f"Error processing frame: {e}")
    
    def send_ping(self):
        """Send ping to measure RTT"""
        if self.dc and self.dc.readyState == "open":
            ping = json.dumps({
                "type": "ping",
                "timestamp": asyncio.get_event_loop().time()
            })
            self.dc.send(ping)
    
    def set_resolution(self, width, height):
        """Request resolution change (for manual mode servers)"""
        if self.dc and self.dc.readyState == "open":
            msg = json.dumps({
                "resolution": [width, height]
            })
            self.dc.send(msg)
            logger.info(f"Requested resolution change to {width}x{height}")
    
    async def run(self, display=True):
        """Main run loop"""
        if not await self.connect():
            logger.error("Failed to connect to server")
            return
        
        try:
            # Keep connection alive and optionally send pings
            while self.running:
                await asyncio.sleep(1)
                
                # Send periodic ping for RTT measurement
                if self.frame_count > 0:  # Only after receiving frames
                    self.send_ping()
                    
        except KeyboardInterrupt:
            logger.info("Interrupted by user")
        finally:
            await self.close()
    
    async def close(self):
        """Clean up resources"""
        logger.info("Closing connection...")
        self.running = False
        
        if self.dc:
            self.dc.close()
        
        if self.pc:
            await self.pc.close()
        
        cv2.destroyAllWindows()
        logger.info(f"Total frames received: {self.frame_count}")


async def main():
    parser = argparse.ArgumentParser(description="WebRTC Python Client")
    parser.add_argument(
        "--server",
        default="http://localhost:8081",
        help="Server URL (default: http://localhost:8081)"
    )
    parser.add_argument(
        "--no-display",
        action="store_true",
        help="Don't display video (for headless operation)"
    )
    args = parser.parse_args()
    
    logger.info(f"Connecting to server: {args.server}")
    
    client = WebRTCClient(server_url=args.server)
    
    try:
        await client.run(display=not args.no_display)
    except Exception as e:
        logger.error(f"Error: {e}")
    finally:
        await client.close()


if __name__ == "__main__":
    asyncio.run(main())