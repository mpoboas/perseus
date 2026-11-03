// Draws the macOS application icon: the colour logo on a rounded "squircle" tile, following Apple's
// icon grid (an 824 px tile centred on a 1024 px canvas, with a soft shadow in the margin).
// macOS draws nothing around an icon, so unlike Windows the artwork has to bring its own tile.
//
//   swift scripts/make-macos-icon.swift branding/app-icon.png branding/app-icon-macos.png
import AppKit

let args = CommandLine.arguments
guard args.count == 3, let logo = NSImage(contentsOfFile: args[1]) else {
    FileHandle.standardError.write(Data("usage: make-macos-icon.swift <logo.png> <out.png>\n".utf8))
    exit(1)
}

let canvas = 1024
let tile: CGFloat = 824
let inset = (CGFloat(canvas) - tile) / 2
// The logo's own artwork already has about 8% margin on its square; scaling that square to 82% of the
// tile keeps the helmet clear of the corners.
let logoSide = tile * 0.82

guard let ctx = CGContext(
    data: nil, width: canvas, height: canvas, bitsPerComponent: 8, bytesPerRow: 0,
    space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)
else { exit(1) }

/// A superellipse (exponent 5) is much closer to Apple's continuous corners than a plain rounded rectangle.
func squircle(_ rect: CGRect) -> CGPath {
    let path = CGMutablePath()
    let n = 5.0, steps = 360
    let a = rect.width / 2, b = rect.height / 2
    for i in 0...steps {
        let t = Double(i) / Double(steps) * 2 * .pi
        let c = cos(t), s = sin(t)
        let x = rect.midX + a * CGFloat((c < 0 ? -1.0 : 1.0) * pow(abs(c), 2 / n))
        let y = rect.midY + b * CGFloat((s < 0 ? -1.0 : 1.0) * pow(abs(s), 2 / n))
        if i == 0 { path.move(to: CGPoint(x: x, y: y)) } else { path.addLine(to: CGPoint(x: x, y: y)) }
    }
    path.closeSubpath()
    return path
}

let rect = CGRect(x: inset, y: inset, width: tile, height: tile)
let shape = squircle(rect)

// Shadow, drawn by filling the tile once with a shadow on.
ctx.saveGState()
ctx.setShadow(offset: CGSize(width: 0, height: -12), blur: 24, color: CGColor(gray: 0, alpha: 0.35))
ctx.addPath(shape)
ctx.setFillColor(CGColor(red: 0.05, green: 0.06, blue: 0.2, alpha: 1))
ctx.fillPath()
ctx.restoreGState()

// Tile: a deep indigo gradient, lighter at the top, so the logo's own dark disc still reads against it.
ctx.saveGState()
ctx.addPath(shape)
ctx.clip()
let gradient = CGGradient(
    colorsSpace: CGColorSpaceCreateDeviceRGB(),
    colors: [CGColor(red: 0.20, green: 0.22, blue: 0.52, alpha: 1), CGColor(red: 0.06, green: 0.07, blue: 0.24, alpha: 1)] as CFArray,
    locations: [0, 1])!
ctx.drawLinearGradient(
    gradient, start: CGPoint(x: rect.midX, y: rect.maxY), end: CGPoint(x: rect.midX, y: rect.minY), options: [])
// The logo, centred.
let logoRect = CGRect(
    x: CGFloat(canvas) / 2 - logoSide / 2, y: CGFloat(canvas) / 2 - logoSide / 2, width: logoSide, height: logoSide)
var proposed = logoRect
if let cg = logo.cgImage(forProposedRect: &proposed, context: nil, hints: nil) {
    ctx.draw(cg, in: logoRect)
}
ctx.restoreGState()

// A hairline highlight along the edge, like the system's own icons have.
ctx.addPath(shape)
ctx.setStrokeColor(CGColor(gray: 1, alpha: 0.12))
ctx.setLineWidth(2)
ctx.strokePath()

guard let image = ctx.makeImage(),
    let png = NSBitmapImageRep(cgImage: image).representation(using: .png, properties: [:])
else { exit(1) }
try png.write(to: URL(fileURLWithPath: args[2]))
