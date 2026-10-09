//go:build !windows

package app

import (
	"fmt"
	"os"
	"path/filepath"
	"runtime"
)

func autostartFile() (string, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	if runtime.GOOS == "darwin" {
		return filepath.Join(home, "Library", "LaunchAgents", "io.github.loseless02.celldesk.plist"), nil
	}
	cfg, err := os.UserConfigDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(cfg, "autostart", "celldesk.desktop"), nil
}

func autostartEnabled() bool {
	p, err := autostartFile()
	if err != nil {
		return false
	}
	_, err = os.Stat(p)
	return err == nil
}

func setAutostart(on bool) error {
	p, err := autostartFile()
	if err != nil {
		return err
	}
	if !on {
		if err := os.Remove(p); err != nil && !os.IsNotExist(err) {
			return err
		}
		return nil
	}
	exe, err := os.Executable()
	if err != nil {
		return err
	}
	var content string
	if runtime.GOOS == "darwin" {
		content = fmt.Sprintf(`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>io.github.loseless02.celldesk</string>
  <key>ProgramArguments</key><array><string>%s</string><string>--no-browser</string></array>
  <key>RunAtLoad</key><true/>
</dict>
</plist>
`, exe)
	} else {
		content = fmt.Sprintf("[Desktop Entry]\nType=Application\nName=CellDesk\nExec=\"%s\" --no-browser\nX-GNOME-Autostart-enabled=true\n", exe)
	}
	if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
		return err
	}
	return os.WriteFile(p, []byte(content), 0o644)
}

// FatalDialog reports a startup error.
func FatalDialog(msg string) {
	fmt.Fprintln(os.Stderr, msg)
}
