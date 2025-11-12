#!/usr/bin/env python3
"""
WebRTC Sender - Streams ROS2 camera to a specific receiver IP
Usage: python3 webrtc_sender.py --receiver-ip 192.168.1.100 --receiver-port 8082
"""

import argparse
import asyncio
import fractions
import json
import logging
import threading
import time
import aiohttp
from aiortc import MediaStreamTrack, RTCPeerConnection, RTCSessionDescription, RTCConfiguration, RTCIceServer
from av import VideoFrame
import cv2
import rclpy
from rclpy.node import Node
from sensor_msgs.msg import Image
import numpy as np

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)


def imgmsg_to_cv2(img_msg):
    """Convert ROS Image message to OpenCV image"""
    if img_msg.encoding == 'rgb8':
        dtype = np.uint8
        n_channels = 3
    elif img_msg.encoding == 'bgr8':
        dtype = np.uint8
        n_channels = 3
    elif img_msg.encoding == 'mono8':
        dtype = np.uint8
        n_channels = 1
    elif img_msg.encoding in ['yuyv', 'yuyv422', 'yuy2']:
        dtype = np.uint8
        n_channels = 2
    else:
        raise ValueError(f"Unsupported encoding: {img_msg.encoding}")
    
    img_buf = np.asarray(img_msg.data, dtype=dtype)
    
    if img_msg.encoding in ['yuyv', 'yuyv422', 'yuy2']:
        cv_img = img_buf.reshape((img_msg.height, img_msg.width, 2))
        cv_img = cv2.cvtColor(cv_img, cv2.COLOR_YUV2BGR_YUY2)
    elif n_channels == 1:
        cv_img = img_buf.reshape(img_msg.height, img_msg.width)
    else:
        cv_img = img_buf.reshape(img_msg.height, img_msg.width, n_channels)
    
    if img_msg.encoding == 'rgb8':
        cv_img = cv2.cvtColor(cv_img, cv2.COLOR_RGB2BGR)
    
    return cv_img


class CameraNode(Node):
    """ROS2 Node that receives camera images"""
    
    def __init__(self, camera_topic, resolution=(640, 480)):
        super().__init__('webrtc_sender_node')
        
        self.latest_frame = None
        self.resolution = resolution
        self.frame_lock = threading.Lock()
        self.frame_count = 0
        
        self.subscription = self.create_subscription(
            Image,
            camera_topic,
            self.image_callback,
            10
        )
        
        self.get_logger().info(f'Sender subscribed to: {camera_topic}')
        self.get_logger().info(f'Resolution: {resolution}')
    
    def image_callback(self, msg):
        """Process incoming camera images"""
        try:
            if self.latest_frame is None:
                self.get_logger().info(f'First frame! {msg.width}x{msg.height}, {msg.encoding}')
            
            cv_image = imgmsg_to_cv2(msg)
            resized = cv2.resize(cv_image, self.resolution, interpolation=cv2.INTER_LANCZOS4)
            
            with self.frame_lock:
                self.latest_frame = resized
                self.frame_count += 1
            
        except Exception as e:
            self.get_logger().error(f'Error in image callback: {str(e)}')
    
    def get_frame(self):
        """Return the latest frame (thread-safe)"""
        with self.frame_lock:
            return self.latest_frame.copy() if self.latest_frame is not None else None


class VideoStreamTrack(MediaStreamTrack):
    """Video track for WebRTC streaming"""
    kind = "video"
    
    def __init__(self, ros_node, fps=30):
        super().__init__()
        self.ros_node = ros_node
        self.fps = fps
        self._start = None
        self._timestamp = 0
    
    async def recv(self):
        """Generate video frames"""
        if self._start is None:
            self._start = time.time()
        
        # Calculate timestamp manually
        now = time.time()
        elapsed = now - self._start
        pts = int(elapsed * 90000)  # 90kHz clock
        time_base = fractions.Fraction(1, 90000)
        
        frame = self.ros_node.get_frame()
        
        if frame is None:
            frame = np.zeros((480, 640, 3), dtype=np.uint8)
            cv2.putText(frame, "Waiting for camera...", (150, 240), 
                       cv2.FONT_HERSHEY_SIMPLEX, 1, (255, 255, 255), 2)
        
        frame_rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
        video_frame = VideoFrame.from_ndarray(frame_rgb, format="rgb24")
        video_frame.pts = pts
        video_frame.time_base = time_base
        
        await asyncio.sleep(1.0 / self.fps)
        
        return video_frame


