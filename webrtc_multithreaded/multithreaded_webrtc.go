package main

/*
WebRTC Relay Server - Optimized for Stable Glass-to-Glass Latency
==================================================================

PROBLEM: Original had mutex contention in BroadcastTimestamp causing delays

SOLUTION:
  1. Copy receiver list under lock, then broadcast without lock
  2. Use RWMutex properly (read lock for broadcast)
  3. Non-blocking DataChannel sends with buffered channels
  4. Separate goroutine for timestamp broadcasting
*/

import (
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"strings"
	"sync"
	"sync/atomic"
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

type TimestampMessage struct {
	Type        string  `json:"type"`
	Seq         int64   `json:"seq,omitempty"`
	FrameID     int64   `json:"frame_id,omitempty"`
	CaptureMs   float64 `json:"capture_ms,omitempty"`
	FrameNum    int64   `json:"frame_num,omitempty"`
	SendTimeMs  float64 `json:"send_time_ms,omitempty"`
	RelayTimeMs float64 `json:"relay_time_ms,omitempty"`
	ClientTime  float64 `json:"client_time,omitempty"`
	ServerTime  float64 `json:"server_time,omitempty"`
}

// =============================================================================
// Receiver Client with Non-Blocking Send
// =============================================================================

type ReceiverClient struct {
	ID          string
	PC          *webrtc.PeerConnection
	DataChannel *webrtc.DataChannel
	sendChan    chan string // Buffered channel for non-blocking sends
	closed      int32       // Atomic flag
}

func NewReceiverClient(id string, pc *webrtc.PeerConnection) *ReceiverClient {
	r := &ReceiverClient{
		ID:       id,
		PC:       pc,
		sendChan: make(chan string, 100), // Buffer 100 messages
	}
	go r.sendLoop()
	return r
}

func (r *ReceiverClient) sendLoop() {
	for msg := range r.sendChan {
		if atomic.LoadInt32(&r.closed) == 1 {
			return
		}
		if r.DataChannel != nil && r.DataChannel.ReadyState() == webrtc.DataChannelStateOpen {
			if err := r.DataChannel.SendText(msg); err != nil {
				log.Printf("Send error to %s: %v", r.ID, err)
			}
		}
	}
}

func (r *ReceiverClient) SendTimestamp(msg string) {
	if atomic.LoadInt32(&r.closed) == 1 {
		return
	}
	// Non-blocking send
	select {
	case r.sendChan <- msg:
	default:
		// Channel full, drop message (shouldn't happen with buffer of 100)
	}
}

func (r *ReceiverClient) Close() {
	atomic.StoreInt32(&r.closed, 1)
	close(r.sendChan)
}

// =============================================================================
// Server
// =============================================================================

type Server struct {
	upgrader websocket.Upgrader

	senderPC        *webrtc.PeerConnection
	senderConnected bool

	receivers   map[string]*ReceiverClient
	receiversMu sync.RWMutex

	videoTrack *webrtc.TrackLocalStaticRTP

	mu sync.Mutex

	// Stats
	timestampCount uint64
	lastLogTime    time.Time
}

func NewServer() *Server {
	return &Server{
		upgrader: websocket.Upgrader{
			CheckOrigin: func(r *http.Request) bool { return true },
		},
		receivers:   make(map[string]*ReceiverClient),
		lastLogTime: time.Now(),
	}
}

// =============================================================================
// OPTIMIZED: Broadcast with minimal lock time
// =============================================================================

func (s *Server) BroadcastTimestamp(msgJSON string) {
	// Take read lock only to copy receiver list
	s.receiversMu.RLock()
	receivers := make([]*ReceiverClient, 0, len(s.receivers))
	for _, r := range s.receivers {
		receivers = append(receivers, r)
	}
	s.receiversMu.RUnlock()

	// Broadcast without holding lock
	for _, r := range receivers {
		r.SendTimestamp(msgJSON)
	}

	// Stats
	atomic.AddUint64(&s.timestampCount, 1)
}

// =============================================================================
// WebSocket Handler (Python Sender)
// =============================================================================

func (s *Server) handleWebSocket(w http.ResponseWriter, r *http.Request) {
	log.Println("📡 Python sender connecting...")

	conn, err := s.upgrader.Upgrade(w, r, nil)
	if err != nil {
		log.Println("Upgrade failed:", err)
		return
	}
	defer conn.Close()

	conn.SetReadDeadline(time.Now().Add(120 * time.Second))
	conn.SetPongHandler(func(string) error {
		conn.SetReadDeadline(time.Now().Add(120 * time.Second))
		return nil
	})

	// Ping ticker
	go func() {
		ticker := time.NewTicker(30 * time.Second)
		defer ticker.Stop()
		for range ticker.C {
			if err := conn.WriteMessage(websocket.PingMessage, nil); err != nil {
				return
			}
		}
	}()

	log.Println("✓ Sender WebSocket connected")

	config := webrtc.Configuration{
		ICEServers: []webrtc.ICEServer{
			{URLs: []string{"stun:stun.l.google.com:19302"}},
		},
	}

	pc, err := webrtc.NewPeerConnection(config)
	if err != nil {
		log.Println("PeerConnection failed:", err)
		return
	}
	defer pc.Close()

	s.mu.Lock()
	s.senderPC = pc
	s.senderConnected = true
	s.mu.Unlock()

	hasKeyframe := false
	keyframeMu := &sync.Mutex{}

	pc.OnTrack(func(track *webrtc.TrackRemote, receiver *webrtc.RTPReceiver) {
		log.Printf("📹 Track: %s %s", track.Kind(), track.Codec().MimeType)

		if track.Kind() == webrtc.RTPCodecTypeVideo {
			localTrack, err := webrtc.NewTrackLocalStaticRTP(
				webrtc.RTPCodecCapability{
					MimeType:    webrtc.MimeTypeH264,
					ClockRate:   90000,
					SDPFmtpLine: "level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e01f",
				},
				"video", "stream",
			)
			if err != nil {
				log.Println("Track create failed:", err)
				return
			}

			s.mu.Lock()
			s.videoTrack = localTrack
			s.mu.Unlock()

			log.Println("✓ Local H264 track created")

			// Add to existing receivers
			s.receiversMu.RLock()
			for id, r := range s.receivers {
				if r.PC.ConnectionState() == webrtc.PeerConnectionStateConnected {
					if _, err := r.PC.AddTrack(localTrack); err != nil {
						log.Printf("Add track to %s failed: %v", id, err)
					}
				}
			}
			s.receiversMu.RUnlock()

			// Request keyframe
			go func() {
				time.Sleep(500 * time.Millisecond)
				pc.WriteRTCP([]rtcp.Packet{
					&rtcp.PictureLossIndication{MediaSSRC: uint32(track.SSRC())},
				})
			}()

			// Periodic keyframe requests
			go func() {
				ticker := time.NewTicker(3 * time.Second)
				defer ticker.Stop()
				for range ticker.C {
					keyframeMu.Lock()
					need := !hasKeyframe
					keyframeMu.Unlock()
					if need && pc.ConnectionState() == webrtc.PeerConnectionStateConnected {
						pc.WriteRTCP([]rtcp.Packet{
							&rtcp.PictureLossIndication{MediaSSRC: uint32(track.SSRC())},
						})
					}
				}
			}()

			// Forward RTP
			go func() {
				count := 0
				for {
					pkt, _, err := track.ReadRTP()
					if err != nil {
						if err != io.EOF {
							log.Printf("RTP read error: %v", err)
						}
						return
					}
					count++

					// Keyframe detection
					if len(pkt.Payload) > 0 {
						nalType := pkt.Payload[0] & 0x1F
						if nalType == 5 || nalType == 7 || nalType == 8 {
							keyframeMu.Lock()
							if !hasKeyframe {
								log.Printf("✓ First keyframe at packet #%d", count)
								hasKeyframe = true
							}
							keyframeMu.Unlock()
						}
					}

					if count%1000 == 0 {
						log.Printf("📦 %d H264 packets forwarded", count)
					}

					s.mu.Lock()
					if s.videoTrack != nil {
						s.videoTrack.WriteRTP(pkt)
					}
					s.mu.Unlock()
				}
			}()
		}
	})

	pc.OnICECandidate(func(c *webrtc.ICECandidate) {
		if c == nil {
			return
		}
		cj := c.ToJSON()
		conn.SetWriteDeadline(time.Now().Add(10 * time.Second))
		conn.WriteJSON(SignalMessage{Type: "ice-candidate", Candidate: &cj})
	})

	pc.OnConnectionStateChange(func(state webrtc.PeerConnectionState) {
		log.Printf("Sender state: %s", state)
		if state == webrtc.PeerConnectionStateConnected {
			log.Println("✓ SENDER CONNECTED")
		}
	})

	// Message loop
	for {
		conn.SetReadDeadline(time.Now().Add(120 * time.Second))
		_, raw, err := conn.ReadMessage()
		if err != nil {
			log.Printf("WebSocket error: %v", err)
			break
		}

		var base struct{ Type string `json:"type"` }
		if json.Unmarshal(raw, &base) != nil {
			continue
		}

		switch base.Type {
		case "offer":
			var msg SignalMessage
			json.Unmarshal(raw, &msg)

			offer := webrtc.SessionDescription{Type: webrtc.SDPTypeOffer, SDP: msg.SDP}
			pc.SetRemoteDescription(offer)

			answer, _ := pc.CreateAnswer(nil)
			pc.SetLocalDescription(answer)

			conn.SetWriteDeadline(time.Now().Add(10 * time.Second))
			conn.WriteJSON(SignalMessage{Type: "answer", SDP: answer.SDP})
			log.Println("✓ Answer sent")

		case "ice-candidate":
			var msg SignalMessage
			json.Unmarshal(raw, &msg)
			if msg.Candidate != nil {
				pc.AddICECandidate(*msg.Candidate)
			}

		case "ping":
			conn.SetWriteDeadline(time.Now().Add(10 * time.Second))
			conn.WriteJSON(SignalMessage{Type: "pong"})

		case "frame_timestamp":
			var ts TimestampMessage
			json.Unmarshal(raw, &ts)

			// Add relay timestamp
			ts.RelayTimeMs = float64(time.Now().UnixNano()) / 1e6

			// Re-encode and broadcast
			enriched, _ := json.Marshal(ts)
			s.BroadcastTimestamp(string(enriched))

			// Log periodically
			count := atomic.LoadUint64(&s.timestampCount)
			if count%100 == 0 {
				s.receiversMu.RLock()
				n := len(s.receivers)
				s.receiversMu.RUnlock()
				log.Printf("📡 %d timestamps sent to %d receivers", count, n)
			}
		}
	}

	s.mu.Lock()
	s.senderConnected = false
	s.senderPC = nil
	s.videoTrack = nil
	s.mu.Unlock()

	log.Println("Sender disconnected")
}

// =============================================================================
// HTTP Handler (Browser Clients)
// =============================================================================

func (s *Server) handleOffer(w http.ResponseWriter, r *http.Request) {
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
	connected := s.senderConnected
	track := s.videoTrack
	s.mu.Unlock()

	if !connected || track == nil {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusServiceUnavailable)
		json.NewEncoder(w).Encode(map[string]string{"error": "Video not ready"})
		return
	}

	var req OfferRequest
	if json.NewDecoder(r.Body).Decode(&req) != nil {
		http.Error(w, "Invalid JSON", http.StatusBadRequest)
		return
	}

	config := webrtc.Configuration{
		ICEServers: []webrtc.ICEServer{
			{URLs: []string{"stun:stun.l.google.com:19302"}},
		},
	}

	pc, err := webrtc.NewPeerConnection(config)
	if err != nil {
		http.Error(w, "PeerConnection failed", http.StatusInternalServerError)
		return
	}

	id := fmt.Sprintf("browser-%d", time.Now().UnixNano())
	receiver := NewReceiverClient(id, pc)

	// Handle DataChannel from browser
	pc.OnDataChannel(func(dc *webrtc.DataChannel) {
		log.Printf("📡 DataChannel '%s' from %s", dc.Label(), id)

		if dc.Label() == "timestamps" {
			receiver.DataChannel = dc

			dc.OnOpen(func() {
				log.Printf("✓ DataChannel OPEN for %s", id)
			})

			dc.OnMessage(func(msg webrtc.DataChannelMessage) {
				var ts TimestampMessage
				if json.Unmarshal(msg.Data, &ts) != nil {
					return
				}

				if ts.Type == "ping" {
					pong := TimestampMessage{
						Type:       "pong",
						ClientTime: ts.ClientTime,
						ServerTime: float64(time.Now().UnixNano()) / 1e6,
					}
					data, _ := json.Marshal(pong)
					dc.SendText(string(data))
				}
			})
		}
	})

	s.receiversMu.Lock()
	s.receivers[id] = receiver
	s.receiversMu.Unlock()

	pc.OnConnectionStateChange(func(state webrtc.PeerConnectionState) {
		log.Printf("Browser %s: %s", id, state)

		if state == webrtc.PeerConnectionStateConnected {
			log.Printf("✓ BROWSER %s CONNECTED", id)

			// Request keyframe
			if s.senderPC != nil {
				for _, recv := range s.senderPC.GetReceivers() {
					if recv.Track() != nil && recv.Track().Kind() == webrtc.RTPCodecTypeVideo {
						s.senderPC.WriteRTCP([]rtcp.Packet{
							&rtcp.PictureLossIndication{MediaSSRC: uint32(recv.Track().SSRC())},
						})
						break
					}
				}
			}
		} else if state == webrtc.PeerConnectionStateFailed || state == webrtc.PeerConnectionStateClosed {
			s.receiversMu.Lock()
			if r, ok := s.receivers[id]; ok {
				r.Close()
				delete(s.receivers, id)
			}
			s.receiversMu.Unlock()
		}
	})

	// Add video track
	sender, _ := pc.AddTrack(track)
	go func() {
		buf := make([]byte, 1500)
		for {
			if _, _, err := sender.Read(buf); err != nil {
				return
			}
		}
	}()

	offer := webrtc.SessionDescription{Type: webrtc.SDPTypeOffer, SDP: req.SDP}
	pc.SetRemoteDescription(offer)

	answer, _ := pc.CreateAnswer(nil)

	done := webrtc.GatheringCompletePromise(pc)
	pc.SetLocalDescription(answer)

	select {
	case <-done:
	case <-time.After(3 * time.Second):
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]string{
		"sdp":  pc.LocalDescription().SDP,
		"type": "answer",
	})

	log.Printf("✓ Answer sent to %s", id)
}

