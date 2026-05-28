import AppKit
import ApplicationServices
import CoreAudio
import CoreGraphics
import Foundation

extension String: @retroactive Error {}

extension String: @retroactive LocalizedError {
    public var errorDescription: String? { self }
}

struct HelperEvent: Encodable {
    let type: String
    let payload: Payload

    struct Payload: Encodable {
        let processes: [ProcessSnapshot]?
        let message: String?

        static func snapshot(_ processes: [ProcessSnapshot]) -> Payload {
            Payload(processes: processes, message: nil)
        }

        static func error(_ message: String) -> Payload {
            Payload(processes: nil, message: message)
        }
    }
}

struct ProcessSnapshot: Encodable {
    let pid: Int32
    let bundleId: String?
    let appName: String?
    let isRunningInput: Bool
    let isForeground: Bool
    let accessibilityTrusted: Bool
    let windowTitle: String?
}

extension AudioObjectID {
    static let system = AudioObjectID(kAudioObjectSystemObject)

    func readProcessList() throws -> [AudioObjectID] {
        var address = AudioObjectPropertyAddress(
            mSelector: kAudioHardwarePropertyProcessObjectList,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain
        )
        var dataSize: UInt32 = 0
        var err = AudioObjectGetPropertyDataSize(self, &address, 0, nil, &dataSize)
        guard err == noErr else { throw "Could not read CoreAudio process list size: \(err)" }
        let count = Int(dataSize) / MemoryLayout<AudioObjectID>.size
        guard count > 0 else { return [] }
        var processIDs = Array(repeating: AudioObjectID(kAudioObjectUnknown), count: count)
        err = processIDs.withUnsafeMutableBufferPointer { pointer in
            AudioObjectGetPropertyData(self, &address, 0, nil, &dataSize, pointer.baseAddress!)
        }
        guard err == noErr else { throw "Could not read CoreAudio process list: \(err)" }
        return processIDs.filter { $0 != AudioObjectID(kAudioObjectUnknown) }
    }

    func readProcessObject(for pid: pid_t) -> AudioObjectID? {
        var address = AudioObjectPropertyAddress(
            mSelector: kAudioHardwarePropertyTranslatePIDToProcessObject,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain
        )
        var qualifier = pid
        var processID = AudioObjectID(kAudioObjectUnknown)
        var dataSize = UInt32(MemoryLayout<AudioObjectID>.size)
        let qualifierSize = UInt32(MemoryLayout<pid_t>.size)
        let err = AudioObjectGetPropertyData(
            self,
            &address,
            qualifierSize,
            &qualifier,
            &dataSize,
            &processID
        )
        guard err == noErr, processID != AudioObjectID(kAudioObjectUnknown) else {
            return nil
        }
        return processID
    }

    func readPID() -> pid_t? {
        var address = AudioObjectPropertyAddress(
            mSelector: kAudioProcessPropertyPID,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain
        )
        var pid = pid_t(0)
        var dataSize = UInt32(MemoryLayout<pid_t>.size)
        let err = AudioObjectGetPropertyData(self, &address, 0, nil, &dataSize, &pid)
        return err == noErr ? pid : nil
    }

    func readBundleID() -> String? {
        var address = AudioObjectPropertyAddress(
            mSelector: kAudioProcessPropertyBundleID,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain
        )
        var dataSize: UInt32 = 0
        var err = AudioObjectGetPropertyDataSize(self, &address, 0, nil, &dataSize)
        guard err == noErr else { return nil }
        var bundle: CFString = "" as CFString
        err = withUnsafeMutablePointer(to: &bundle) { pointer in
            AudioObjectGetPropertyData(self, &address, 0, nil, &dataSize, pointer)
        }
        guard err == noErr else { return nil }
        let value = bundle as String
        return value.isEmpty ? nil : value
    }

    func readRunningInput() -> Bool {
        var address = AudioObjectPropertyAddress(
            mSelector: kAudioProcessPropertyIsRunningInput,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain
        )
        var value: UInt32 = 0
        var dataSize = UInt32(MemoryLayout<UInt32>.size)
        let err = AudioObjectGetPropertyData(self, &address, 0, nil, &dataSize, &value)
        return err == noErr && value != 0
    }
}

func emit(_ type: String, _ payload: HelperEvent.Payload) {
    let event = HelperEvent(type: type, payload: payload)
    guard
        let data = try? JSONEncoder().encode(event),
        let line = String(data: data, encoding: .utf8)
    else {
        return
    }
    print(line)
    fflush(stdout)
}

func frontmostPID() -> pid_t? {
    NSWorkspace.shared.frontmostApplication?.processIdentifier
}

func activeWindowTitle(pid: pid_t, accessibilityTrusted: Bool) -> String? {
    if accessibilityTrusted {
        let app = AXUIElementCreateApplication(pid)
        if let title = titleForAttribute(app, kAXFocusedWindowAttribute)
            ?? titleForAttribute(app, kAXMainWindowAttribute)
            ?? firstWindowTitle(app) {
            return title
        }
    }
    return coreGraphicsWindowTitle(pid: pid)
}

func titleForAttribute(_ app: AXUIElement, _ attribute: String) -> String? {
    var focusedWindow: CFTypeRef?
    let focusedErr = AXUIElementCopyAttributeValue(
        app,
        attribute as CFString,
        &focusedWindow
    )
    guard focusedErr == .success, let focusedWindow else {
        return nil
    }
    var title: CFTypeRef?
    let titleErr = AXUIElementCopyAttributeValue(
        focusedWindow as! AXUIElement,
        kAXTitleAttribute as CFString,
        &title
    )
    guard titleErr == .success else { return nil }
    return title as? String
}

