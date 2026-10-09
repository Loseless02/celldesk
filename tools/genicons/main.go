//go:build ignore

// genicons renders the PNG app icons to match phone/icons/icon.svg.
//
//	go run tools/genicons/main.go
package main

import (
	"fmt"
	"image"
	"image/color"
	"image/png"
	"log"
	"math"
	"os"
	"path/filepath"
)

type icon struct {
	file    string
	size    int
	rounded bool    // rounded corners (transparent outside)
	scale   float64 // glyph scale (maskable icons need a safe zone)
}

func main() {
	out := filepath.Join("phone", "icons")
	for _, ic := range []icon{
		{"icon-192.png", 192, true, 1},
		{"icon-512.png", 512, true, 1},
		{"icon-256.png", 256, true, 1},
		{"apple-touch-icon.png", 180, false, 1},
		{"icon-maskable-512.png", 512, false, 0.78},
	} {
		if err := write(filepath.Join(out, ic.file), render(ic)); err != nil {
			log.Fatal(err)
		}
	}
	// Tray icon sizes, packed into an .ico at runtime on Windows.
	for _, size := range []int{16, 20, 24, 32, 48, 64} {
		ic := icon{fmt.Sprintf("tray-%d.png", size), size, true, 1}
		if err := write(filepath.Join("internal", "app", "trayicon", ic.file), render(ic)); err != nil {
			log.Fatal(err)
		}
	}
}

func write(path string, img image.Image) error {
	f, err := os.Create(path)
	if err != nil {
		return err
	}
	defer f.Close()
	return png.Encode(f, img)
}

// coverage in a 64x64 design space: returns background alpha and white alpha.
func sample(x, y float64, ic icon) (bg, fg bool) {
	if ic.rounded {
		const r = 14.0
		cx := math.Max(r, math.Min(64-r, x))
		cy := math.Max(r, math.Min(64-r, y))
		if math.Hypot(x-cx, y-cy) > r {
			return false, false
		}
	}
	// Glyph coordinates, scaled about the centre for maskable icons.
	gx := 32 + (x-32)/ic.scale
	gy := 32 + (y-32)/ic.scale
	d := math.Hypot(gx-32, gy-33)
	ring := math.Abs(d-15.5) <= 2.25
	core := d <= 6.5
	flash := math.Hypot(gx-47, gy-17) <= 2.6
	return true, ring || core || flash
}

func render(ic icon) image.Image {
	const ss = 4 // supersampling per axis
	img := image.NewNRGBA(image.Rect(0, 0, ic.size, ic.size))
	a := [3]float64{0x63, 0x66, 0xf1}
	b := [3]float64{0x22, 0xd3, 0xee}
	for py := 0; py < ic.size; py++ {
		for px := 0; px < ic.size; px++ {
			var cov, white float64
			for sy := 0; sy < ss; sy++ {
				for sx := 0; sx < ss; sx++ {
					x := (float64(px) + (float64(sx)+0.5)/ss) * 64 / float64(ic.size)
					y := (float64(py) + (float64(sy)+0.5)/ss) * 64 / float64(ic.size)
					bg, fg := sample(x, y, ic)
					if bg {
						cov++
					}
					if fg {
						white++
					}
				}
			}
			if cov == 0 {
				continue
			}
			t := (float64(px) + float64(py)) / float64(2*ic.size)
			w := white / cov
			var c [3]float64
			for i := range c {
				g := a[i] + (b[i]-a[i])*t
				c[i] = g + (255-g)*w
			}
			img.SetNRGBA(px, py, color.NRGBA{uint8(c[0]), uint8(c[1]), uint8(c[2]), uint8(255 * cov / (ss * ss))})
		}
	}
	return img
}
