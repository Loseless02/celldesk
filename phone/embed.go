// Package phone holds the phone web app. The desktop receiver serves it on
// the local network and the relay serves the same files over HTTPS.
package phone

import "embed"

//go:embed index.html app.js sha256.js style.css sw.js manifest.webmanifest icons
var FS embed.FS
