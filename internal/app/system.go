package app

import (
	"log"
	"net"
	"os"
	"os/exec"
	"runtime"
	"strings"
)

// openTarget opens a URL, file or folder with the system default handler.
func openTarget(target string) {
	var cmd *exec.Cmd
	switch runtime.GOOS {
	case "windows":
		if st, err := os.Stat(target); err == nil && st.IsDir() {
			cmd = exec.Command("explorer", target)
		} else {
			cmd = exec.Command("rundll32", "url.dll,FileProtocolHandler", target)
		}
	case "darwin":
		cmd = exec.Command("open", target)
	default:
		cmd = exec.Command("xdg-open", target)
	}
	if err := cmd.Start(); err != nil {
		log.Printf("open %s: %v", target, err)
		return
	}
	go cmd.Wait()
}

// tailnet is the CGNAT range Tailscale assigns device addresses from.
var tailnet = &net.IPNet{IP: net.IPv4(100, 64, 0, 0), Mask: net.CIDRMask(10, 32)}

// tailscaleIP returns this computer's Tailscale address, or "" when
// Tailscale is not running. The Tailscale adapter is preferred so a carrier
// CGNAT address on another interface is not mistaken for it.
func tailscaleIP() string {
	ifaces, _ := net.Interfaces()
	fallback := ""
	for _, iface := range ifaces {
		if iface.Flags&net.FlagUp == 0 {
			continue
		}
		addrs, _ := iface.Addrs()
		for _, addr := range addrs {
			n, ok := addr.(*net.IPNet)
			if !ok || n.IP.To4() == nil || !tailnet.Contains(n.IP) {
				continue
			}
			if strings.Contains(strings.ToLower(iface.Name), "tailscale") {
				return n.IP.String()
			}
			if fallback == "" {
				fallback = n.IP.String()
			}
		}
	}
	return fallback
}

// lanIP returns the address phones on the same network should use.
func lanIP() string {
	// Dialing UDP sends nothing; it only asks the OS which interface routes out.
	if c, err := net.Dial("udp4", "8.8.8.8:80"); err == nil {
		ip := c.LocalAddr().(*net.UDPAddr).IP
		c.Close()
		if ip.IsPrivate() {
			return ip.String()
		}
	}
	ifaces, _ := net.Interfaces()
	for _, iface := range ifaces {
		if iface.Flags&net.FlagUp == 0 || iface.Flags&net.FlagLoopback != 0 {
			continue
		}
		addrs, _ := iface.Addrs()
		for _, addr := range addrs {
			if n, ok := addr.(*net.IPNet); ok && n.IP.To4() != nil && n.IP.IsPrivate() {
				return n.IP.String()
			}
		}
	}
	return "127.0.0.1"
}
