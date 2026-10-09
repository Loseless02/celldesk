//go:build !windows && !linux

package app

// runTray: macOS builds have no tray icon (it would need cgo); quit from the
// dashboard or with `celldesk --quit`.
func (a *App) runTray() { <-a.quit }