func (s *Server) handleConfig(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Access-Control-Allow-Origin", "*")

	s.receiversMu.RLock()
	n := len(s.receivers)
	s.receiversMu.RUnlock()

	json.NewEncoder(w).Encode(map[string]interface{}{
		"sender_url":        "Python Sender",
		"status":            s.senderConnected,
		"num_receivers":     n,
		"codec":             "H264",
		"latency_supported": true,
	})
}

func main() {
	port := 8081
	server := NewServer()

	http.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/" {
			http.ServeFile(w, r, "./static/index.html")
			return
		}
		http.FileServer(http.Dir("./static")).ServeHTTP(w, r)
	})

	http.HandleFunc("/ws", server.handleWebSocket)
	http.HandleFunc("/offer", server.handleOffer)
	http.HandleFunc("/config", server.handleConfig)

	http.HandleFunc("/health", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		w.Write([]byte("OK"))
	})

	sep := strings.Repeat("=", 50)
	log.Println(sep)
	log.Println("WebRTC Relay - Stable Latency Measurement")
	log.Println(sep)
	log.Println("Optimizations:")
	log.Println("  ✓ Non-blocking timestamp broadcast")
	log.Println("  ✓ Buffered DataChannel sends")
	log.Println("  ✓ Minimal mutex contention")
	log.Println(sep)
	log.Printf("HTTP: http://localhost:%d", port)
	log.Printf("WS:   ws://localhost:%d/ws", port)
	log.Println(sep)

	if err := http.ListenAndServe(fmt.Sprintf(":%d", port), nil); err != nil {
		log.Fatal(err)
	}
}