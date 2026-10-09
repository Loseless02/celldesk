package app

import (
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"net/url"
	"os"
	"path/filepath"
	"strings"
)

const defaultPort = 47474

// Config is persisted as JSON in the user config directory.
type Config struct {
	Port          int    `json:"port"`
	SaveDir       string `json:"saveDir"`
	OpenOnReceive bool   `json:"openOnReceive"`

	// LANToken authorises phones on the local network.
	LANToken string `json:"lanToken"`

	// Relay settings. Room identifies this PC on the relay, PCKey proves the
	// PC owns the room, E2EKey encrypts photos end to end (the relay never
	// sees it: it travels to the phone only inside the QR code fragment).
	RelayURL string `json:"relayUrl"`
	Room     string `json:"room"`
	PCKey    string `json:"pcKey"`
	E2EKey   string `json:"e2eKey"`
}

func randomToken(n int) string {
	b := make([]byte, n)
	if _, err := rand.Read(b); err != nil {
		panic(err)
	}
	return base64.RawURLEncoding.EncodeToString(b)
}

func defaultSaveDir() string {
	home, err := os.UserHomeDir()
	if err != nil {
		return "CellDesk"
	}
	return filepath.Join(home, "Pictures", "CellDesk")
}

func loadConfig(path string) (Config, error) {
	var c Config
	data, err := os.ReadFile(path)
	if err != nil && !errors.Is(err, fs.ErrNotExist) {
		return c, err
	}
	if len(data) > 0 {
		if err := json.Unmarshal(data, &c); err != nil {
			return c, fmt.Errorf("config %s is corrupt: %w", path, err)
		}
	}
	if c.Port == 0 {
		c.Port = defaultPort
	}
	if c.SaveDir == "" {
		c.SaveDir = defaultSaveDir()
	}
	if c.LANToken == "" {
		c.LANToken = randomToken(18)
	}
	c.ensureRelaySecrets(false)
	return c, nil
}

// ensureRelaySecrets fills in missing relay identifiers, or replaces all of
// them when rotate is true (which unpairs every phone using the relay).
func (c *Config) ensureRelaySecrets(rotate bool) {
	if rotate || c.Room == "" {
		c.Room = randomToken(16)
	}
	if rotate || c.PCKey == "" {
		c.PCKey = randomToken(32)
	}
	if rotate || c.E2EKey == "" {
		c.E2EKey = randomToken(32)
	}
}

func saveConfig(path string, c Config) error {
	data, err := json.MarshalIndent(c, "", "  ")
	if err != nil {
		return err
	}
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, data, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}

// normalizeRelayURL accepts "my-relay.workers.dev" or a full URL and returns
// "https://my-relay.workers.dev" without a trailing slash. Empty disables.
func normalizeRelayURL(raw string) (string, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return "", nil
	}
	if !strings.Contains(raw, "://") {
		raw = "https://" + raw
	}
	u, err := url.Parse(raw)
	if err != nil || u.Host == "" {
		return "", fmt.Errorf("invalid relay URL %q", raw)
	}
	if u.Scheme != "https" && u.Scheme != "http" {
		return "", fmt.Errorf("relay URL must start with https://")
	}
	u.Path = strings.TrimRight(u.Path, "/")
	u.RawQuery, u.Fragment = "", ""
	return u.String(), nil
}
