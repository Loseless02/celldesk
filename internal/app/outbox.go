package app

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"mime"
	"os"
	"path/filepath"
	"regexp"
	"sync"
	"time"
)

// OutItem is a file the PC offers to its paired phones.
type OutItem struct {
	ID     string    `json:"id"`
	Name   string    `json:"name"`
	Size   int64     `json:"size"`
	Type   string    `json:"type"`
	SHA256 string    `json:"sha256"`
	Added  time.Time `json:"added"`
}

var outIDPattern = regexp.MustCompile(`^[0-9a-f]{16}$`)

// outbox stores files waiting to be picked up by phones. Files live in
// <config>/outbox/<id> with their details in index.json.
type outbox struct {
	dir     string
	mu      sync.Mutex
	items   []OutItem
	version int64
}

func openOutbox(dir string) (*outbox, error) {
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, err
	}
	o := &outbox{dir: dir, version: time.Now().UnixMilli()}
	if data, err := os.ReadFile(filepath.Join(dir, "index.json")); err == nil {
		var items []OutItem
		if json.Unmarshal(data, &items) == nil {
			for _, it := range items {
				if _, err := os.Stat(filepath.Join(dir, it.ID)); err == nil && outIDPattern.MatchString(it.ID) {
					o.items = append(o.items, it)
				}
			}
		}
	}
	return o, nil
}

// saveIndex must be called with o.mu held.
func (o *outbox) saveIndex() error {
	o.version++
	data, err := json.MarshalIndent(o.items, "", "  ")
	if err != nil {
		return err
	}
	tmp := filepath.Join(o.dir, "index.json.tmp")
	if err := os.WriteFile(tmp, data, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, filepath.Join(o.dir, "index.json"))
}

func (o *outbox) list() []OutItem {
	o.mu.Lock()
	defer o.mu.Unlock()
	return append([]OutItem{}, o.items...)
}

func (o *outbox) state() (version int64, count int) {
	o.mu.Lock()
	defer o.mu.Unlock()
	return o.version, len(o.items)
}

func (o *outbox) add(name, mimeType string, r io.Reader) (OutItem, error) {
	idb := make([]byte, 8)
	if _, err := rand.Read(idb); err != nil {
		return OutItem{}, err
	}
	id := hex.EncodeToString(idb)
	tmp, err := os.CreateTemp(o.dir, ".part-*")
	if err != nil {
		return OutItem{}, err
	}
	h := sha256.New()
	n, err := io.Copy(io.MultiWriter(tmp, h), r)
	if cerr := tmp.Close(); err == nil {
		err = cerr
	}
	if err != nil {
		os.Remove(tmp.Name())
		return OutItem{}, err
	}
	if err := os.Rename(tmp.Name(), filepath.Join(o.dir, id)); err != nil {
		os.Remove(tmp.Name())
		return OutItem{}, err
	}
	name = sanitizeName(name)
	if mimeType == "" || mimeType == "application/octet-stream" {
		if t := mime.TypeByExtension(filepath.Ext(name)); t != "" {
			mimeType = t
		}
	}
	if mimeType == "" {
		mimeType = "application/octet-stream"
	}
	it := OutItem{ID: id, Name: name, Size: n, Type: mimeType, SHA256: hex.EncodeToString(h.Sum(nil)), Added: time.Now()}
	o.mu.Lock()
	defer o.mu.Unlock()
	o.items = append([]OutItem{it}, o.items...)
	return it, o.saveIndex()
}

// remove deletes one item, or every item when id is "".
func (o *outbox) remove(id string) error {
	o.mu.Lock()
	defer o.mu.Unlock()
	kept := o.items[:0]
	found := false
	for _, it := range o.items {
		if id == "" || it.ID == id {
			os.Remove(filepath.Join(o.dir, it.ID))
			found = true
			continue
		}
		kept = append(kept, it)
	}
	o.items = kept
	if !found {
		return errors.New("not found")
	}
	return o.saveIndex()
}

func (o *outbox) open(id string) (*os.File, OutItem, error) {
	if !outIDPattern.MatchString(id) {
		return nil, OutItem{}, os.ErrNotExist
	}
	o.mu.Lock()
	var item OutItem
	found := false
	for _, it := range o.items {
		if it.ID == id {
			item, found = it, true
			break
		}
	}
	o.mu.Unlock()
	if !found {
		return nil, OutItem{}, os.ErrNotExist
	}
	f, err := os.Open(filepath.Join(o.dir, id))
	return f, item, err
}

// outboxChanged tells dashboards and the relay that the outbox changed.
func (a *App) outboxChanged() {
	a.events.publish(map[string]any{"type": "outbox"})
	select {
	case a.outboxCh <- struct{}{}:
	default:
	}
}
