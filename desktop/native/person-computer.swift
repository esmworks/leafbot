// Moves the mouse and types on the person's own Mac for a bot they allowed to use it.
//
// The server starts this once and talks to it over stdin/stdout, one JSON object per line each
// way: a request carries an `id` and an `op`, and the answer carries the same `id` with `ok` and
// either the result or an `error`. Key names and screen pictures are handled by the server; this
// only posts the events, so it stays small and needs nothing beyond what macOS ships.
//
// macOS lets a program post input only once the person allowed it under Privacy & Security →
// Accessibility. Without that the events would be dropped silently, so every op that posts one
// checks first and answers `accessibility` instead.

import AppKit
import ApplicationServices
import Foundation

struct Failure: Error {
  let code: String
}

func number(_ v: Any?) throws -> Double {
  if let n = v as? NSNumber { return n.doubleValue }
  throw Failure(code: "badRequest")
}

func point(_ req: [String: Any], _ xKey: String, _ yKey: String) throws -> CGPoint {
  CGPoint(x: try number(req[xKey]), y: try number(req[yKey]))
}

func screenInfo() -> [String: Any] {
  let bounds = CGDisplayBounds(CGMainDisplayID())
  return [
    "accessibility": AXIsProcessTrusted(),
    "screen": CGPreflightScreenCaptureAccess(),
    "width": Double(bounds.width),
    "height": Double(bounds.height),
    "scale": Double(NSScreen.main?.backingScaleFactor ?? 1),
  ]
}

func requireAccess() throws {
  if !AXIsProcessTrusted() { throw Failure(code: "accessibility") }
}

func post(_ event: CGEvent?) throws {
  guard let event else { throw Failure(code: "failed") }
  event.post(tap: .cghidEventTap)
}

func pause(_ ms: UInt32) { usleep(ms * 1000) }

func mouseTypes(_ button: String) -> (CGEventType, CGEventType, CGEventType, CGMouseButton) {
  switch button {
  case "right": return (.rightMouseDown, .rightMouseUp, .rightMouseDragged, .right)
  case "middle": return (.otherMouseDown, .otherMouseUp, .otherMouseDragged, .center)
  default: return (.leftMouseDown, .leftMouseUp, .leftMouseDragged, .left)
  }
}

func move(to p: CGPoint) throws {
  try post(CGEvent(mouseEventSource: nil, mouseType: .mouseMoved, mouseCursorPosition: p, mouseButton: .left))
}

func click(at p: CGPoint, button: String, count: Int) throws {
  let (down, up, _, which) = mouseTypes(button)
  try move(to: p)
  pause(30)
  for n in 1...max(1, min(count, 3)) {
    for type in [down, up] {
      let e = CGEvent(mouseEventSource: nil, mouseType: type, mouseCursorPosition: p, mouseButton: which)
      e?.setIntegerValueField(.mouseEventClickState, value: Int64(n))
      try post(e)
    }
    pause(40)
  }
}

func drag(from a: CGPoint, to b: CGPoint) throws {
  try move(to: a)
  pause(30)
  try post(CGEvent(mouseEventSource: nil, mouseType: .leftMouseDown, mouseCursorPosition: a, mouseButton: .left))
  // In steps, so the app under it sees a drag and not a jump.
  let steps = 12
  for i in 1...steps {
    let t = Double(i) / Double(steps)
    let p = CGPoint(x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t)
    try post(CGEvent(mouseEventSource: nil, mouseType: .leftMouseDragged, mouseCursorPosition: p, mouseButton: .left))
    pause(15)
  }
  try post(CGEvent(mouseEventSource: nil, mouseType: .leftMouseUp, mouseCursorPosition: b, mouseButton: .left))
}

func scroll(at p: CGPoint, dx: Int32, dy: Int32) throws {
  try move(to: p)
  pause(30)
  try post(CGEvent(scrollWheelEvent2Source: nil, units: .line, wheelCount: 2, wheel1: dy, wheel2: dx, wheel3: 0))
}

func flags(_ names: [String]) -> CGEventFlags {
  var f: CGEventFlags = []
  for n in names {
    switch n {
    case "command": f.insert(.maskCommand)
    case "control": f.insert(.maskControl)
    case "option": f.insert(.maskAlternate)
    case "shift": f.insert(.maskShift)
    case "fn": f.insert(.maskSecondaryFn)
    default: break
    }
  }
  return f
}

func press(code: CGKeyCode, modifiers: [String]) throws {
  let f = flags(modifiers)
  for down in [true, false] {
    let e = CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: down)
    e?.flags = f
    try post(e)
    pause(12)
  }
}

/// Types text as characters, whatever the keyboard layout: a line break presses Return.
func type(_ text: String) throws {
  let lines = text.components(separatedBy: "\n")
  for (i, line) in lines.enumerated() {
    var units = Array(line.utf16)
    while !units.isEmpty {
      // A key event carries a few characters at most; longer text goes in pieces.
      let piece = Array(units.prefix(16))
      units.removeFirst(piece.count)
      for down in [true, false] {
        let e = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: down)
        piece.withUnsafeBufferPointer { e?.keyboardSetUnicodeString(stringLength: piece.count, unicodeString: $0.baseAddress) }
        try post(e)
      }
      pause(8)
    }
    if i < lines.count - 1 { try press(code: 36, modifiers: []) }
  }
}

func handle(_ req: [String: Any]) throws -> [String: Any] {
  switch req["op"] as? String {
  case "status":
    return screenInfo()
  case "request":
    // Opens the two Privacy & Security prompts; macOS shows each only until it was answered once.
    _ = AXIsProcessTrustedWithOptions([kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary)
    _ = CGRequestScreenCaptureAccess()
    return screenInfo()
  case "move":
    try requireAccess()
    try move(to: try point(req, "x", "y"))
  case "click":
    try requireAccess()
    try click(at: try point(req, "x", "y"), button: req["button"] as? String ?? "left", count: Int(try number(req["count"] ?? 1)))
  case "drag":
    try requireAccess()
    try drag(from: try point(req, "fromX", "fromY"), to: try point(req, "toX", "toY"))
  case "scroll":
    try requireAccess()
    try scroll(at: try point(req, "x", "y"), dx: Int32(try number(req["dx"] ?? 0)), dy: Int32(try number(req["dy"] ?? 0)))
  case "type":
    try requireAccess()
    guard let text = req["text"] as? String else { throw Failure(code: "badRequest") }
    try type(text)
  case "key":
    try requireAccess()
    let code = CGKeyCode(try number(req["code"]))
    try press(code: code, modifiers: req["modifiers"] as? [String] ?? [])
  default:
    throw Failure(code: "badRequest")
  }
  return [:]
}

func answer(_ obj: [String: Any]) {
  guard let data = try? JSONSerialization.data(withJSONObject: obj), let line = String(data: data, encoding: .utf8) else { return }
  FileHandle.standardOutput.write((line + "\n").data(using: .utf8)!)
}

while let line = readLine() {
  guard let data = line.data(using: .utf8),
    let req = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
  else { continue }
  let id = req["id"] ?? NSNull()
  do {
    var out = try handle(req)
    out["id"] = id
    out["ok"] = true
    answer(out)
  } catch let f as Failure {
    answer(["id": id, "ok": false, "error": f.code])
  } catch {
    answer(["id": id, "ok": false, "error": "failed"])
  }
}
