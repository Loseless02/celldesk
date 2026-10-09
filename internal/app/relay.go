package app

import (
	"context"
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/coder/websocket"
)

// Relay wire format (see docs/PROTOCOL.md):
//
//	upload body = frame*
//	frame       = u32be(L) | flags(1) | iv(12) | ciphertext+tag(L-13)
//	AAD         = "CellDesk1" | u32be(index) | flags
//
// Frame 0 holds JSON metadata, frames 1..n hold the file; the last frame has
// flags&1 set. AES-256-GCM with the key from the QR code.
const (
	upMagic      = "CellDesk1" // phone to PC
	downMagic    = "CellDesk2" // PC to phone, so one direction can't be replayed as the other
	flagFinal    = 1
	maxFrameSize = 4 << 20
)

var errDecrypt = errors.New("decrypt_failed: phone is paired with an old key, scan the QR code again")

type fileMeta struct {
	Name     string `json:"name"`
	Size     int64  `json:"size"`
	Type     string `json:"type"`
	Modified int64  `json:"modified"`
	SHA256   string `json:"sha256"`
}

func newAEAD(b64key string) (cipher.AEAD, error) {
	key, err := base64.RawURLEncoding.DecodeString(b64key)
	if err != nil || len(key) != 32 {
		return nil, errors.New("invalid end-to-end key")
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, err
	}
	return cipher.NewGCM(block)
}

func frameAAD(magic string, index uint32, flags byte) []byte {
	aad := make([]byte, len(magic)+5)
	copy(aad, magic)
	binary.BigEndian.PutUint32(aad[len(magic):], index)
	aad[len(aad)-1] = flags
	return aad
}

// relayTransfer decodes one upload streamed from the relay.
type relayTransfer struct {
	app   *App
	aead  cipher.AEAD
	magic string // frame magic; upMagic when empty
	buf   []byte
	idx   uint32
	meta  fileMeta
	in    *incoming
	done  bool
	err   error
}

func (t *relayTransfer) feed(p []byte) {
	if t.err != nil {
		return
	}
	t.buf = append(t.buf, p...)
	off := 0
	for {
		rest := t.buf[off:]
		if len(rest) < 4 {
			break
		}
		l := int(binary.BigEndian.Uint32(rest))
		if l < 1+12+16 || l > maxFrameSize {
			t.fail(errors.New("malformed upload"))
			return
		}
		if len(rest) < 4+l {
			break
		}
		if err := t.frame(rest[4 : 4+l]); err != nil {
			t.fail(err)
			return
		}
		off += 4 + l
	}
	if off > 0 {
		t.buf = append(t.buf[:0], t.buf[off:]...)
	}
}

func (t *relayTransfer) frame(f []byte) error {
	if t.done {
		return errors.New("data after final frame")
	}
	flags, iv, ct := f[0], f[1:13], f[13:]
	magic := t.magic
	if magic == "" {
		magic = upMagic
	}
	plain, err := t.aead.Open(nil, iv, ct, frameAAD(magic, t.idx, flags))
	if err != nil {
		return errDecrypt
	}
	idx := t.idx
	t.idx++
	if idx == 0 {
		if flags&flagFinal != 0 {
			return errors.New("missing file data")
		}
		if err := json.Unmarshal(plain, &t.meta); err != nil || t.meta.Size < 0 {
			return errors.New("bad metadata")
		}
		t.in, err = t.app.beginFile(t.meta.Name, t.meta.Type)
		return err
	}
	if _, err := t.in.Write(plain); err != nil {
		return err
	}
	if flags&flagFinal != 0 {
		t.done = true
	}
	return nil
}

func (t *relayTransfer) fail(err error) {
	t.err = err
	t.buf = nil
	t.abort()
}

func (t *relayTransfer) abort() {
	if t.in != nil {
		t.in.abort()
		t.in = nil
	}
}

// finish validates and saves the file, returning the ack for the phone.
func (t *relayTransfer) finish() map[string]any {
	if t.err == nil && !t.done {
		t.fail(errors.New("upload incomplete"))
	}
	if t.err == nil && t.in.n != t.meta.Size {
		t.fail(fmt.Errorf("size mismatch: got %d of %d bytes", t.in.n, t.meta.Size))
	}
	want := strings.ToLower(t.meta.SHA256)
	if t.err == nil && want != "" && t.in.sum() != want {
		t.fail(errors.New("hash_mismatch"))
	}
	if t.err != nil {
		return map[string]any{"ok": false, "error": t.err.Error()}
	}
	in := t.in
	t.in = nil
	rec, err := t.app.commit(in, time.UnixMilli(t.meta.Modified), "Anywhere", want != "")
	if err != nil {
		return map[string]any{"ok": false, "error": "save failed: " + err.Error()}
	}
	return map[string]any{"ok": true, "name": rec.Name, "size": rec.Size, "sha256": rec.SHA256, "verified": rec.Verified}
}

