package app

import (
	"crypto/subtle"
	"encoding/json"
	"fmt"
	"io"
	"mime"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/Loseless02/celldesk/dashboard"
	"github.com/Loseless02/celldesk/phone"
	"github.com/skip2/go-qrcode"
)

func (a *App) routes() http.Handler {
	mux := http.NewServeMux()

	// Phone web app (reachable from the LAN).
	mux.HandleFunc("GET /{$}", a.handleRoot)
	mux.Handle("GET /", noCache(http.FileServerFS(phone.FS)))
	mux.HandleFunc("GET /api/hello", a.handleHello)
	mux.HandleFunc("POST /api/upload", a.handleUpload)
	mux.HandleFunc("GET /api/outbox", a.handleOutboxList)
	mux.HandleFunc("GET /api/outbox/{id}", a.handleOutboxFile)

	// Dashboard (this computer only).
	mux.HandleFunc("GET /desk", a.admin(a.handleDesk))
	mux.HandleFunc("GET /api/admin/state", a.admin(a.handleState))
	mux.HandleFunc("GET /api/admin/qr.png", a.admin(a.handleQR))
	mux.HandleFunc("GET /api/admin/events", a.admin(a.handleEvents))
	mux.HandleFunc("GET /api/admin/file", a.admin(a.handleFile))
	mux.HandleFunc("POST /api/admin/settings", a.admin(a.handleSettings))
	mux.HandleFunc("POST /api/admin/reset", a.admin(a.handleReset))
	mux.HandleFunc("POST /api/admin/outbox", a.admin(a.handleOutboxAdd))
	mux.HandleFunc("POST /api/admin/outbox/remove", a.admin(a.handleOutboxRemove))
	mux.HandleFunc("POST /api/admin/open", a.admin(a.handleOpen))
	mux.HandleFunc("POST /api/admin/quit", a.admin(a.handleQuit))
	return mux
}

func noCache(h http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-cache")
		h.ServeHTTP(w, r)
	})
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

// isLocal reports whether the request comes from this computer and was
// addressed to a loopback name (the Host check defeats DNS rebinding).
func isLocal(r *http.Request) bool {
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return false
	}
	if ip := net.ParseIP(host); ip == nil || !ip.IsLoopback() {
		return false
	}
	h := r.Host
	if hh, _, err := net.SplitHostPort(h); err == nil {
		h = hh
	}
	h = strings.Trim(h, "[]")
	return h == "localhost" || h == "127.0.0.1" || h == "::1"
}

// admin guards dashboard endpoints. Writes also need a custom header, which
// browsers will not send cross-site without a CORS preflight we never allow.
func (a *App) admin(h http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !isLocal(r) {
			http.NotFound(w, r)
			return
		}
		if r.Method != http.MethodGet && r.Header.Get("X-CellDesk") != "1" {
			http.Error(w, "forbidden", http.StatusForbidden)
			return
		}
		h(w, r)
	}
}

func (a *App) tokenOK(t string) bool {
	want := a.config().LANToken
	return t != "" && subtle.ConstantTimeCompare([]byte(t), []byte(want)) == 1
}

func (a *App) handleRoot(w http.ResponseWriter, r *http.Request) {
	if isLocal(r) && r.URL.RawQuery == "" {
		http.Redirect(w, r, "/desk", http.StatusFound)
		return
	}
	w.Header().Set("Cache-Control", "no-cache")
	http.ServeFileFS(w, r, phone.FS, "index.html")
}

func (a *App) handleHello(w http.ResponseWriter, r *http.Request) {
	if !a.tokenOK(r.URL.Query().Get("t")) {
		writeJSON(w, http.StatusUnauthorized, map[string]any{"ok": false, "app": "celldesk", "error": "unpaired"})
		return
	}
	v, n := a.out.state()
	writeJSON(w, http.StatusOK, map[string]any{
		"ok": true, "app": "celldesk", "name": a.name, "version": a.version,
		"outbox": fmt.Sprintf("%d-%d", v, n),
	})
}

func (a *App) handleOutboxList(w http.ResponseWriter, r *http.Request) {
	if !a.tokenOK(r.URL.Query().Get("t")) {
		writeJSON(w, http.StatusUnauthorized, map[string]any{"ok": false, "error": "unpaired"})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "items": a.out.list()})
}

func (a *App) handleOutboxFile(w http.ResponseWriter, r *http.Request) {
	if !a.tokenOK(r.URL.Query().Get("t")) {
		writeJSON(w, http.StatusUnauthorized, map[string]any{"ok": false, "error": "unpaired"})
		return
	}
	f, item, err := a.out.open(r.PathValue("id"))
	if err != nil {
		writeJSON(w, http.StatusNotFound, map[string]any{"ok": false, "error": "not_found"})
		return
	}
	defer f.Close()
	disposition := "inline"
	if r.URL.Query().Get("dl") == "1" {
		disposition = "attachment"
	}
	w.Header().Set("Content-Type", item.Type)
	w.Header().Set("Content-Disposition", mime.FormatMediaType(disposition, map[string]string{"filename": item.Name}))
	w.Header().Set("X-File-SHA256", item.SHA256)
	w.Header().Set("Cache-Control", "no-store")
	http.ServeContent(w, r, "", item.Added, f)
}

