// Package app implements the CellDesk desktop receiver.
package app

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"sync"
	"syscall"
	"time"
)

// Options come from the command line.
type Options struct {
	Version   string
	NoBrowser bool
	RelayURL  string
	Port      int
	// ConfigDir overrides the config location (used by tests).
	ConfigDir string
}

// App is the running receiver.
type App struct {
	version string
	cfgPath string
	name    string // computer name shown on the phone

	mu          sync.Mutex
	cfg         Config
	relayCancel context.CancelFunc
	relayOnline bool
	relayErr    string

	saveMu   sync.Mutex // serialises picking unique file names
	recentMu sync.Mutex
	recent   []Received

	events *broker
	quit   chan struct{}
	once   sync.Once
}

// Run starts CellDesk and blocks until it is told to quit.
func Run(opts Options) error {
	dir := opts.ConfigDir
	if dir == "" {
		base, err := os.UserConfigDir()
		if err != nil {
			return err
		}
		dir = filepath.Join(base, "CellDesk")
	}
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	setupLog(filepath.Join(dir, "celldesk.log"))

	a, err := newApp(opts, filepath.Join(dir, "config.json"))
	if err != nil {
		return err
	}
	cfg := a.config()

	ln, err := net.Listen("tcp", fmt.Sprintf(":%d", cfg.Port))
	if err != nil {
		// Most likely CellDesk is already running: show its dashboard instead.
		if alreadyRunning(cfg.Port) {
			if !opts.NoBrowser {
				openTarget(a.dashboardURL())
			}
			return nil
		}
		return fmt.Errorf("cannot listen on port %d: %w", cfg.Port, err)
	}

	a.loadRecent()
	a.restartRelay()

	srv := &http.Server{Handler: a.routes(), ReadHeaderTimeout: 15 * time.Second}
	go func() {
		if err := srv.Serve(ln); err != nil && !errors.Is(err, http.ErrServerClosed) {
			log.Printf("server: %v", err)
			a.Quit()
		}
	}()

	log.Printf("CellDesk %s listening on :%d, saving to %s", a.version, cfg.Port, cfg.SaveDir)
	log.Printf("dashboard: %s", a.dashboardURL())
	log.Printf("phone (same Wi-Fi): %s", a.lanPhoneURL())
	if !opts.NoBrowser {
		openTarget(a.dashboardURL())
	}

	sig := make(chan os.Signal, 1)
	signal.Notify(sig, os.Interrupt, syscall.SIGTERM)
	select {
	case <-sig:
	case <-a.quit:
	}
	log.Printf("shutting down")
	a.mu.Lock()
	if a.relayCancel != nil {
		a.relayCancel()
	}
	a.mu.Unlock()
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	return srv.Shutdown(ctx)
}

func newApp(opts Options, cfgPath string) (*App, error) {
	cfg, err := loadConfig(cfgPath)
	if err != nil {
		return nil, err
	}
	if opts.Port != 0 {
		cfg.Port = opts.Port
	}
	if opts.RelayURL != "" {
		u, err := normalizeRelayURL(opts.RelayURL)
		if err != nil {
			return nil, err
		}
		cfg.RelayURL = u
	}
	if err := saveConfig(cfgPath, cfg); err != nil {
		return nil, err
	}
	if err := os.MkdirAll(cfg.SaveDir, 0o755); err != nil {
		return nil, fmt.Errorf("cannot create save folder: %w", err)
	}
	name, _ := os.Hostname()
	if name == "" {
		name = "My PC"
	}
	version := opts.Version
	if version == "" {
		version = "dev"
	}
	return &App{
		version: version,
		cfgPath: cfgPath,
		name:    name,
		cfg:     cfg,
		events:  newBroker(),
		quit:    make(chan struct{}),
	}, nil
}

func setupLog(path string) {
	if st, err := os.Stat(path); err == nil && st.Size() > 5<<20 {
		_ = os.Remove(path)
	}
	f, err := os.OpenFile(path, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o600)
	if err != nil {
		return
	}
	// The file goes first: in a windowsgui build stderr is invalid and
	// MultiWriter stops at the first failing writer.
	log.SetOutput(io.MultiWriter(f, os.Stderr))
}

// Quit stops the app (idempotent).
func (a *App) Quit() { a.once.Do(func() { close(a.quit) }) }

func (a *App) config() Config {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.cfg
}

// updateConfig applies fn to the config and persists it.
func (a *App) updateConfig(fn func(*Config) error) error {
	a.mu.Lock()
	defer a.mu.Unlock()
	next := a.cfg
	if err := fn(&next); err != nil {
		return err
	}
	if err := saveConfig(a.cfgPath, next); err != nil {
		return err
	}
	a.cfg = next
	return nil
}

func (a *App) dashboardURL() string {
	return fmt.Sprintf("http://localhost:%d/desk", a.config().Port)
}

func alreadyRunning(port int) bool {
	c := http.Client{Timeout: 2 * time.Second}
	resp, err := c.Get(fmt.Sprintf("http://127.0.0.1:%d/api/hello", port))
	if err != nil {
		return false
	}
	defer resp.Body.Close()
	var body struct{ App string }
	_ = json.NewDecoder(io.LimitReader(resp.Body, 4096)).Decode(&body)
	return body.App == "celldesk"
}

// broker fans server-sent events out to dashboard tabs.
type broker struct {
	mu   sync.Mutex
	subs map[chan []byte]struct{}
}

func newBroker() *broker { return &broker{subs: map[chan []byte]struct{}{}} }

func (b *broker) publish(v any) {
	data, err := json.Marshal(v)
	if err != nil {
		return
	}
	b.mu.Lock()
	defer b.mu.Unlock()
	for ch := range b.subs {
		select {
		case ch <- data:
		default: // slow subscriber: drop rather than block
		}
	}
}

func (b *broker) subscribe() (chan []byte, func()) {
	ch := make(chan []byte, 32)
	b.mu.Lock()
	b.subs[ch] = struct{}{}
	b.mu.Unlock()
	return ch, func() {
		b.mu.Lock()
		delete(b.subs, ch)
		b.mu.Unlock()
	}
}