// restartRelay (re)connects to the relay using the current config.
func (a *App) restartRelay() {
	a.mu.Lock()
	if a.relayCancel != nil {
		a.relayCancel()
		a.relayCancel = nil
	}
	cfg := a.cfg
	var ctx context.Context
	if cfg.RelayURL != "" {
		ctx, a.relayCancel = context.WithCancel(context.Background())
	}
	a.mu.Unlock()

	a.setRelayStatus(false, "")
	if ctx != nil {
		go a.relayLoop(ctx, cfg)
	}
}

func (a *App) setRelayStatus(online bool, errMsg string) {
	a.mu.Lock()
	changed := a.relayOnline != online || a.relayErr != errMsg
	a.relayOnline, a.relayErr = online, errMsg
	a.mu.Unlock()
	if changed {
		a.events.publish(map[string]any{"type": "relay", "online": online, "error": errMsg})
	}
}

func (a *App) relayLoop(ctx context.Context, cfg Config) {
	backoff := time.Second
	for {
		start := time.Now()
		err := a.relayOnce(ctx, cfg)
		if ctx.Err() != nil {
			return
		}
		msg := "disconnected"
		if err != nil {
			msg = err.Error()
		}
		a.setRelayStatus(false, msg)
		if time.Since(start) > time.Minute {
			backoff = time.Second
		}
		log.Printf("relay: %s (retrying in %s)", msg, backoff)
		select {
		case <-ctx.Done():
			return
		case <-time.After(backoff):
		}
		backoff = min(backoff*2, time.Minute)
	}
}

func relayWSURL(relayURL, room, name string) string {
	u := strings.Replace(relayURL, "https://", "wss://", 1)
	u = strings.Replace(u, "http://", "ws://", 1)
	return u + "/pc/" + room + "?name=" + url.QueryEscape(name)
}

func (a *App) relayOnce(ctx context.Context, cfg Config) error {
	aead, err := newAEAD(cfg.E2EKey)
	if err != nil {
		return err
	}
	dctx, cancel := context.WithTimeout(ctx, 20*time.Second)
	c, resp, err := websocket.Dial(dctx, relayWSURL(cfg.RelayURL, cfg.Room, a.name), &websocket.DialOptions{
		HTTPHeader: http.Header{"Authorization": {"Bearer " + cfg.PCKey}},
	})
	cancel()
	if err != nil {
		if resp != nil && resp.StatusCode == http.StatusForbidden {
			return errors.New("relay rejected this PC's key; reset the Anywhere pairing")
		}
		return fmt.Errorf("cannot reach relay: %w", err)
	}
	defer c.CloseNow()
	c.SetReadLimit(16 << 20)
	a.setRelayStatus(true, "")
	log.Printf("relay: connected to %s", cfg.RelayURL)

	// Tell the relay the outbox version now and whenever it changes, so phones
	// see "new files from PC" from the cheap status endpoint.
	announce := func() {
		v, n := a.out.state()
		msg, _ := json.Marshal(map[string]any{"t": "outbox", "v": fmt.Sprintf("%d-%d", v, n)})
		wctx, cancel := context.WithTimeout(ctx, 10*time.Second)
		defer cancel()
		_ = c.Write(wctx, websocket.MessageText, msg)
	}
	announceCtx, stopAnnounce := context.WithCancel(ctx)
	defer stopAnnounce()
	go func() {
		announce()
		for {
			select {
			case <-announceCtx.Done():
				return
			case <-a.outboxCh:
				announce()
			}
		}
	}()

	// Downloads stream in their own goroutine (one at a time, as the relay
	// expects) so uploads keep flowing meanwhile.
	var dlMu sync.Mutex

	// The relay answers "ping" with "pong" without waking up, so silence for
	// longer than a few ping intervals means the connection is dead.
	var lastRead atomic.Int64
	lastRead.Store(time.Now().UnixNano())
	pingCtx, stopPing := context.WithCancel(ctx)
	defer stopPing()
	go func() {
		t := time.NewTicker(25 * time.Second)
		defer t.Stop()
		for {
			select {
			case <-pingCtx.Done():
				return
			case <-t.C:
			}
			if time.Since(time.Unix(0, lastRead.Load())) > 80*time.Second {
				c.CloseNow()
				return
			}
			wctx, cancel := context.WithTimeout(pingCtx, 10*time.Second)
			err := c.Write(wctx, websocket.MessageText, []byte("ping"))
			cancel()
			if err != nil {
				c.CloseNow()
				return
			}
		}
	}()

	var cur *relayTransfer
	defer func() {
		if cur != nil {
			cur.abort()
		}
	}()
	for {
		typ, data, err := c.Read(ctx)
		if err != nil {
			return err
		}
		lastRead.Store(time.Now().UnixNano())
		if typ == websocket.MessageBinary {
			if cur != nil {
				cur.feed(data)
			}
			continue
		}
		if string(data) == "pong" {
			continue
		}
		var m struct {
			T    string `json:"t"`
			ID   string `json:"id"`
			File string `json:"file"`
		}
		if json.Unmarshal(data, &m) != nil {
			continue
		}
		switch m.T {
		case "begin":
			if cur != nil {
				cur.abort()
			}
			cur = &relayTransfer{app: a, aead: aead}
		case "end":
			if cur == nil {
				continue
			}
			ack := cur.finish()
			cur = nil
			ack["t"], ack["id"] = "ack", m.ID
			out, _ := json.Marshal(ack)
			wctx, cancel := context.WithTimeout(ctx, 10*time.Second)
			err := c.Write(wctx, websocket.MessageText, out)
			cancel()
			if err != nil {
				return err
			}
		case "abort":
			if cur != nil {
				cur.abort()
				cur = nil
			}
		case "list", "get":
			go func(t, id, file string) {
				dlMu.Lock()
				defer dlMu.Unlock()
				a.relayRespond(ctx, c, aead, t, id, file)
			}(m.T, m.ID, m.File)
		}
	}
}

