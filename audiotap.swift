// audiotap.swift — hears ONLY Spotify and Apple Music (never the microphone) using ScreenCaptureKit.
//
// Built and started automatically by capstellation.py. Writes one line per update to stdout:
//   R <rate>        sample rate of the captured audio (sent once)
//   L <base64>      ~60×/s: 512-bin spectrum (0–12 kHz), bytes in the same scale as Web Audio's
//                   AnalyserNode.getByteFrequencyData (minDecibels −95, maxDecibels −25)
//   P <base64>      the same audio as 16 kHz mono 16-bit PCM, for song recognition in Listen mode
//   E <message>     an error the app should show
// Human-readable notes go to stderr (printed in the helper's Terminal).
// Also used by the app's wallpaper mode to read / set the desktop picture (see below).
//
// Needs macOS 13+ and "Screen & System Audio Recording" permission for Terminal
// (System Settings > Privacy & Security). No screen pixels are kept: video is 2×2 px and ignored.

import Foundation
import ScreenCaptureKit
import CoreMedia
import AVFoundation
import Accelerate
import AppKit

// One-off jobs for the app's wallpaper mode (the menu bar takes its tint from the real desktop picture):
//   --get-wallpaper              prints "<path>\t<scaling>\t<clipping>" for the main screen
//   --set-wallpaper <path> [scaling clipping]
//   --desktop-levels             prints the desktop picture's and desktop icons' window levels
let cli = CommandLine.arguments
// --desktop-levels: the window layers of the desktop picture and the desktop icons ("<picture> <icons>")
if cli.count >= 2 && cli[1] == "--desktop-levels" {
    print("\(CGWindowLevelForKey(.desktopWindow)) \(CGWindowLevelForKey(.desktopIconWindow))")
    exit(0)
}
if cli.count >= 2 && (cli[1] == "--get-wallpaper" || cli[1] == "--set-wallpaper") {
    guard let screen = NSScreen.main ?? NSScreen.screens.first else { note("no screen"); exit(1) }
    let ws = NSWorkspace.shared
    if cli[1] == "--get-wallpaper" {
        let url = ws.desktopImageURL(for: screen)
        let o = ws.desktopImageOptions(for: screen) ?? [:]
        let scaling = (o[.imageScaling] as? NSNumber)?.intValue ?? Int(NSImageScaling.scaleProportionallyUpOrDown.rawValue)
        let clip = (o[.allowClipping] as? NSNumber)?.boolValue ?? true
        print("\(url?.path ?? "")\t\(scaling)\t\(clip ? 1 : 0)")
        exit(0)
    }
    guard cli.count >= 3 else { note("usage: --set-wallpaper <path>"); exit(2) }
    let scaling = cli.count >= 4 ? (Int(cli[3]) ?? 3) : Int(NSImageScaling.scaleProportionallyUpOrDown.rawValue)
    let clip = cli.count >= 5 ? cli[4] == "1" : true
    let opts: [NSWorkspace.DesktopImageOptionKey: Any] = [.imageScaling: NSNumber(value: scaling), .allowClipping: NSNumber(value: clip)]
    do {
        for s in NSScreen.screens where s == screen { try ws.setDesktopImageURL(URL(fileURLWithPath: cli[2]), for: s, options: opts) }
        print("ok"); exit(0)
    } catch { note("couldn't set the desktop picture: \(error.localizedDescription)"); exit(3) }
}

let fftSize = 2048
let hop = 800                 // 48 kHz / 800 = 60 updates a second
let outBins = 512             // 512 × 23.4 Hz ≈ 0–12 kHz
let wantedApps = ["com.spotify.client", "com.apple.Music"]

func emit(_ line: String) {
    if let d = (line + "\n").data(using: .utf8) { FileHandle.standardOutput.write(d) }
}
func note(_ msg: String) {
    if let d = (msg + "\n").data(using: .utf8) { FileHandle.standardError.write(d) }
}

final class Analyzer {
    private var ring = [Float](repeating: 0, count: fftSize)
    private var pos = 0
    private var sinceHop = 0
    private let window: [Float]
    private let fft: vDSP.FFT<DSPSplitComplex>
    private var smooth = [Float](repeating: 0, count: outBins)
    private var pcm: [Int16] = []
    private var decimSum: Float = 0
    private var decimN = 0

    init() {
        window = vDSP.window(ofType: Float.self, usingSequence: .blackman, count: fftSize, isHalfWindow: false)
        fft = vDSP.FFT(log2n: vDSP_Length(11), radix: .radix2, ofType: DSPSplitComplex.self)!
    }

    func push(_ s: Float) {
        ring[pos] = s
        pos = (pos + 1) % fftSize
        sinceHop += 1
        decimSum += s; decimN += 1                     // 48 kHz → 16 kHz for recognition
        if decimN == 3 {
            let v = max(-1, min(1, decimSum / 3))
            pcm.append(Int16(v * 32767))
            decimSum = 0; decimN = 0
        }
        if sinceHop >= hop {
            sinceHop = 0
            analyze()
            if !pcm.isEmpty {
                let data = pcm.withUnsafeBufferPointer { Data(buffer: $0) }
                emit("P " + data.base64EncodedString())
                pcm.removeAll(keepingCapacity: true)
            }
        }
    }

