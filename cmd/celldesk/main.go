// Command celldesk is the desktop receiver: phones send photos to it over
// the local network or through a CellDesk relay, and it saves them untouched.
package main

import (
	"flag"
	"fmt"
	"os"

	"github.com/Loseless02/celldesk/internal/app"
)

// version is set at build time with -ldflags "-X main.version=v1.2.3".
var version = "dev"

func main() {
	noBrowser := flag.Bool("no-browser", false, "start without opening the dashboard")
	relay := flag.String("relay", "", "relay URL to use for sending from anywhere (saved to config)")
	port := flag.Int("port", 0, "port to listen on (saved to config, default 47474)")
	showVersion := flag.Bool("version", false, "print version and exit")
	flag.Parse()

	if *showVersion {
		fmt.Println("celldesk", version)
		return
	}

	err := app.Run(app.Options{
		// CELLDESK_HOME keeps config and logs elsewhere (portable installs, testing).
		ConfigDir: os.Getenv("CELLDESK_HOME"),
		Version:   version,
		NoBrowser: *noBrowser,
		RelayURL:  *relay,
		Port:      *port,
	})
	if err != nil {
		app.FatalDialog("CellDesk could not start:\n\n" + err.Error())
		os.Exit(1)
	}
}