func (a *App) handleOutboxAdd(w http.ResponseWriter, r *http.Request) {
	name, err := url.PathUnescape(r.Header.Get("X-File-Name"))
	if err != nil || name == "" {
		name = "file"
	}
	item, err := a.out.add(name, r.Header.Get("Content-Type"), r.Body)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"ok": false, "error": err.Error()})
		return
	}
	a.outboxChanged()
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "item": item})
}

func (a *App) handleOutboxRemove(w http.ResponseWriter, r *http.Request) {
	var req struct {
		ID  string `json:"id"`
		All bool   `json:"all"`
	}
	_ = json.NewDecoder(io.LimitReader(r.Body, 1<<12)).Decode(&req)
	if req.ID == "" && !req.All {
		writeJSON(w, http.StatusBadRequest, map[string]any{"ok": false, "error": "nothing to remove"})
		return
	}
	if err := a.out.remove(req.ID); err != nil && !req.All {
		writeJSON(w, http.StatusNotFound, map[string]any{"ok": false, "error": err.Error()})
		return
	}
	a.outboxChanged()
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

func (a *App) handleUpload(w http.ResponseWriter, r *http.Request) {
	if !a.tokenOK(r.Header.Get("X-CellDesk-Token")) {
		writeJSON(w, http.StatusUnauthorized, map[string]any{"ok": false, "error": "unpaired"})
		return
	}
	name, err := url.PathUnescape(r.Header.Get("X-File-Name"))
	if err != nil {
		name = "photo"
	}
	var modified time.Time
	if ms, err := strconv.ParseInt(r.Header.Get("X-File-Modified"), 10, 64); err == nil {
		modified = time.UnixMilli(ms)
	}
	want := strings.ToLower(r.Header.Get("X-File-SHA256"))

	in, err := a.beginFile(name, r.Header.Get("Content-Type"))
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"ok": false, "error": "cannot write: " + err.Error()})
		return
	}
	n, err := io.Copy(in, r.Body)
	if err != nil || (r.ContentLength >= 0 && n != r.ContentLength) {
		in.abort()
		writeJSON(w, http.StatusBadRequest, map[string]any{"ok": false, "error": "upload interrupted"})
		return
	}
	if want != "" && in.sum() != want {
		in.abort()
		writeJSON(w, http.StatusUnprocessableEntity, map[string]any{"ok": false, "error": "hash_mismatch"})
		return
	}
	rec, err := a.commit(in, modified, "Wi-Fi", want != "")
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"ok": false, "error": "save failed: " + err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "name": rec.Name, "size": rec.Size, "sha256": rec.SHA256, "verified": rec.Verified})
}

func (a *App) handleDesk(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("Cache-Control", "no-cache")
	_, _ = w.Write(dashboard.HTML)
}

func (a *App) lanPhoneURL() string {
	cfg := a.config()
	return fmt.Sprintf("http://%s/?t=%s", net.JoinHostPort(lanIP(), strconv.Itoa(cfg.Port)), cfg.LANToken)
}

// tailnetPhoneURL is the pairing link over Tailscale, "" when it is not running.
// It uses the same token as the Wi-Fi link: only the address differs.
func (a *App) tailnetPhoneURL() string {
	ip := tailscaleIP()
	if ip == "" {
		return ""
	}
	cfg := a.config()
	return fmt.Sprintf("http://%s/?t=%s", net.JoinHostPort(ip, strconv.Itoa(cfg.Port)), cfg.LANToken)
}

func (a *App) relayPhoneURL() string {
	cfg := a.config()
	if cfg.RelayURL == "" {
		return ""
	}
	return cfg.RelayURL + "/#r=" + cfg.Room + "&k=" + cfg.E2EKey + "&n=" + url.QueryEscape(a.name)
}

func (a *App) handleState(w http.ResponseWriter, r *http.Request) {
	cfg := a.config()
	a.mu.Lock()
	online, relayErr := a.relayOnline, a.relayErr
	a.mu.Unlock()
	writeJSON(w, http.StatusOK, map[string]any{
		"version":       a.version,
		"name":          a.name,
		"saveDir":       cfg.SaveDir,
		"openOnReceive": cfg.OpenOnReceive,
		"autostart":     autostartEnabled(),
		"lan":           map[string]any{"url": a.lanPhoneURL(), "ip": lanIP(), "port": cfg.Port},
		"tailnet":       map[string]any{"url": a.tailnetPhoneURL(), "ip": tailscaleIP()},
		"relay": map[string]any{
			"url":      cfg.RelayURL,
			"online":   online,
			"error":    relayErr,
			"phoneUrl": a.relayPhoneURL(),
		},
		"recent": a.recentFiles(),
		"outbox": a.out.list(),
	})
}