// relayRespond answers a phone's outbox request through the relay:
// {"t":"rbegin"}, encrypted frames as binary messages, {"t":"rend"}.
func (a *App) relayRespond(ctx context.Context, c *websocket.Conn, aead cipher.AEAD, kind, id, file string) {
	send := func(v map[string]any) error {
		v["id"] = id
		b, _ := json.Marshal(v)
		wctx, cancel := context.WithTimeout(ctx, 10*time.Second)
		defer cancel()
		return c.Write(wctx, websocket.MessageText, b)
	}
	var meta any
	var body io.Reader = strings.NewReader("")
	if kind == "list" {
		meta = map[string]any{"items": a.out.list()}
	} else {
		f, item, err := a.out.open(file)
		if err != nil {
			_ = send(map[string]any{"t": "rbegin", "ok": false, "error": "not_found"})
			return
		}
		defer f.Close()
		meta, body = item, f
	}
	if send(map[string]any{"t": "rbegin", "ok": true}) != nil {
		return
	}
	err := encryptFrames(aead, downMagic, meta, body, func(msg []byte) error {
		wctx, cancel := context.WithTimeout(ctx, time.Minute)
		defer cancel()
		return c.Write(wctx, websocket.MessageBinary, msg)
	})
	if err != nil {
		log.Printf("relay: sending %s failed: %v", kind, err)
	}
	_ = send(map[string]any{"t": "rend", "ok": err == nil})
}

// encryptFrames writes meta and the contents of r in the relay frame format,
// handing emit messages of at most relayChunk bytes.
func encryptFrames(aead cipher.AEAD, magic string, meta any, r io.Reader, emit func([]byte) error) error {
	const chunk = 1 << 20
	const relayChunk = 256 << 10
	var idx uint32
	frame := func(plain []byte, final bool) error {
		var flags byte
		if final {
			flags = flagFinal
		}
		iv := make([]byte, 12)
		if _, err := rand.Read(iv); err != nil {
			return err
		}
		ct := aead.Seal(nil, iv, plain, frameAAD(magic, idx, flags))
		idx++
		out := make([]byte, 4+1+12, 4+1+12+len(ct))
		binary.BigEndian.PutUint32(out, uint32(1+12+len(ct)))
		out[4] = flags
		copy(out[5:], iv)
		out = append(out, ct...)
		for o := 0; o < len(out); o += relayChunk {
			if err := emit(out[o:min(o+relayChunk, len(out))]); err != nil {
				return err
			}
		}
		return nil
	}
	m, err := json.Marshal(meta)
	if err != nil {
		return err
	}
	if err := frame(m, false); err != nil {
		return err
	}
	// Read one chunk ahead so the last data frame can be flagged final.
	cur := make([]byte, chunk)
	n, err := io.ReadFull(r, cur)
	if err != nil && err != io.EOF && err != io.ErrUnexpectedEOF {
		return err
	}
	cur = cur[:n]
	for {
		next := make([]byte, chunk)
		nn, err := io.ReadFull(r, next)
		if err != nil && err != io.EOF && err != io.ErrUnexpectedEOF {
			return err
		}
		if nn == 0 {
			return frame(cur, true)
		}
		if err := frame(cur, false); err != nil {
			return err
		}
		cur = next[:nn]
	}
}
