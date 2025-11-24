package main

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

type SignalMessage struct {
	Type      string                    `json:"type"`
	SDP       string                    `json:"sdp,omitempty"`
	Candidate *webrtc.ICECandidateInit `json:"candidate,omitempty"`
}

type OfferRequest struct {
	SDP  string `json:"sdp"`
	Type string `json:"type"`
}

// Server manages WebRTC connections and signaling
type Server struct {
	upgrader websocket.Upgrader

	// Peer connections
	senderPC    *webrtc.PeerConnection
	receivers   map[string]*webrtc.PeerConnection
	receiversMu sync.RWMutex

	// Tracks
	videoTrack *webrtc.TrackLocalStaticRTP

	// Synchronization
	mu              sync.Mutex
	senderConnected bool

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
		receivers: make(map[string]*webrtc.PeerConnection),
		senderURL: senderURL,
	}
}

func (s *Server) handleWebSocket(w http.ResponseWriter, r *http.Request) {
	log.Println("New WebSocket connection from Python sender")

	conn, err := s.upgrader.Upgrade(w, r, nil)
	if err != nil {
		log.Println("Failed to upgrade to WebSocket:", err)
		return
	}
	defer conn.Close()
	
	// Configure WebSocket with longer read deadline
	conn.SetReadDeadline(time.Now().Add(120 * time.Second))
	conn.SetPongHandler(func(string) error {
		conn.SetReadDeadline(time.Now().Add(120 * time.Second))
		return nil
	})

	// Start ping ticker for keepalive from server side
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

	// Variable to track if we've seen a keyframe
	hasKeyframe := false
	keyframeMutex := &sync.Mutex{}

	pc.OnTrack(func(track *webrtc.TrackRemote, receiver *webrtc.RTPReceiver) {
		log.Printf("Received track from sender - Kind: %s, Codec: %s, PT: %d", 
			track.Kind(), track.Codec().MimeType, track.PayloadType())

		if track.Kind() == webrtc.RTPCodecTypeVideo {
			log.Println("Creating local video track for forwarding...")

			localTrack, err := webrtc.NewTrackLocalStaticRTP(
				webrtc.RTPCodecCapability{
					MimeType:    webrtc.MimeTypeVP8,
					ClockRate:   90000,
					SDPFmtpLine: "",
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

			log.Println("Local video track created for VP8")

			// Add track to all existing receivers
			s.receiversMu.RLock()
			for id, receiverPC := range s.receivers {
				if receiverPC.ConnectionState() == webrtc.PeerConnectionStateConnected {
					_, err := receiverPC.AddTrack(localTrack)
					if err != nil {
						log.Printf("Failed to add track to receiver %s: %v", id, err)
					}
				}
			}
			s.receiversMu.RUnlock()

			// Request initial keyframe
			go func() {
				time.Sleep(1 * time.Second)
				if err := pc.WriteRTCP([]rtcp.Packet{
					&rtcp.PictureLossIndication{
						MediaSSRC: uint32(track.SSRC()),
					},
				}); err != nil {
					log.Printf("Failed to request initial keyframe: %v", err)
				} else {
					log.Println("Initial keyframe request sent")
				}
			}()

			// Periodic keyframe requests
			go func() {
				ticker := time.NewTicker(5 * time.Second)
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
						} else {
							log.Println("Periodic keyframe request sent")
						}
					}
				}
			}()

			// Forward packets
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

					// Check for VP8 keyframe
					if len(rtpPacket.Payload) > 0 {
						vp8Header := rtpPacket.Payload[0]
						isKeyframe := (vp8Header & 0x01) == 0
						
						if isKeyframe {
							keyframeMutex.Lock()
							if !hasKeyframe {
								log.Printf("First keyframe received at packet #%d!", packetCount)
								hasKeyframe = true
							}
							keyframeMutex.Unlock()
						}
					}

					if packetCount%500 == 0 {
						log.Printf("Forwarded %d packets", packetCount)
					}

					// Write RTP packet
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
			log.Println("SENDER CONNECTED - Ready to receive video!")
		} else if state == webrtc.PeerConnectionStateFailed {
			log.Println("Sender connection failed")
		}
	})

	pc.OnICEConnectionStateChange(func(state webrtc.ICEConnectionState) {
		log.Printf("Sender ICE state: %s", state.String())
	})

	// Handle signaling messages with ping/pong support
	for {
		var msg SignalMessage
		
		// Reset read deadline for each message
		conn.SetReadDeadline(time.Now().Add(120 * time.Second))
		
		err := conn.ReadJSON(&msg)
		if err != nil {
			log.Printf("WebSocket disconnected: %v", err)
			break
		}

		log.Printf("Received from sender: type=%s", msg.Type)

		switch msg.Type {
		case "offer":
			log.Println("Processing offer from sender...")

			offer := webrtc.SessionDescription{
				Type: webrtc.SDPTypeOffer,
				SDP:  msg.SDP,
			}

			if err := pc.SetRemoteDescription(offer); err != nil {
				log.Printf("Failed to set remote description: %v", err)
				continue
			}
			log.Println("Remote description (offer) set")

			answer, err := pc.CreateAnswer(nil)
			if err != nil {
				log.Printf("Failed to create answer: %v", err)
				continue
			}
			log.Println("✓ Answer created")

			if err := pc.SetLocalDescription(answer); err != nil {
				log.Printf("Failed to set local description: %v", err)
				continue
			}
			log.Println("Local description (answer) set")

			response := SignalMessage{
				Type: "answer",
				SDP:  answer.SDP,
			}

			conn.SetWriteDeadline(time.Now().Add(10 * time.Second))
			if err := conn.WriteJSON(response); err != nil {
				log.Printf("Failed to send answer: %v", err)
				continue
			}
			log.Println("Answer sent to sender successfully")

		case "ice-candidate":
			if msg.Candidate != nil {
				if err := pc.AddICECandidate(*msg.Candidate); err != nil {
					log.Printf("Failed to add ICE candidate: %v", err)
				} else {
					log.Println("Sender ICE candidate added")
				}
			}
		
		// WICHTIGG!!!! NEW: Handle ping messages
		case "ping":
			// Respond with pong to keep connection alive
			pong := SignalMessage{Type: "pong"}
			conn.SetWriteDeadline(time.Now().Add(10 * time.Second))
			if err := conn.WriteJSON(pong); err != nil {
				log.Printf("Failed to send pong: %v", err)
			}
		}
	}

	// Cleanup
	s.mu.Lock()
	s.senderConnected = false
	s.senderPC = nil
	s.videoTrack = nil
	s.mu.Unlock()

	log.Println("Sender disconnected")
}

