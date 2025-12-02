package main

/*
=============================================================================
WebRTC Relay Server - H264 with Glass-to-Glass Latency Support
=============================================================================
Relays video stream AND timestamp DataChannel messages from Python sender
to browser clients for accurate end-to-end latency measurement.

=============================================================================
CHANGES FROM relay_server_h264.go:
=============================================================================
1. Added TimestampMessage struct for parsing timestamp data
2. Added ReceiverClient struct to track browser clients with their DataChannels
3. Added pc.OnDataChannel handler to receive timestamps from Python sender
4. Added BroadcastTimestamp method to forward timestamps to all browsers
5. Server now creates DataChannel for each browser client
6. Added relay_time_ms field to timestamp messages for debugging
=============================================================================

DataChannel Flow:
  Python Sender --[timestamps]--> Go Relay --[timestamps]--> Browser Clients

The relay broadcasts timestamp messages to all connected browser clients,
allowing them to correlate received frames with capture timestamps.
=============================================================================
*/

import (
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/gorilla/websocket"
	"github.com/pion/rtcp"
	"github.com/pion/webrtc/v3"
)

// =============================================================================
// Message Types
// =============================================================================

type SignalMessage struct {
	Type      string                   `json:"type"`
	SDP       string                   `json:"sdp,omitempty"`
	Candidate *webrtc.ICECandidateInit `json:"candidate,omitempty"`
}

type OfferRequest struct {
	SDP  string `json:"sdp"`
	Type string `json:"type"`
}

// =============================================================================
// NEW: TimestampMessage for glass-to-glass latency measurement
// =============================================================================
// PREVIOUS (in relay_server_h264.go): (not present)
//
// NEW: Struct to parse and enrich timestamp messages from sender
type TimestampMessage struct {
	Type       string  `json:"type"`
	Seq        int64   `json:"seq,omitempty"`
	CaptureMs  float64 `json:"capture_ms,omitempty"`
	Pts        int64   `json:"pts,omitempty"`
	FrameNum   int64   `json:"frame_num,omitempty"`
	SendTimeMs float64 `json:"send_time_ms,omitempty"`
	// For clock sync
	ClientTime float64 `json:"client_time,omitempty"`
	ServerTime float64 `json:"server_time,omitempty"`
	// NEW: Relay adds this timestamp for debugging
	RelayTimeMs float64 `json:"relay_time_ms,omitempty"`
}

// END OF NEW TimestampMessage
// =============================================================================

// =============================================================================
// NEW: ReceiverClient struct to track browser clients with DataChannels
// =============================================================================
// PREVIOUS (in relay_server_h264.go):
//
//	receivers map[string]*webrtc.PeerConnection  // Just stored PeerConnection
//
// NEW: Struct to hold both PeerConnection and DataChannel for each browser
type ReceiverClient struct {
	ID          string
	PC          *webrtc.PeerConnection
	DataChannel *webrtc.DataChannel // NEW: DataChannel for sending timestamps
	mu          sync.Mutex
}

func (r *ReceiverClient) SendTimestamp(msg []byte) {
	r.mu.Lock()
	defer r.mu.Unlock()

	if r.DataChannel != nil && r.DataChannel.ReadyState() == webrtc.DataChannelStateOpen {
		// =====================================================================
		// PREVIOUS CODE (sent binary data - browser couldn't parse):
		// =====================================================================
		// if err := r.DataChannel.Send(msg); err != nil {
		// 	log.Printf("Failed to send timestamp to %s: %v", r.ID, err)
		// }
		// =====================================================================

		// =====================================================================
		// NEW CODE (send as text string for JSON parsing in browser):
		// =====================================================================
		// DataChannel.Send([]byte) sends binary data (ArrayBuffer in browser)
		// DataChannel.SendText(string) sends text data (string in browser)
		// Since we're sending JSON, we need to send as text
		if err := r.DataChannel.SendText(string(msg)); err != nil {
			log.Printf("Failed to send timestamp to %s: %v", r.ID, err)
		}
		// =====================================================================
	}
}

// END OF NEW ReceiverClient
// =============================================================================

// =============================================================================
// Server
// =============================================================================

