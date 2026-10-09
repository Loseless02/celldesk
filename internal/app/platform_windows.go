package app

import (
	"os"

	"golang.org/x/sys/windows"
	"golang.org/x/sys/windows/registry"
)

const runKey = `Software\Microsoft\Windows\CurrentVersion\Run`

func autostartEnabled() bool {
	k, err := registry.OpenKey(registry.CURRENT_USER, runKey, registry.QUERY_VALUE)
	if err != nil {
		return false
	}
	defer k.Close()
	_, _, err = k.GetStringValue("CellDesk")
	return err == nil
}

func setAutostart(on bool) error {
	k, _, err := registry.CreateKey(registry.CURRENT_USER, runKey, registry.SET_VALUE|registry.QUERY_VALUE)
	if err != nil {
		return err
	}
	defer k.Close()
	if !on {
		if _, _, err := k.GetStringValue("CellDesk"); err != nil {
			return nil
		}
		return k.DeleteValue("CellDesk")
	}
	exe, err := os.Executable()
	if err != nil {
		return err
	}
	return k.SetStringValue("CellDesk", `"`+exe+`" --no-browser`)
}

// FatalDialog shows an error even when the build has no console window.
func FatalDialog(msg string) {
	title, _ := windows.UTF16PtrFromString("CellDesk")
	text, _ := windows.UTF16PtrFromString(msg)
	windows.MessageBox(0, text, title, windows.MB_OK|windows.MB_ICONERROR)
}