func (s *Server) handleOffer(w http.ResponseWriter, r *http.Request) {
	log.Println("Received offer from browser client")

	if r.Method != http.MethodPost {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	// Enable CORS
	w.Header().Set("Access-Control-Allow-Origin", "*")
	w.Header().Set("Access-Control-Allow-Methods", "POST, OPTIONS")
	w.Header().Set("Access-Control-Allow-Headers", "Content-Type")

	if r.Method == http.MethodOptions {
		w.WriteHeader(http.StatusOK)
		return
	}

	s.mu.Lock()
	senderConnected := s.senderConnected
	videoTrack := s.videoTrack
	s.mu.Unlock()

	if !senderConnected || videoTrack == nil {
		log.Println("Sender not connected or video track not ready")
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusServiceUnavailable)
		json.NewEncoder(w).Encode(map[string]string{
			"error": "Video not ready. Please wait for sender connection.",
		})
		return
	}

	var offerReq OfferRequest
	if err := json.NewDecoder(r.Body).Decode(&offerReq); err != nil {
		log.Printf("Failed to parse offer: %v", err)
		http.Error(w, "Invalid JSON", http.StatusBadRequest)
		return
	}

	log.Println("Parsed browser offer")

	config := webrtc.Configuration{
		ICEServers: []webrtc.ICEServer{
			{URLs: []string{"stun:stun.l.google.com:19302"}},
			{URLs: []string{"stun:stun1.l.google.com:19302"}},
		},
	}

	pc, err := webrtc.NewPeerConnection(config)
	if err != nil {
		log.Printf("Failed to create receiver PeerConnection: %v", err)
		http.Error(w, "Failed to create peer connection", http.StatusInternalServerError)
		return
	}

	receiverID := fmt.Sprintf("receiver-%d", time.Now().UnixNano())

	s.receiversMu.Lock()
	s.receivers[receiverID] = pc
	s.receiversMu.Unlock()

	log.Printf("Receiver PeerConnection created (ID: %s)", receiverID)

	// Monitor connection
	pc.OnConnectionStateChange(func(state webrtc.PeerConnectionState) {
		log.Printf("Receiver %s state: %s", receiverID, state.String())

		if state == webrtc.PeerConnectionStateConnected {
			log.Printf("BROWSER %s CONNECTED!", receiverID)
			
			// Request keyframe for new connection
			if s.senderPC != nil {
				for _, receiver := range s.senderPC.GetReceivers() {
					if receiver.Track() != nil && receiver.Track().Kind() == webrtc.RTPCodecTypeVideo {
						s.senderPC.WriteRTCP([]rtcp.Packet{
							&rtcp.PictureLossIndication{
								MediaSSRC: uint32(receiver.Track().SSRC()),
							},
						})
						log.Println("Keyframe requested for new browser")
						break
					}
				}
			}
		} else if state == webrtc.PeerConnectionStateFailed || state == webrtc.PeerConnectionStateClosed {
			log.Printf("Receiver %s disconnected", receiverID)
			
			s.receiversMu.Lock()
			delete(s.receivers, receiverID)
			s.receiversMu.Unlock()
		}
	})

	pc.OnICEConnectionStateChange(func(state webrtc.ICEConnectionState) {
		log.Printf("Receiver %s ICE state: %s", receiverID, state.String())
	})

	// Add the video track
	rtpSender, err := pc.AddTrack(videoTrack)
	if err != nil {
		log.Printf("Failed to add track: %v", err)
		http.Error(w, "Failed to add track", http.StatusInternalServerError)
		return
	}
	
	log.Printf("Video track added to receiver")

	// Handle RTCP
	go func() {
		rtcpBuf := make([]byte, 1500)
		for {
			if _, _, rtcpErr := rtpSender.Read(rtcpBuf); rtcpErr != nil {
				return
			}
		}
	}()

	// Set remote description
	offer := webrtc.SessionDescription{
		Type: webrtc.SDPTypeOffer,
		SDP:  offerReq.SDP,
	}

	if err := pc.SetRemoteDescription(offer); err != nil {
		log.Printf("Failed to set remote description: %v", err)
		http.Error(w, "Failed to set remote description", http.StatusInternalServerError)
		return
	}
	log.Println("Remote description set")

	// Create answer
	answer, err := pc.CreateAnswer(nil)
	if err != nil {
		log.Printf("Failed to create answer: %v", err)
		http.Error(w, "Failed to create answer", http.StatusInternalServerError)
		return
	}
	log.Println("Answer created")

	// Wait for ICE gathering
	gatherComplete := webrtc.GatheringCompletePromise(pc)

	if err := pc.SetLocalDescription(answer); err != nil {
		log.Printf("Failed to set local description: %v", err)
		http.Error(w, "Failed to set local description", http.StatusInternalServerError)
		return
	}
	log.Println("Local description set")

	// Wait for ICE
	select {
	case <-gatherComplete:
		log.Println("ICE gathering complete")
	case <-time.After(3 * time.Second):
		log.Println("ICE gathering timeout")
	}

	// Send answer
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]string{
		"sdp":  pc.LocalDescription().SDP,
		"type": "answer",
	})

	log.Println("Answer sent to browser")
}