type Server struct {
	upgrader websocket.Upgrader

	// Sender connection
	senderPC *webrtc.PeerConnection
	// =========================================================================
	// REMOVED: senderDC - timestamps now come via WebSocket, not DataChannel
	// =========================================================================
	// PREVIOUS:
	//     senderDC *webrtc.DataChannel // DataChannel from sender
	//
	// REASON: Using DataChannel with video track caused "conflicting ice-ufrag"
	//         errors between aiortc and Pion
	// =========================================================================
	senderConnected bool

	// =========================================================================
	// CHANGED: receivers now stores ReceiverClient instead of just PeerConnection
	// =========================================================================
	// PREVIOUS (in relay_server_h264.go):
	//     receivers   map[string]*webrtc.PeerConnection
	//
	// NEW: Store ReceiverClient which includes DataChannel
	receivers   map[string]*ReceiverClient
	receiversMu sync.RWMutex
	// =========================================================================

	// Video track
	videoTrack *webrtc.TrackLocalStaticRTP

	// Synchronization
	mu sync.Mutex

	// Configuration
	senderURL string
}

func NewServer(senderURL string) *Server {
	return &Server{
		upgrader: websocket.Upgrader{
			CheckOrigin: func(r *http.Request) bool {
				return true
			},
		},
		// CHANGED: Initialize with ReceiverClient map
		receivers: make(map[string]*ReceiverClient),
		senderURL: senderURL,
	}
}

// =============================================================================
// NEW: BroadcastTimestamp sends timestamp message to all connected browsers
// =============================================================================
// PREVIOUS (in relay_server_h264.go): (not present)
//
// NEW: Method to broadcast timestamp messages to all browser clients
func (s *Server) BroadcastTimestamp(msg []byte) {
	s.receiversMu.RLock()
	defer s.receiversMu.RUnlock()

	// =========================================================================
	// PREVIOUS CODE (simple loop):
	// =========================================================================
	// for _, receiver := range s.receivers {
	// 	receiver.SendTimestamp(msg)
	// }
	// =========================================================================

	// =========================================================================
	// NEW CODE (with debug logging and state checking):
	// =========================================================================
	receiverCount := len(s.receivers)
	sentCount := 0

	for id, receiver := range s.receivers {
		if receiver.DataChannel != nil && receiver.DataChannel.ReadyState() == webrtc.DataChannelStateOpen {
			receiver.SendTimestamp(msg)
			sentCount++
		} else {
			dcState := "nil"
			if receiver.DataChannel != nil {
				dcState = receiver.DataChannel.ReadyState().String()
			}
			log.Printf("⚠️ Cannot send timestamp to %s: DataChannel state=%s", id, dcState)
		}
	}

	// Log every 30th timestamp (roughly once per second at 30fps)
	if sentCount > 0 && receiverCount > 0 {
		// Periodic logging handled elsewhere
	}
	// =========================================================================
}

// END OF NEW BroadcastTimestamp
// =============================================================================

// =============================================================================
// WebSocket Handler (Python Sender)
// =============================================================================

