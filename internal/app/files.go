package app

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"hash"
	"log"
	"mime"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"
	"unicode"
)

// Received describes a saved file.
type Received struct {
	Name     string    `json:"name"`
	Size     int64     `json:"size"`
	Via      string    `json:"via,omitempty"`
	SHA256   string    `json:"sha256,omitempty"`
	Verified bool      `json:"verified"`
	Time     time.Time `json:"time"`
}

const maxRecent = 60

// incoming is a file being written. Bytes go to a hidden temp file in the
// save folder and are hashed on the way, so nothing is ever re-encoded.
type incoming struct {
	f    *os.File
	h    hash.Hash
	n    int64
	name string
	mime string
}

func (a *App) beginFile(name, mimeType string) (*incoming, error) {
	dir := a.config().SaveDir
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return nil, err
	}
	f, err := os.CreateTemp(dir, ".celldesk-*.part")
	if err != nil {
		return nil, err
	}
	return &incoming{f: f, h: sha256.New(), name: name, mime: mimeType}, nil
}

func (in *incoming) Write(p []byte) (int, error) {
	n, err := in.f.Write(p)
	in.h.Write(p[:n])
	in.n += int64(n)
	return n, err
}

func (in *incoming) sum() string { return hex.EncodeToString(in.h.Sum(nil)) }

func (in *incoming) abort() {
	in.f.Close()
	os.Remove(in.f.Name())
}

// commit moves a finished upload to its final name and announces it.
func (a *App) commit(in *incoming, modified time.Time, via string, verified bool) (Received, error) {
	if err := in.f.Sync(); err != nil {
		in.abort()
		return Received{}, err
	}
	if err := in.f.Close(); err != nil {
		os.Remove(in.f.Name())
		return Received{}, err
	}
	now := time.Now()
	dir := filepath.Dir(in.f.Name())
	base := finalName(in.name, in.mime, now)

	a.saveMu.Lock()
	target := uniquePath(dir, base)
	err := os.Rename(in.f.Name(), target)
	a.saveMu.Unlock()
	if err != nil {
		os.Remove(in.f.Name())
		return Received{}, err
	}
	if !modified.IsZero() && modified.Year() > 1990 && modified.Before(now.Add(24*time.Hour)) {
		_ = os.Chtimes(target, modified, modified)
	}

	rec := Received{
		Name:     filepath.Base(target),
		Size:     in.n,
		Via:      via,
		SHA256:   in.sum(),
		Verified: verified,
		Time:     now,
	}
	a.recentMu.Lock()
	a.recent = append([]Received{rec}, a.recent...)
	if len(a.recent) > maxRecent {
		a.recent = a.recent[:maxRecent]
	}
	a.recentMu.Unlock()
	a.events.publish(map[string]any{"type": "file", "file": rec})
	log.Printf("received %s (%d bytes via %s, verified=%v)", rec.Name, rec.Size, via, verified)

	if a.config().OpenOnReceive {
		openTarget(target)
	}
	return rec, nil
}

// finalName builds "20261009-140322_IMG_1234.jpg" from the phone's name.
func finalName(name, mimeType string, t time.Time) string {
	name = sanitizeName(name)
	ext := filepath.Ext(name)
	if ext == "" {
		ext = extForMime(mimeType)
		name += ext
	}
	return t.Format("20060102-150405") + "_" + name
}

func sanitizeName(name string) string {
	name = strings.ReplaceAll(name, "\\", "/")
	name = filepath.Base(strings.TrimRight(name, "/"))
	var b strings.Builder
	for _, r := range name {
		switch {
		case unicode.IsControl(r), strings.ContainsRune(`<>:"/\|?*`, r):
			b.WriteRune('_')
		default:
			b.WriteRune(r)
		}
	}
	name = strings.Trim(b.String(), ". ")
	if r := []rune(name); len(r) > 120 {
		ext := filepath.Ext(name)
		if len([]rune(ext)) > 10 {
			ext = ""
		}
		name = string(r[:120-len([]rune(ext))]) + ext
	}
	if name == "" || name == "_" {
		name = "photo"
	}
	return name
}

func extForMime(m string) string {
	switch strings.ToLower(strings.TrimSpace(strings.Split(m, ";")[0])) {
	case "image/jpeg":
		return ".jpg"
	case "image/heic":
		return ".heic"
	case "image/heif":
		return ".heif"
	case "image/png":
		return ".png"
	case "video/quicktime":
		return ".mov"
	case "video/mp4":
		return ".mp4"
	case "", "application/octet-stream":
		return ""
	}
	if exts, _ := mime.ExtensionsByType(m); len(exts) > 0 {
		return exts[0]
	}
	return ""
}

func uniquePath(dir, base string) string {
	ext := filepath.Ext(base)
	stem := strings.TrimSuffix(base, ext)
	p := filepath.Join(dir, base)
	for i := 2; ; i++ {
		if _, err := os.Lstat(p); errors.Is(err, os.ErrNotExist) {
			return p
		}
		p = filepath.Join(dir, fmt.Sprintf("%s (%d)%s", stem, i, ext))
	}
}

// loadRecent lists the newest files already in the save folder.
func (a *App) loadRecent() {
	dir := a.config().SaveDir
	entries, err := os.ReadDir(dir)
	if err != nil {
		return
	}
	var list []Received
	for _, e := range entries {
		if e.IsDir() || strings.HasPrefix(e.Name(), ".") {
			continue
		}
		info, err := e.Info()
		if err != nil {
			continue
		}
		list = append(list, Received{Name: e.Name(), Size: info.Size(), Time: info.ModTime()})
	}
	sort.Slice(list, func(i, j int) bool { return list[i].Time.After(list[j].Time) })
	if len(list) > maxRecent {
		list = list[:maxRecent]
	}
	a.recentMu.Lock()
	a.recent = list
	a.recentMu.Unlock()
}

func (a *App) recentFiles() []Received {
	a.recentMu.Lock()
	defer a.recentMu.Unlock()
	return append([]Received{}, a.recent...) // never nil: the dashboard expects an array
}