func (s *Server) handleConfig(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Access-Control-Allow-Origin", "*")
	
	s.receiversMu.RLock()
	numReceivers := len(s.receivers)
	s.receiversMu.RUnlock()
	
	json.NewEncoder(w).Encode(map[string]interface{}{
		"sender_url":    s.senderURL,
		"status":        s.senderConnected,
		"num_receivers": numReceivers,
	})
}

func main() {
	httpPort := 8080
	senderURL := "Python Sender via WebSocket"

	server := NewServer(senderURL)

	// Serve static files
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
		w.Write([]byte("WebRTC Server Running"))
	})

	separator := strings.Repeat("=", 60)

	log.Println(separator)
	log.Println("WebRTC Server with Keepalive Starting...")
	log.Println(separator)
	log.Printf("WebSocket endpoint: ws://localhost:%d/ws", httpPort)
	log.Printf("Web interface: http://localhost:%d", httpPort)
	log.Println(separator)
	log.Println("Instructions:")
	log.Println("   1. Start this server")
	log.Println("   2. Start Python sender")
	log.Println("   3. Wait for 'SENDER CONNECTED' message")
	log.Println("   4. Open browser at http://localhost:8080")
	log.Println("   5. Click 'Start Stream'")
	log.Println(separator)

	addr := fmt.Sprintf(":%d", httpPort)
	if err := http.ListenAndServe(addr, nil); err != nil {
		log.Fatal("!! Server failed to start:", err)
	}
}