func (a *App) handleQR(w http.ResponseWriter, r *http.Request) {
	var content string
	switch r.URL.Query().Get("mode") {
	case "relay":
		content = a.relayPhoneURL()
	case "tailnet":
		content = a.tailnetPhoneURL()
	default:
		content = a.lanPhoneURL()
	}
	if content == "" {
		http.NotFound(w, r)
		return
	}
	png, err := qrcode.Encode(content, qrcode.Medium, 512)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "image/png")
	w.Header().Set("Cache-Control", "no-store")
	_, _ = w.Write(png)
}

func (a *App) handleEvents(w http.ResponseWriter, r *http.Request) {
	fl, ok := w.(http.Flusher)
	if !ok {
		http.Error(w, "streaming unsupported", http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-store")
	ch, unsubscribe := a.events.subscribe()
	defer unsubscribe()
	fmt.Fprint(w, ": hi\n\n")
	fl.Flush()
	heartbeat := time.NewTicker(20 * time.Second)
	defer heartbeat.Stop()
	for {
		select {
		case <-r.Context().Done():
			return
		case data := <-ch:
			fmt.Fprintf(w, "data: %s\n\n", data)
		case <-heartbeat.C:
			fmt.Fprint(w, ": ping\n\n")
		}
		fl.Flush()
	}
}

// savedPath resolves a bare file name inside the save folder.
func (a *App) savedPath(name string) (string, bool) {
	if name == "" || name != filepath.Base(name) || strings.HasPrefix(name, ".") || strings.ContainsAny(name, `/\`) {
		return "", false
	}
	return filepath.Join(a.config().SaveDir, name), true
}

func (a *App) handleFile(w http.ResponseWriter, r *http.Request) {
	p, ok := a.savedPath(r.URL.Query().Get("name"))
	if !ok {
		http.NotFound(w, r)
		return
	}
	http.ServeFile(w, r, p)
}

func (a *App) handleSettings(w http.ResponseWriter, r *http.Request) {
	var req struct {
		RelayURL      *string `json:"relayUrl"`
		OpenOnReceive *bool   `json:"openOnReceive"`
		Autostart     *bool   `json:"autostart"`
		SaveDir       *string `json:"saveDir"`
	}
	if err := json.NewDecoder(io.LimitReader(r.Body, 1<<16)).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"ok": false, "error": "bad request"})
		return
	}
	if req.Autostart != nil {
		if err := setAutostart(*req.Autostart); err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]any{"ok": false, "error": err.Error()})
			return
		}
	}
	relayChanged := false
	err := a.updateConfig(func(c *Config) error {
		if req.RelayURL != nil {
			u, err := normalizeRelayURL(*req.RelayURL)
			if err != nil {
				return err
			}
			relayChanged = u != c.RelayURL
			c.RelayURL = u
		}
		if req.OpenOnReceive != nil {
			c.OpenOnReceive = *req.OpenOnReceive
		}
		if req.SaveDir != nil {
			dir := strings.TrimSpace(*req.SaveDir)
			if !filepath.IsAbs(dir) {
				return fmt.Errorf("save folder must be an absolute path")
			}
			if err := os.MkdirAll(dir, 0o755); err != nil {
				return fmt.Errorf("cannot use that folder: %w", err)
			}
			c.SaveDir = dir
		}
		return nil
	})
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"ok": false, "error": err.Error()})
		return
	}
	if req.SaveDir != nil {
		a.loadRecent()
	}
	if relayChanged {
		a.restartRelay()
	}
	a.events.publish(map[string]any{"type": "config"})
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

func (a *App) handleReset(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Which string `json:"which"`
	}
	_ = json.NewDecoder(io.LimitReader(r.Body, 1<<12)).Decode(&req)
	err := a.updateConfig(func(c *Config) error {
		switch req.Which {
		case "lan":
			c.LANToken = randomToken(18)
		case "relay":
			c.ensureRelaySecrets(true)
		default:
			return fmt.Errorf("unknown pairing %q", req.Which)
		}
		return nil
	})
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"ok": false, "error": err.Error()})
		return
	}
	if req.Which == "relay" {
		a.restartRelay()
	}
	a.events.publish(map[string]any{"type": "config"})
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

func (a *App) handleOpen(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Name string `json:"name"`
	}
	_ = json.NewDecoder(io.LimitReader(r.Body, 1<<12)).Decode(&req)
	target := a.config().SaveDir
	if req.Name != "" {
		p, ok := a.savedPath(req.Name)
		if !ok {
			writeJSON(w, http.StatusNotFound, map[string]any{"ok": false})
			return
		}
		target = p
	}
	openTarget(target)
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

func (a *App) handleQuit(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
	go func() {
		time.Sleep(200 * time.Millisecond)
		a.Quit()
	}()
}