func (s *Server) handleWebSocket(w http.ResponseWriter, r *http.Request) {
	log.Println("New WebSocket connection from Python sender")

	conn, err := s.upgrader.Upgrade(w, r, nil)
	if err != nil {
		log.Println("Failed to upgrade to WebSocket:", err)
		return
	}
	defer conn.Close()

	conn.SetReadDeadline(time.Now().Add(120 * time.Second))
	conn.SetPongHandler(func(string) error {
		conn.SetReadDeadline(time.Now().Add(120 * time.Second))
		return nil
	})

	pingTicker := time.NewTicker(30 * time.Second)
	defer pingTicker.Stop()

	go func() {
		for range pingTicker.C {
			if err := conn.WriteMessage(websocket.PingMessage, nil); err != nil {
				return
			}
		}
	}()

	log.Println("WebSocket connection established with sender")

	config := webrtc.Configuration{
		ICEServers: []webrtc.ICEServer{
			{URLs: []string{"stun:stun.l.google.com:19302"}},
			{URLs: []string{"stun:stun1.l.google.com:19302"}},
		},
	}

	pc, err := webrtc.NewPeerConnection(config)
	if err != nil {
		log.Println("Failed to create PeerConnection:", err)
		return
	}
	defer pc.Close()

	s.mu.Lock()
	s.senderPC = pc
	s.senderConnected = true
	s.mu.Unlock()

	log.Println("Sender PeerConnection created")

	hasKeyframe := false
	keyframeMutex := &sync.Mutex{}

	// =========================================================================
	// CHANGED: Timestamps come via WebSocket, NOT DataChannel
	// =========================================================================
	// REASON: DataChannel from aiortc causes "conflicting ice-ufrag" errors
	//         when combined with video track due to BUNDLE/ICE mismatch.
	//
	// PREVIOUS APPROACH (DataChannel - caused errors):
	//     pc.OnDataChannel(func(dc *webrtc.DataChannel) {
	//         dc.OnMessage(func(msg webrtc.DataChannelMessage) {
	//             // Forward timestamps to browsers
	//         })
	//     })
	//
	// NEW APPROACH: Timestamps come via WebSocket messages (type=frame_timestamp)
	//               and are forwarded to browsers via DataChannel
	// =========================================================================
	// DataChannel handling removed from sender connection
	// Timestamps are now processed in the WebSocket message handler below
	// =========================================================================

	pc.OnTrack(func(track *webrtc.TrackRemote, receiver *webrtc.RTPReceiver) {
		log.Printf("Received track from sender - Kind: %s, Codec: %s, PT: %d",
			track.Kind(), track.Codec().MimeType, track.PayloadType())

		if track.Kind() == webrtc.RTPCodecTypeVideo {
			log.Println("Creating local video track for forwarding...")

			localTrack, err := webrtc.NewTrackLocalStaticRTP(
				webrtc.RTPCodecCapability{
					MimeType:    webrtc.MimeTypeH264,
					ClockRate:   90000,
					SDPFmtpLine: "level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e01f",
				},
				"video",
				"stream",
			)
			if err != nil {
				log.Println("Failed to create local track:", err)
				return
			}

			s.mu.Lock()
			s.videoTrack = localTrack
			s.mu.Unlock()

			log.Println("Local H264 video track created")

			// =====================================================================
			// CHANGED: Updated to use ReceiverClient instead of PeerConnection
			// =====================================================================
			// PREVIOUS (in relay_server_h264.go):
			//     s.receiversMu.RLock()
			//     for id, receiverPC := range s.receivers {
			//         if receiverPC.ConnectionState() == webrtc.PeerConnectionStateConnected {
			//             _, err := receiverPC.AddTrack(localTrack)
			//
			// NEW: Access PeerConnection through ReceiverClient
			s.receiversMu.RLock()
			for id, receiver := range s.receivers {
				if receiver.PC.ConnectionState() == webrtc.PeerConnectionStateConnected {
					_, err := receiver.PC.AddTrack(localTrack)
					if err != nil {
						log.Printf("Failed to add track to receiver %s: %v", id, err)
					}
				}
			}
			s.receiversMu.RUnlock()
			// =====================================================================

			// Request initial keyframe (unchanged)
			go func() {
				time.Sleep(500 * time.Millisecond)
				if err := pc.WriteRTCP([]rtcp.Packet{
					&rtcp.PictureLossIndication{
						MediaSSRC: uint32(track.SSRC()),
					},
				}); err != nil {
					log.Printf("Failed to request initial keyframe: %v", err)
				} else {
					log.Println("Initial H264 IDR frame request sent")
				}
			}()

			// Periodic keyframe requests (unchanged)
			go func() {
				ticker := time.NewTicker(3 * time.Second)
				defer ticker.Stop()

				for range ticker.C {
					keyframeMutex.Lock()
					needsKeyframe := !hasKeyframe
					keyframeMutex.Unlock()

					if needsKeyframe && pc.ConnectionState() == webrtc.PeerConnectionStateConnected {
						if err := pc.WriteRTCP([]rtcp.Packet{
							&rtcp.PictureLossIndication{
								MediaSSRC: uint32(track.SSRC()),
							},
						}); err != nil {
							log.Printf("Failed to send PLI: %v", err)
						}
					}
				}
			}()

			// Forward RTP packets (unchanged)
			go func() {
				packetCount := 0

				for {
					rtpPacket, _, readErr := track.ReadRTP()
					if readErr != nil {
						if readErr != io.EOF {
							log.Printf("Error reading RTP: %v", readErr)
						}
						return
					}

					packetCount++

					// H264 keyframe detection (unchanged)
					if len(rtpPacket.Payload) > 0 {
						nalType := rtpPacket.Payload[0] & 0x1F
						isKeyframe := false

						switch nalType {
						case 5, 7, 8:
							isKeyframe = true
						case 24:
							if len(rtpPacket.Payload) > 3 {
								innerNalType := rtpPacket.Payload[3] & 0x1F
								if innerNalType == 5 || innerNalType == 7 || innerNalType == 8 {
									isKeyframe = true
								}
							}
						}

						if isKeyframe {
							keyframeMutex.Lock()
							if !hasKeyframe {
								log.Printf("First H264 keyframe received at packet #%d!", packetCount)
								hasKeyframe = true
							}
							keyframeMutex.Unlock()
						}
					}

					if packetCount%500 == 0 {
						log.Printf("Forwarded %d H264 packets", packetCount)
					}

					s.mu.Lock()
					if s.videoTrack != nil {
						if err := s.videoTrack.WriteRTP(rtpPacket); err != nil && err != io.ErrClosedPipe {
							if packetCount%100 == 0 {
								log.Printf("Error writing RTP: %v", err)
							}
						}
					}
					s.mu.Unlock()
				}
			}()
		}
	})

	pc.OnICECandidate(func(candidate *webrtc.ICECandidate) {
		if candidate == nil {
			log.Println("Sender ICE gathering complete")
			return
		}

		candidateJSON := candidate.ToJSON()
		msg := SignalMessage{
			Type:      "ice-candidate",
			Candidate: &candidateJSON,
		}

		conn.SetWriteDeadline(time.Now().Add(10 * time.Second))
		if err := conn.WriteJSON(msg); err != nil {
			log.Printf("Failed to send ICE candidate to sender: %v", err)
		}
	})

	pc.OnConnectionStateChange(func(state webrtc.PeerConnectionState) {
		log.Printf("Sender connection state: %s", state.String())

		if state == webrtc.PeerConnectionStateConnected {
			// CHANGED: Updated log message
			log.Println("✓ SENDER CONNECTED - Ready for H264 video + timestamps!")
		} else if state == webrtc.PeerConnectionStateFailed {
			log.Println("Sender connection failed")
		}
	})

	pc.OnICEConnectionStateChange(func(state webrtc.ICEConnectionState) {
		log.Printf("Sender ICE state: %s", state.String())
	})

	// Handle signaling messages
	// CHANGED: Use raw JSON to handle both signaling and timestamp messages
	for {
		conn.SetReadDeadline(time.Now().Add(120 * time.Second))

		_, rawMsg, err := conn.ReadMessage()
		if err != nil {
			log.Printf("WebSocket disconnected: %v", err)
			break
		}

		// Parse message type first
		var baseMsg struct {
			Type string `json:"type"`
		}
		if err := json.Unmarshal(rawMsg, &baseMsg); err != nil {
			log.Printf("Failed to parse message type: %v", err)
			continue
		}

		switch baseMsg.Type {
		case "offer":
			var msg SignalMessage
			if err := json.Unmarshal(rawMsg, &msg); err != nil {
				log.Printf("Failed to parse offer: %v", err)
				continue
			}

			log.Println("Processing offer from sender...")

			if strings.Contains(msg.SDP, "H264") {
				log.Println("✓ H264 codec in offer")
			}

			offer := webrtc.SessionDescription{
				Type: webrtc.SDPTypeOffer,
				SDP:  msg.SDP,
			}

			if err := pc.SetRemoteDescription(offer); err != nil {
				log.Printf("Failed to set remote description: %v", err)
				continue
			}

			answer, err := pc.CreateAnswer(nil)
			if err != nil {
				log.Printf("Failed to create answer: %v", err)
				continue
			}

			if err := pc.SetLocalDescription(answer); err != nil {
				log.Printf("Failed to set local description: %v", err)
				continue
			}

			response := SignalMessage{
				Type: "answer",
				SDP:  answer.SDP,
			}

			conn.SetWriteDeadline(time.Now().Add(10 * time.Second))
			if err := conn.WriteJSON(response); err != nil {
				log.Printf("Failed to send answer: %v", err)
				continue
			}
			log.Println("Answer sent to sender")

		case "ice-candidate":
			var msg SignalMessage
			if err := json.Unmarshal(rawMsg, &msg); err != nil {
				log.Printf("Failed to parse ICE candidate: %v", err)
				continue
			}
			if msg.Candidate != nil {
				if err := pc.AddICECandidate(*msg.Candidate); err != nil {
					log.Printf("Failed to add ICE candidate: %v", err)
				}
			}

		case "ping":
			pong := SignalMessage{Type: "pong"}
			conn.SetWriteDeadline(time.Now().Add(10 * time.Second))
			conn.WriteJSON(pong)

		// =================================================================
		// NEW: Handle frame timestamps from sender (via WebSocket)
		// =================================================================
		// CHANGED: Timestamps now arrive via WebSocket instead of DataChannel
		//          to avoid ICE credential conflicts between aiortc and Pion
		case "frame_timestamp":
			var tsMsg TimestampMessage
			if err := json.Unmarshal(rawMsg, &tsMsg); err != nil {
				log.Printf("Failed to parse timestamp: %v", err)
				continue
			}

			// Add relay timestamp for debugging
			tsMsg.RelayTimeMs = float64(time.Now().UnixNano()) / 1e6

			// Re-encode with relay timestamp
			enrichedMsg, err := json.Marshal(tsMsg)
			if err != nil {
				log.Printf("Failed to re-encode timestamp: %v", err)
				continue
			}

			// =============================================================
			// PREVIOUS CODE (no logging):
			// =============================================================
			// // Broadcast to all browser clients via DataChannel
			// s.BroadcastTimestamp(enrichedMsg)
			// =============================================================

			// =============================================================
			// NEW CODE (with periodic debug logging):
			// =============================================================
			// Log periodically (every 30 timestamps = ~1 second at 30fps)
			if tsMsg.FrameNum%30 == 0 {
				s.receiversMu.RLock()
				numReceivers := len(s.receivers)
				s.receiversMu.RUnlock()
				log.Printf("📡 Timestamp frame=%d, broadcasting to %d receivers", tsMsg.FrameNum, numReceivers)
			}

			// Broadcast to all browser clients via DataChannel
			s.BroadcastTimestamp(enrichedMsg)
			// =============================================================
		// =================================================================

		default:
			log.Printf("Unknown message type: %s", baseMsg.Type)
		}
	}

	// =========================================================================
	// Cleanup (senderDC removed - using WebSocket for timestamps)
	// =========================================================================
	s.mu.Lock()
	s.senderConnected = false
	s.senderPC = nil
	s.videoTrack = nil
	s.mu.Unlock()
	// =========================================================================

	log.Println("Sender disconnected")
}