async def send_stream(receiver_url, camera_topic, resolution, fps):
    """Connect to receiver and stream video"""
    
    # Initialize ROS2
    rclpy.init()
    ros_node = CameraNode(camera_topic, resolution)
    
    # Run ROS2 node in separate thread
    ros_thread = threading.Thread(target=lambda: rclpy.spin(ros_node), daemon=True)
    ros_thread.start()
    
    logger.info("Waiting for camera frames...")
    await asyncio.sleep(2)
    
    # Configure WebRTC
    config = RTCConfiguration(
        iceServers=[
            RTCIceServer(urls=["stun:stun.l.google.com:19302"]),
            RTCIceServer(urls=["stun:stun1.l.google.com:19302"])
        ]
    )
    
    pc = RTCPeerConnection(configuration=config)
    
    # Add video track
    video_track = VideoStreamTrack(ros_node, fps)
    pc.addTrack(video_track)
    
    # Create data channel
    channel = pc.createDataChannel("control")
    
    @channel.on("open")
    def on_open():
        logger.info("✓ Data channel opened")
    
    @channel.on("message")
    def on_message(message):
        logger.info(f"Received message: {message}")
    
    @pc.on("connectionstatechange")
    async def on_connectionstatechange():
        logger.info(f"Connection state: {pc.connectionState}")
        if pc.connectionState == "connected":
            logger.info("✓ Connected! Streaming video...")
        elif pc.connectionState == "failed":
            logger.error("✗ Connection failed!")
        elif pc.connectionState == "closed":
            logger.info("Connection closed")
    
    @pc.on("iceconnectionstatechange")
    async def on_iceconnectionstatechange():
        logger.info(f"ICE connection state: {pc.iceConnectionState}")
    
    # Create offer
    offer = await pc.createOffer()
    await pc.setLocalDescription(offer)
    
    logger.info(f"Connecting to receiver at {receiver_url}...")
    
    # Send offer to receiver
    async with aiohttp.ClientSession() as session:
        async with session.post(
            f"{receiver_url}/offer",
            json={
                "sdp": pc.localDescription.sdp,
                "type": pc.localDescription.type
            },
            headers={"Content-Type": "application/json"}
        ) as response:
            if response.status == 200:
                answer = await response.json()
                await pc.setRemoteDescription(
                    RTCSessionDescription(sdp=answer["sdp"], type=answer["type"])
                )
                logger.info("✓ Received answer from receiver")
            else:
                logger.error(f"Failed to connect: {response.status}")
                return
    
    # Keep connection alive
    try:
        while pc.connectionState != "closed":
            await asyncio.sleep(1)
            
            # Send heartbeat every 5 seconds
            if pc.connectionState == "connected" and channel.readyState == "open":
                try:
                    stats = {
                        "frames": ros_node.frame_count,
                        "timestamp": time.time()
                    }
                    channel.send(json.dumps(stats))
                except:
                    pass
    except KeyboardInterrupt:
        logger.info("Shutting down...")
    finally:
        await pc.close()
        ros_node.destroy_node()
        rclpy.shutdown()


def main():
    parser = argparse.ArgumentParser(description="WebRTC Video Sender")
    parser.add_argument("--receiver-ip", required=True, help="Receiver IP address")
    parser.add_argument("--receiver-port", type=int, default=8083, help="Receiver port")
    parser.add_argument("--camera-topic", default="/camera1/image_raw", help="ROS2 camera topic")
    parser.add_argument("--resolution", default="640x480", help="Video resolution (WxH)")
    parser.add_argument("--fps", type=int, default=30, help="Frames per second")
    args = parser.parse_args()
    
    # Parse resolution
    width, height = map(int, args.resolution.split('x'))
    resolution = (width, height)
    
    receiver_url = f"http://{args.receiver_ip}:{args.receiver_port}"
    
    logger.info("=" * 60)
    logger.info("WebRTC Video Sender")
    logger.info("=" * 60)
    logger.info(f"Camera topic: {args.camera_topic}")
    logger.info(f"Resolution: {resolution}")
    logger.info(f"FPS: {args.fps}")
    logger.info(f"Receiver: {receiver_url}")
    logger.info("=" * 60)
    
    asyncio.run(send_stream(receiver_url, args.camera_topic, resolution, args.fps))


if __name__ == "__main__":
    main()