package app

import (
	"bytes"
	"crypto/rand"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func testApp(t *testing.T) *App {
	t.Helper()
	dir := t.TempDir()
	cfgPath := filepath.Join(dir, "config.json")
	if err := saveConfig(cfgPath, Config{SaveDir: filepath.Join(dir, "photos")}); err != nil {
		t.Fatal(err)
	}
	a, err := newApp(Options{Version: "test"}, cfgPath)
	if err != nil {
		t.Fatal(err)
	}
	return a
}

func randomBytes(t *testing.T, n int) []byte {
	b := make([]byte, n)
	if _, err := rand.Read(b); err != nil {
		t.Fatal(err)
	}
	return b
}

func sum(b []byte) string {
	h := sha256.Sum256(b)
	return hex.EncodeToString(h[:])
}

// encryptUpload mirrors phone/app.js so the formats stay in lock-step.
func encryptUpload(t *testing.T, key string, data []byte, meta fileMeta) []byte {
	t.Helper()
	aead, err := newAEAD(key)
	if err != nil {
		t.Fatal(err)
	}
	var out bytes.Buffer
	var idx uint32
	frame := func(plain []byte, final bool) {
		var flags byte
		if final {
			flags = flagFinal
		}
		iv := randomBytes(t, 12)
		ct := aead.Seal(nil, iv, plain, frameAAD(idx, flags))
		binary.Write(&out, binary.BigEndian, uint32(1+12+len(ct)))
		out.WriteByte(flags)
		out.Write(iv)
		out.Write(ct)
		idx++
	}
	m, _ := json.Marshal(meta)
	frame(m, false)
	if len(data) == 0 {
		frame(nil, true)
	}
	const chunk = 1 << 20
	for o := 0; o < len(data); o += chunk {
		end := min(o+chunk, len(data))
		frame(data[o:end], end == len(data))
	}
	return out.Bytes()
}

func runTransfer(t *testing.T, a *App, body []byte, pieceSize int) map[string]any {
	t.Helper()
	aead, err := newAEAD(a.config().E2EKey)
	if err != nil {
		t.Fatal(err)
	}
	tr := &relayTransfer{app: a, aead: aead}
	for o := 0; o < len(body); o += pieceSize {
		tr.feed(body[o:min(o+pieceSize, len(body))])
	}
	return tr.finish()
}

func TestRelayTransferRoundTrip(t *testing.T) {
	a := testApp(t)
	for _, size := range []int{0, 1, 1 << 20, 3<<20 + 12345} {
		data := randomBytes(t, size)
		body := encryptUpload(t, a.config().E2EKey, data, fileMeta{
			Name: "IMG_0001.JPG", Size: int64(size), Type: "image/jpeg", Modified: time.Now().UnixMilli(), SHA256: sum(data),
		})
		ack := runTransfer(t, a, body, 256*1024+7) // odd piece size crosses frame boundaries
		if ack["ok"] != true {
			t.Fatalf("size %d: ack %v", size, ack)
		}
		got, err := os.ReadFile(filepath.Join(a.config().SaveDir, ack["name"].(string)))
		if err != nil {
			t.Fatal(err)
		}
		if !bytes.Equal(got, data) {
			t.Fatalf("size %d: saved bytes differ", size)
		}
		if ack["verified"] != true {
			t.Fatalf("size %d: not verified", size)
		}
	}
}

func TestRelayTransferRejectsTampering(t *testing.T) {
	a := testApp(t)
	data := randomBytes(t, 2<<20)
	meta := fileMeta{Name: "x.jpg", Size: int64(len(data)), SHA256: sum(data)}

	wrongKey := encryptUpload(t, randomToken(32), data, meta)
	if ack := runTransfer(t, a, wrongKey, 64*1024); ack["ok"] != false || !strings.Contains(ack["error"].(string), "decrypt") {
		t.Fatalf("wrong key accepted: %v", ack)
	}

	body := encryptUpload(t, a.config().E2EKey, data, meta)
	body[len(body)/2] ^= 1
	if ack := runTransfer(t, a, body, 64*1024); ack["ok"] != false {
		t.Fatalf("flipped bit accepted: %v", ack)
	}

	// Drop the final frame: must be reported as incomplete, not saved.
	full := encryptUpload(t, a.config().E2EKey, data, meta)
	cut := full[:len(full)-(4+1+12+16+(len(data)-(1<<20)))]
	if ack := runTransfer(t, a, cut, 64*1024); ack["ok"] != false {
		t.Fatalf("truncated upload accepted: %v", ack)
	}

	entries, _ := os.ReadDir(a.config().SaveDir)
	if len(entries) != 0 {
		t.Fatalf("rejected uploads left %d files behind", len(entries))
	}
}

func TestLANUpload(t *testing.T) {
	a := testApp(t)
	srv := httptest.NewServer(a.routes())
	defer srv.Close()
	data := randomBytes(t, 500_000)

	post := func(token, hash string) *http.Response {
		req, _ := http.NewRequest("POST", srv.URL+"/api/upload", bytes.NewReader(data))
		req.Header.Set("X-CellDesk-Token", token)
		req.Header.Set("X-File-Name", "my%20photo.jpg")
		req.Header.Set("X-File-SHA256", hash)
		req.Header.Set("Content-Type", "image/jpeg")
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		return resp
	}

	if r := post("nope", sum(data)); r.StatusCode != http.StatusUnauthorized {
		t.Fatalf("bad token: status %d", r.StatusCode)
	}
	if r := post(a.config().LANToken, strings.Repeat("0", 64)); r.StatusCode != http.StatusUnprocessableEntity {
		t.Fatalf("bad hash: status %d", r.StatusCode)
	}
	r := post(a.config().LANToken, sum(data))
	var ack struct {
		OK       bool
		Name     string
		Verified bool
	}
	json.NewDecoder(r.Body).Decode(&ack)
	if !ack.OK || !ack.Verified || !strings.HasSuffix(ack.Name, "_my photo.jpg") {
		t.Fatalf("unexpected ack %+v", ack)
	}
	got, _ := os.ReadFile(filepath.Join(a.config().SaveDir, ack.Name))
	if !bytes.Equal(got, data) {
		t.Fatal("saved bytes differ")
	}
}

func TestAdminIsLocalOnly(t *testing.T) {
	a := testApp(t)
	h := a.routes()
	cases := []struct {
		remote, host, method string
		header               bool
		want                 int
	}{
		{"127.0.0.1:5000", "localhost:47474", "GET", false, 200},
		{"192.168.1.20:5000", "192.168.1.5:47474", "GET", false, 404},
		{"127.0.0.1:5000", "evil.example:47474", "GET", false, 404}, // DNS rebinding
		{"127.0.0.1:5000", "localhost:47474", "POST", false, 403},   // CSRF
	}
	for _, c := range cases {
		path := "/api/admin/state"
		if c.method == "POST" {
			path = "/api/admin/settings"
		}
		req := httptest.NewRequest(c.method, path, strings.NewReader("{}"))
		req.RemoteAddr, req.Host = c.remote, c.host
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, req)
		if rec.Code != c.want {
			t.Errorf("%s %s from %s host %s: got %d want %d", c.method, path, c.remote, c.host, rec.Code, c.want)
		}
	}
}

func TestSanitizeName(t *testing.T) {
	for in, want := range map[string]string{
		"IMG_1234.HEIC":         "IMG_1234.HEIC",
		"../../etc/passwd":      "passwd",
		`C:\Windows\evil.exe`:   "evil.exe",
		"a<b>c:d.jpg":           "a_b_c_d.jpg",
		"":                      "photo",
		"...":                   "photo",
		"name\x00with\nctl.png": "name_with_ctl.png",
	} {
		if got := sanitizeName(in); got != want {
			t.Errorf("sanitizeName(%q) = %q, want %q", in, got, want)
		}
	}
	if got := finalName("image", "image/jpeg", time.Date(2026, 10, 9, 14, 3, 22, 0, time.UTC)); got != "20261009-140322_image.jpg" {
		t.Errorf("finalName = %q", got)
	}
}