// =============================================================================
// HTTP Handler (Browser Clients)
// =============================================================================

func (s *Server) handleOffer(w http.ResponseWriter, r *http.Request) {
	log.Println("Received offer from browser client")

	if r.Method == http.MethodOptions {
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Access-Control-Allow-Methods", "POST, OPTIONS")
		w.Header().Set("Access-Control-Allow-Headers", "Content-Type")
		w.WriteHeader(http.StatusOK)
		return
	}

	if r.Method != http.MethodPost {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	w.Header().Set("Access-Control-Allow-Origin", "*")

	s.mu.Lock()
	senderConnected := s.senderConnected
	videoTrack := s.videoTrack
	s.mu.Unlock()

	if !senderConnected || videoTrack == nil {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusServiceUnavailable)
		json.NewEncoder(w).Encode(map[string]string{
			"error": "Video not ready. Please wait for sender connection.",
		})
		return
	}

	var offerReq OfferRequest
	if err := json.NewDecoder(r.Body).Decode(&offerReq); err != nil {
		http.Error(w, "Invalid JSON", http.StatusBadRequest)
		return
	}

	config := webrtc.Configuration{
		ICEServers: []webrtc.ICEServer{
			{URLs: []string{"stun:stun.l.google.com:19302"}},
			{URLs: []string{"stun:stun1.l.google.com:19302"}},
		},
	}

	pc, err := webrtc.NewPeerConnection(config)
	if err != nil {
		http.Error(w, "Failed to create peer connection", http.StatusInternalServerError)
		return
	}

	receiverID := fmt.Sprintf("receiver-%d", time.Now().UnixNano())
	log.Printf("Creating receiver %s for browser client", receiverID)

	// =========================================================================
	// CHANGED: Create ReceiverClient instead of just storing PeerConnection
	// =========================================================================
	// PREVIOUS (in relay_server_h264.go):
	//     s.receiversMu.Lock()
	//     s.receivers[receiverID] = pc
	//     s.receiversMu.Unlock()
	//
	// NEW: Create ReceiverClient with DataChannel
	receiver := &ReceiverClient{
		ID: receiverID,
		PC: pc,
	}
	// =========================================================================

	// =========================================================================
	// CHANGED: Receive DataChannel from browser via ondatachannel
	// =========================================================================
	// PREVIOUS APPROACH (server creates DataChannel - DIDN'T WORK):
	// =========================================================================
	// The server created DataChannel after receiving offer, but this caused
	// DataChannel to stay in "connecting" state forever because it wasn't
	// included in the SDP negotiation (browser's offer didn't know about it).
	//
	// dc, err := pc.CreateDataChannel("timestamps", &webrtc.DataChannelInit{
	// 	Ordered: func() *bool { b := true; return &b }(),
	// })
	// if err != nil {
	// 	log.Printf("Failed to create DataChannel for receiver: %v", err)
	// } else {
	// 	receiver.DataChannel = dc
	// 	dc.OnOpen(func() { ... })
	// 	dc.OnMessage(func(msg) { ... })
	// }
	// =========================================================================

	// =========================================================================
	// NEW APPROACH: Browser creates DataChannel, server receives via ondatachannel
	// =========================================================================
	// Browser includes DataChannel in its offer, server receives it here.
	// This ensures proper SDP negotiation and DataChannel opens correctly.
	log.Printf("Setting up OnDataChannel handler for %s", receiverID)
	pc.OnDataChannel(func(dc *webrtc.DataChannel) {
		log.Printf("📡 Received DataChannel from browser %s: '%s'", receiverID, dc.Label())

		if dc.Label() == "timestamps" {
			log.Printf("📡 Assigning timestamps DataChannel to receiver %s", receiverID)
			receiver.mu.Lock()
			receiver.DataChannel = dc
			receiver.mu.Unlock()

			dc.OnOpen(func() {
				log.Printf("📡 Browser %s DataChannel OPEN", receiverID)
			})

			dc.OnClose(func() {
				log.Printf("📡 Browser %s DataChannel CLOSED", receiverID)
			})

			dc.OnMessage(func(msg webrtc.DataChannelMessage) {
				// Handle clock sync pings from browser
				var tsMsg TimestampMessage
				// =============================================================
				// PREVIOUS CODE (silent error handling):
				// =============================================================
				// if err := json.Unmarshal(msg.Data, &tsMsg); err != nil {
				// 	return
				// }
				// =============================================================

				// =============================================================
				// NEW CODE (with error logging):
				// =============================================================
				if err := json.Unmarshal(msg.Data, &tsMsg); err != nil {
					log.Printf("⚠️ Failed to parse DataChannel message from browser: %v", err)
					return
				}
				// =============================================================

				if tsMsg.Type == "ping" {
					// ==========================================================
					// PREVIOUS CODE (silent pong):
					// ==========================================================
					// // Respond with server time for clock sync
					// pong := TimestampMessage{
					// 	Type:       "pong",
					// 	ClientTime: tsMsg.ClientTime,
					// 	ServerTime: float64(time.Now().UnixNano()) / 1e6,
					// }
					// pongBytes, _ := json.Marshal(pong)
					// dc.Send(pongBytes)
					// ==========================================================

					// ==========================================================
					// NEW CODE (with debug logging):
					// ==========================================================
					log.Printf("🕐 Browser %s clock sync ping received, sending pong", receiverID)
					// Respond with server time for clock sync
					pong := TimestampMessage{
						Type:       "pong",
						ClientTime: tsMsg.ClientTime,
						ServerTime: float64(time.Now().UnixNano()) / 1e6,
					}
					pongBytes, _ := json.Marshal(pong)
					// ======================================================
					// PREVIOUS CODE (sent binary - browser couldn't parse):
					// ======================================================
					// if err := dc.Send(pongBytes); err != nil {
					// 	log.Printf("⚠️ Failed to send pong to %s: %v", receiverID, err)
					// }
					// ======================================================

					// ======================================================
					// NEW CODE (send as text for JSON parsing in browser):
					// ======================================================
					if err := dc.SendText(string(pongBytes)); err != nil {
						log.Printf("⚠️ Failed to send pong to %s: %v", receiverID, err)
					}
					// ======================================================
					// ==========================================================
				}
			})
		} else {
			log.Printf("⚠️ Received unexpected DataChannel '%s' from browser %s", dc.Label(), receiverID)
		}
	})
	log.Printf("OnDataChannel handler registered for %s", receiverID)
	// END OF NEW DataChannel handling
	// =========================================================================

	s.receiversMu.Lock()
	s.receivers[receiverID] = receiver
	s.receiversMu.Unlock()

	// =======================================================================
	// CHANGED: Updated log message (DataChannel comes from browser now)
	// =======================================================================
	// PREVIOUS: log.Printf("Receiver created (ID: %s) with DataChannel", receiverID)
	// NEW:
	log.Printf("Receiver created (ID: %s) - awaiting DataChannel from browser", receiverID)
	// =======================================================================

	pc.OnConnectionStateChange(func(state webrtc.PeerConnectionState) {
		log.Printf("Receiver %s state: %s", receiverID, state.String())

		if state == webrtc.PeerConnectionStateConnected {
			// CHANGED: Updated log message
			log.Printf("✓ BROWSER %s CONNECTED (H264 + timestamps)!", receiverID)

			// Request keyframe (unchanged)
			if s.senderPC != nil {
				for _, recv := range s.senderPC.GetReceivers() {
					if recv.Track() != nil && recv.Track().Kind() == webrtc.RTPCodecTypeVideo {
						s.senderPC.WriteRTCP([]rtcp.Packet{
							&rtcp.PictureLossIndication{
								MediaSSRC: uint32(recv.Track().SSRC()),
							},
						})
						break
					}
				}
			}
		} else if state == webrtc.PeerConnectionStateFailed || state == webrtc.PeerConnectionStateClosed {
			s.receiversMu.Lock()
			delete(s.receivers, receiverID)
			s.receiversMu.Unlock()
		}
	})

	// Add video track (unchanged)
	rtpSender, err := pc.AddTrack(videoTrack)
	if err != nil {
		http.Error(w, "Failed to add track", http.StatusInternalServerError)
		return
	}

	go func() {
		rtcpBuf := make([]byte, 1500)
		for {
			if _, _, err := rtpSender.Read(rtcpBuf); err != nil {
				return
			}
		}
	}()

	offer := webrtc.SessionDescription{
		Type: webrtc.SDPTypeOffer,
		SDP:  offerReq.SDP,
	}

	// =======================================================================
	// NEW: Check if browser included DataChannel in offer
	// =======================================================================
	if strings.Contains(offer.SDP, "application") {
		log.Printf("✓ DataChannel found in browser offer for %s", receiverID)
	} else {
		log.Printf("⚠️ No DataChannel in browser offer for %s - timestamps won't work!", receiverID)
		// Log first 500 chars of SDP for debugging
		sdpPreview := offer.SDP
		if len(sdpPreview) > 500 {
			sdpPreview = sdpPreview[:500] + "..."
		}
		log.Printf("Offer SDP preview: %s", sdpPreview)
	}
	// =======================================================================

	if err := pc.SetRemoteDescription(offer); err != nil {
		log.Printf("Failed to set remote description for %s: %v", receiverID, err)
		http.Error(w, "Failed to set remote description", http.StatusInternalServerError)
		return
	}
	log.Printf("Remote description set for %s", receiverID)

	answer, err := pc.CreateAnswer(nil)
	if err != nil {
		log.Printf("Failed to create answer for %s: %v", receiverID, err)
		http.Error(w, "Failed to create answer", http.StatusInternalServerError)
		return
	}
	log.Printf("Answer created for %s", receiverID)

	// =======================================================================
	// CHANGED: Check for DataChannel in offer (browser creates it now)
	// =======================================================================
	// PREVIOUS CODE (checked answer - but server was creating DataChannel):
	// =======================================================================
	// // Debug: Check if DataChannel is in the answer
	// if strings.Contains(answer.SDP, "application") {
	// 	log.Printf("✓ DataChannel included in answer SDP for %s", receiverID)
	// } else {
	// 	log.Printf("⚠️ DataChannel NOT in answer SDP for %s", receiverID)
	// }
	// =======================================================================

	// =======================================================================
	// NEW CODE: DataChannel is in browser's offer, answer acknowledges it
	// =======================================================================
	if strings.Contains(answer.SDP, "application") {
		log.Printf("✓ DataChannel negotiation in answer SDP for %s", receiverID)
	} else {
		log.Printf("⚠️ DataChannel NOT in answer SDP for %s", receiverID)
	}
	// =======================================================================

	gatherComplete := webrtc.GatheringCompletePromise(pc)

	if err := pc.SetLocalDescription(answer); err != nil {
		http.Error(w, "Failed to set local description", http.StatusInternalServerError)
		return
	}

	select {
	case <-gatherComplete:
	case <-time.After(3 * time.Second):
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]string{
		"sdp":  pc.LocalDescription().SDP,
		"type": "answer",
	})

	// CHANGED: Updated log message
	log.Println("Answer sent to browser (includes DataChannel)")
}