    private func analyze() {
        var frame = [Float](repeating: 0, count: fftSize)
        for i in 0..<fftSize { frame[i] = ring[(pos + i) % fftSize] * window[i] }
        var re = [Float](repeating: 0, count: fftSize / 2)
        var im = [Float](repeating: 0, count: fftSize / 2)
        var mags = [Float](repeating: 0, count: fftSize / 2)
        re.withUnsafeMutableBufferPointer { rp in
            im.withUnsafeMutableBufferPointer { ip in
                var split = DSPSplitComplex(realp: rp.baseAddress!, imagp: ip.baseAddress!)
                frame.withUnsafeBufferPointer { fp in
                    fp.baseAddress!.withMemoryRebound(to: DSPComplex.self, capacity: fftSize / 2) { cp in
                        vDSP_ctoz(cp, 2, &split, 1, vDSP_Length(fftSize / 2))
                    }
                }
                let input = split
                fft.forward(input: input, output: &split)
                mags.withUnsafeMutableBufferPointer { mp in
                    vDSP_zvabs(&split, 1, mp.baseAddress!, 1, vDSP_Length(fftSize / 2))
                }
            }
        }
        let minDb: Float = -95, maxDb: Float = -25
        var bytes = [UInt8](repeating: 0, count: outBins)
        for k in 0..<outBins {
            let m = mags[k] / Float(fftSize)             // vDSP's real FFT is 2× the DFT; this ≈ Web Audio's scale
            smooth[k] = 0.45 * smooth[k] + 0.55 * m       // like smoothingTimeConstant = 0.45
            let db = 20 * log10(max(smooth[k], 1e-12))
            bytes[k] = UInt8(max(0, min(255, (db - minDb) / (maxDb - minDb) * 255)))
        }
        emit("L " + Data(bytes).base64EncodedString())
    }
}

@available(macOS 13.0, *)
final class Tap: NSObject, SCStreamOutput, SCStreamDelegate {
    let analyzer = Analyzer()
    var stream: SCStream?
    var capturing: [String] = []
    var sentRate = false
    let audioQueue = DispatchQueue(label: "capstellation.audio")
    let screenQueue = DispatchQueue(label: "capstellation.screen")

    /// (Re)build the capture whenever Spotify / Music open or quit.
    func refresh() async {
        do {
            let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: false)
            guard let display = content.displays.first else { note("no display found"); return }
            let apps = content.applications.filter { wantedApps.contains($0.bundleIdentifier) }
            let ids = apps.map { $0.bundleIdentifier }.sorted()
            if ids == capturing && stream != nil { return }
            if let s = stream { try? await s.stopCapture(); stream = nil }
            capturing = ids
            if apps.isEmpty { note("waiting for Spotify or Music to open"); return }

            // Only these apps' audio is captured — not the mic, not other apps, not notifications.
            let filter = SCContentFilter(display: display, including: apps, exceptingWindows: [])
            let cfg = SCStreamConfiguration()
            cfg.capturesAudio = true
            cfg.sampleRate = 48000
            cfg.channelCount = 2
            cfg.excludesCurrentProcessAudio = true
            cfg.width = 2
            cfg.height = 2
            cfg.minimumFrameInterval = CMTime(value: 1, timescale: 2)
            cfg.showsCursor = false

            let s = SCStream(filter: filter, configuration: cfg, delegate: self)
            try s.addStreamOutput(self, type: .audio, sampleHandlerQueue: audioQueue)
            try s.addStreamOutput(self, type: .screen, sampleHandlerQueue: screenQueue)
            try await s.startCapture()
            stream = s
            note("listening to: " + ids.joined(separator: ", "))
        } catch {
            capturing = []
            let msg = error.localizedDescription
            note("can't capture audio: \(msg)")
            note("→ allow Terminal in System Settings > Privacy & Security > Screen & System Audio Recording, then restart the helper")
            emit("E Allow Terminal in System Settings > Privacy & Security > Screen & System Audio Recording, then restart the helper. (\(msg))")
        }
    }

    func stream(_ stream: SCStream, didOutputSampleBuffer sb: CMSampleBuffer, of type: SCStreamOutputType) {
        guard type == .audio, sb.isValid, sb.numSamples > 0,
              let asbd = sb.formatDescription?.audioStreamBasicDescription else { return }
        let isFloat = (asbd.mFormatFlags & kAudioFormatFlagIsFloat) != 0
        guard isFloat, asbd.mBitsPerChannel == 32 else { return }
        if !sentRate { emit("R \(asbd.mSampleRate)"); sentRate = true }
        let frames = sb.numSamples
        let nonInterleaved = (asbd.mFormatFlags & kAudioFormatFlagIsNonInterleaved) != 0
        try? sb.withAudioBufferList { abl, _ in
            if nonInterleaved {
                let chans = abl.count
                guard chans > 0 else { return }
                let ptrs = abl.map { $0.mData?.assumingMemoryBound(to: Float.self) }
                for i in 0..<frames {
                    var s: Float = 0
                    for c in 0..<chans { s += ptrs[c]?[i] ?? 0 }
                    analyzer.push(s / Float(chans))
                }
            } else {
                let ch = max(1, Int(asbd.mChannelsPerFrame))
                guard let p = abl.first?.mData?.assumingMemoryBound(to: Float.self) else { return }
                for i in 0..<frames {
                    var s: Float = 0
                    for c in 0..<ch { s += p[i * ch + c] }
                    analyzer.push(s / Float(ch))
                }
            }
        }
    }

    func stream(_ stream: SCStream, didStopWithError error: Error) {
        note("capture stopped: \(error.localizedDescription)")
        self.stream = nil
        capturing = []
    }
}

if #available(macOS 13.0, *) {
    let tap = Tap()
    Task {
        while true {
            await tap.refresh()
            try? await Task.sleep(nanoseconds: 3_000_000_000)
        }
    }
    dispatchMain()
} else {
    emit("E System audio needs macOS 13 (Ventura) or newer.")
    note("System audio needs macOS 13 (Ventura) or newer.")
    exit(1)
}
