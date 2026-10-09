//go:build windows || linux

package app

import (
	"embed"
	"encoding/binary"
	"fmt"
	"runtime"

	"fyne.io/systray"
)

//go:embed trayicon/*.png
var trayFS embed.FS

// runTray shows the notification-area icon and blocks until CellDesk quits.
// It must run on the main goroutine.
func (a *App) runTray() {
	systray.Run(func() {
		systray.SetIcon(trayIcon())
		systray.SetTooltip("CellDesk · receiving on " + a.name)
		open := systray.AddMenuItem("Open CellDesk", "Show the dashboard")
		folder := systray.AddMenuItem("Open received folder", "Show saved photos and files")
		systray.AddSeparator()
		quit := systray.AddMenuItem("Quit CellDesk", "Stop receiving and close CellDesk")
		systray.SetOnTapped(func() { openTarget(a.dashboardURL()) })
		go func() {
			for {
				select {
				case <-open.ClickedCh:
					openTarget(a.dashboardURL())
				case <-folder.ClickedCh:
					openTarget(a.config().SaveDir)
				case <-quit.ClickedCh:
					a.Quit()
				case <-a.quit:
					systray.Quit()
					return
				}
			}
		}()
	}, nil)
}

// trayIcon returns PNG bytes, or on Windows an .ico holding several PNG sizes.
func trayIcon() []byte {
	if runtime.GOOS != "windows" {
		b, _ := trayFS.ReadFile("trayicon/tray-64.png")
		return b
	}
	sizes := []int{16, 20, 24, 32, 48, 64}
	pngs := make([][]byte, len(sizes))
	for i, s := range sizes {
		pngs[i], _ = trayFS.ReadFile(fmt.Sprintf("trayicon/tray-%d.png", s))
	}
	head := make([]byte, 6+16*len(sizes))
	binary.LittleEndian.PutUint16(head[2:], 1) // icon
	binary.LittleEndian.PutUint16(head[4:], uint16(len(sizes)))
	offset := len(head)
	for i, s := range sizes {
		e := head[6+16*i:]
		e[0], e[1] = byte(s), byte(s)
		binary.LittleEndian.PutUint16(e[4:], 1)  // planes
		binary.LittleEndian.PutUint16(e[6:], 32) // bits per pixel
		binary.LittleEndian.PutUint32(e[8:], uint32(len(pngs[i])))
		binary.LittleEndian.PutUint32(e[12:], uint32(offset))
		offset += len(pngs[i])
	}
	out := head
	for _, p := range pngs {
		out = append(out, p...)
	}
	return out
}