func (s *Server) handleConfig(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Access-Control-Allow-Origin", "*")

	s.receiversMu.RLock()
	numReceivers := len(s.receivers)
	s.receiversMu.RUnlock()

	// =========================================================================
	// CHANGED: Added latency_supported field to config response
	// =========================================================================
	// PREVIOUS (in relay_server_h264.go):
	//     json.NewEncoder(w).Encode(map[string]interface{}{
	//         "sender_url":    s.senderURL,
	//         "status":        s.senderConnected,
	//         "num_receivers": numReceivers,
	//         "codec":         "H264",
	//     })
	//
	// NEW: Added latency_supported field
	json.NewEncoder(w).Encode(map[string]interface{}{
		"sender_url":        s.senderURL,
		"status":            s.senderConnected,
		"num_receivers":     numReceivers,
		"codec":             "H264",
		"latency_supported": true, // NEW: Indicates latency measurement is available
	})
	// =========================================================================
}

func main() {
	httpPort := 8081
	senderURL := "Python Sender via WebSocket"

	server := NewServer(senderURL)

	http.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/" {
			http.ServeFile(w, r, "./static/index.html")
			return
		}
		fs := http.FileServer(http.Dir("./static"))
		fs.ServeHTTP(w, r)
	})

	http.HandleFunc("/ws", server.handleWebSocket)
	http.HandleFunc("/offer", server.handleOffer)
	http.HandleFunc("/config", server.handleConfig)

	http.HandleFunc("/client.js", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/javascript")
		http.ServeFile(w, r, "./static/client.js")
	})

	http.HandleFunc("/health", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		// CHANGED: Updated health message
		w.Write([]byte("WebRTC H264 Server with Latency Measurement"))
	})

	separator := strings.Repeat("=", 60)

	// =========================================================================
	// CHANGED: Updated startup banner
	// =========================================================================
	log.Println(separator)
	log.Println("WebRTC Server - Glass-to-Glass Latency Measurement")
	log.Println(separator)
	// =======================================================================
	// PREVIOUS feature list:
	// =======================================================================
	// log.Println("Features:")
	// log.Println("  ✓ H264 video codec")
	// log.Println("  ✓ Frame timestamps via WebSocket (sender→relay)")
	// log.Println("  ✓ DataChannel to browsers (relay→browser)")
	// log.Println("  ✓ Glass-to-glass latency measurement")
	// =======================================================================

	// =======================================================================
	// NEW feature list (clarifies DataChannel direction):
	// =======================================================================
	log.Println("Features:")
	log.Println("  ✓ H264 video codec")
	log.Println("  ✓ Frame timestamps via WebSocket (Python sender → Go relay)")
	log.Println("  ✓ DataChannel created by browser (Go relay ← Browser)")
	log.Println("  ✓ Timestamps forwarded to browser via DataChannel")
	log.Println("  ✓ Glass-to-glass latency measurement")
	log.Println(separator)
	// =======================================================================
	// =========================================================================
	log.Printf("WebSocket endpoint: ws://localhost:%d/ws", httpPort)
	log.Printf("Web interface: http://localhost:%d", httpPort)
	log.Println(separator)

	addr := fmt.Sprintf(":%d", httpPort)
	if err := http.ListenAndServe(addr, nil); err != nil {
		log.Fatal("Server failed to start:", err)
	}
}