func firstWindowTitle(_ app: AXUIElement) -> String? {
    var windowsRef: CFTypeRef?
    let err = AXUIElementCopyAttributeValue(app, kAXWindowsAttribute as CFString, &windowsRef)
    guard err == .success, let windows = windowsRef as? [AXUIElement] else {
        return nil
    }
    for window in windows {
        var title: CFTypeRef?
        if AXUIElementCopyAttributeValue(window, kAXTitleAttribute as CFString, &title) == .success,
           let value = title as? String,
           !value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            return value
        }
    }
    return nil
}

func isRelatedBrowserProcess(_ bundleID: String?, foregroundBundleID: String?) -> Bool {
    guard let bundleID, let foregroundBundleID else { return false }
    if bundleID == foregroundBundleID {
        return true
    }
    return bundleID.lowercased().hasPrefix("\(foregroundBundleID).".lowercased())
}

func isBrowserBundle(_ bundleID: String?) -> Bool {
    guard let bundleID else { return false }
    return [
        "com.google.Chrome",
        "com.google.Chrome.canary",
        "org.chromium.Chromium",
        "com.brave.Browser",
        "com.microsoft.edgemac",
        "com.apple.Safari",
        "com.apple.SafariTechnologyPreview",
        "com.operasoftware.Opera",
        "company.thebrowser.Browser",
    ].contains(bundleID)
}

func meetingTitleLike(_ title: String?) -> Bool {
    guard let title else { return false }
    let normalized = title.lowercased()
    return [
        "google meet",
        "meet.google",
        "meet.google.com",
        "meet -",
        "meet |",
        "zoom meeting",
        "zoom webinar",
        "microsoft teams",
        "teams meeting",
        "whereby",
        "webex",
        "jitsi",
        "around",
        "slack huddle",
        "discord",
    ].contains { normalized.contains($0) }
}

func coreGraphicsWindowTitle(pid: pid_t) -> String? {
    guard
        let windows = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID)
            as? [[String: Any]]
    else {
        return nil
    }
    for window in windows {
        guard
            let ownerPID = window[kCGWindowOwnerPID as String] as? pid_t,
            ownerPID == pid,
            let layer = window[kCGWindowLayer as String] as? Int,
            layer == 0,
            let title = window[kCGWindowName as String] as? String
        else {
            continue
        }
        let trimmed = title.trimmingCharacters(in: .whitespacesAndNewlines)
        if !trimmed.isEmpty {
            return trimmed
        }
    }
    return nil
}

func collectSnapshots() throws -> [ProcessSnapshot] {
    let listedProcessObjects = try AudioObjectID.system.readProcessList()
    let translatedProcessObjects = NSWorkspace.shared.runningApplications.compactMap {
        AudioObjectID.system.readProcessObject(for: $0.processIdentifier)
    }
    var seenProcessObjects = Set<AudioObjectID>()
    let processObjects = (listedProcessObjects + translatedProcessObjects).filter {
        seenProcessObjects.insert($0).inserted
    }
    let foreground = NSWorkspace.shared.frontmostApplication
    let foregroundPID = foreground?.processIdentifier
    let foregroundBundleID = foreground?.bundleIdentifier
    let foregroundAppName = foreground?.localizedName
    let accessibilityTrusted = AXIsProcessTrusted()
    let foregroundTitle = foregroundPID.map {
        activeWindowTitle(pid: $0, accessibilityTrusted: accessibilityTrusted)
    } ?? nil
    var snapshots: [ProcessSnapshot] = processObjects.compactMap { objectID in
        guard objectID.readRunningInput(), let pid = objectID.readPID() else {
            return nil
        }
        let app = NSRunningApplication(processIdentifier: pid)
        let bundleID = objectID.readBundleID() ?? app?.bundleIdentifier
        let isForeground = foregroundPID == pid
        let isRelatedBrowser = isRelatedBrowserProcess(bundleID, foregroundBundleID: foregroundBundleID)
        let effectiveForeground = isForeground || isRelatedBrowser
        return ProcessSnapshot(
            pid: pid,
            bundleId: bundleID,
            appName: isRelatedBrowser ? (foregroundAppName ?? app?.localizedName) : app?.localizedName,
            isRunningInput: true,
            isForeground: effectiveForeground,
            accessibilityTrusted: accessibilityTrusted,
            windowTitle: effectiveForeground ? foregroundTitle : nil
        )
    }
    let hasForegroundBrowserCandidate = snapshots.contains {
        isRelatedBrowserProcess($0.bundleId, foregroundBundleID: foregroundBundleID)
    }
    if !hasForegroundBrowserCandidate,
       let foregroundPID,
       let foregroundBundleID,
       isBrowserBundle(foregroundBundleID),
       meetingTitleLike(foregroundTitle) {
        snapshots.append(
            ProcessSnapshot(
                pid: foregroundPID,
                bundleId: foregroundBundleID,
                appName: foregroundAppName,
                isRunningInput: true,
                isForeground: true,
                accessibilityTrusted: true,
                windowTitle: foregroundTitle
            )
        )
    }
    return snapshots
}

final class Detector {
    private let interval: TimeInterval = 1.0
    private var shouldRun = true

    func run() {
        signal(SIGTERM) { _ in
            exit(0)
        }
        signal(SIGINT) { _ in
            exit(0)
        }
        while shouldRun {
            autoreleasepool {
                do {
                    emit("snapshot", .snapshot(try collectSnapshots()))
                } catch {
                    emit("error", .error(String(describing: error)))
                }
            }
            Thread.sleep(forTimeInterval: interval)
        }
    }
}

Detector().run()
