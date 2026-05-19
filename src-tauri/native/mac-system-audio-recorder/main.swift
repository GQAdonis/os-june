import AVFoundation
import AudioToolbox
import CoreAudio
import Darwin
import Foundation

extension String: @retroactive Error {}

extension AudioObjectID {
    static let system = AudioObjectID(kAudioObjectSystemObject)
    static let unknown = kAudioObjectUnknown
    var isValid: Bool { self != .unknown }

    static func readDefaultSystemOutputDevice() throws -> AudioDeviceID {
        try AudioObjectID.system.read(kAudioHardwarePropertyDefaultSystemOutputDevice, defaultValue: AudioDeviceID.unknown)
    }

    func readDeviceUID() throws -> String {
        try readString(kAudioDevicePropertyDeviceUID)
    }

    func readAudioTapStreamBasicDescription() throws -> AudioStreamBasicDescription {
        try read(kAudioTapPropertyFormat, defaultValue: AudioStreamBasicDescription())
    }

    func readString(_ selector: AudioObjectPropertySelector) throws -> String {
        try read(AudioObjectPropertyAddress(mSelector: selector, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain), defaultValue: "" as CFString) as String
    }

    func read<T>(_ selector: AudioObjectPropertySelector, defaultValue: T) throws -> T {
        try read(AudioObjectPropertyAddress(mSelector: selector, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain), defaultValue: defaultValue)
    }

    func read<T>(_ address: AudioObjectPropertyAddress, defaultValue: T) throws -> T {
        var address = address
        var dataSize: UInt32 = 0
        var err = AudioObjectGetPropertyDataSize(self, &address, 0, nil, &dataSize)
        guard err == noErr else { throw "Error reading data size for audio property: \(err)" }

        var value = defaultValue
        err = withUnsafeMutablePointer(to: &value) { pointer in
            AudioObjectGetPropertyData(self, &address, 0, nil, &dataSize, pointer)
        }
        guard err == noErr else { throw "Error reading audio property: \(err)" }
        return value
    }
}

final class SystemAudioRecorder {
    private let outputURL: URL?
    private let statusURL: URL?
    private let pidURL: URL?
    private let queue = DispatchQueue(label: "network.opensoftware.os-notetaker.system-audio", qos: .userInitiated)
    private let pauseLock = NSLock()

    private var processTapID = AudioObjectID.unknown
    private var aggregateDeviceID = AudioObjectID.unknown
    private var deviceProcID: AudioDeviceIOProcID?
    private var audioFile: AVAudioFile?
    private var audioConverter: AVAudioConverter?
    private var outputFormat: AVAudioFormat?
    private var didStop = false
    private var isPaused = false
    private var lastLevelEmit = Date.distantPast

    init(outputURL: URL?, statusURL: URL?, pidURL: URL?) {
        self.outputURL = outputURL
        self.statusURL = statusURL
        self.pidURL = pidURL
    }

    func writePid() {
        guard let pidURL else { return }
        try? "\(getpid())".write(to: pidURL, atomically: true, encoding: .utf8)
    }

    func pause() {
        pauseLock.lock()
        isPaused = true
        pauseLock.unlock()
        emit(["event": "paused"])
    }

    func resume() {
        pauseLock.lock()
        isPaused = false
        pauseLock.unlock()
        emit(["event": "resumed"])
    }

    func start() throws {
        if let outputURL {
            try? FileManager.default.removeItem(at: outputURL)
            try FileManager.default.createDirectory(at: outputURL.deletingLastPathComponent(), withIntermediateDirectories: true)
        }

        let tapDescription = CATapDescription(stereoGlobalTapButExcludeProcesses: [])
        tapDescription.uuid = UUID()
        tapDescription.muteBehavior = .unmuted
        tapDescription.name = "OS Notetaker System Audio"

        var tapID = AudioObjectID.unknown
        var err = AudioHardwareCreateProcessTap(tapDescription, &tapID)
        guard err == noErr else {
            throw "System audio permission or tap creation failed with error \(err)"
        }
        processTapID = tapID

        let systemOutputID = try AudioObjectID.readDefaultSystemOutputDevice()
        let outputUID = try systemOutputID.readDeviceUID()
        let aggregateUID = UUID().uuidString
        let description: [String: Any] = [
            kAudioAggregateDeviceNameKey: "OS Notetaker System Audio",
            kAudioAggregateDeviceUIDKey: aggregateUID,
            kAudioAggregateDeviceMainSubDeviceKey: outputUID,
            kAudioAggregateDeviceIsPrivateKey: true,
            kAudioAggregateDeviceIsStackedKey: false,
            kAudioAggregateDeviceTapAutoStartKey: true,
            kAudioAggregateDeviceSubDeviceListKey: [
                [kAudioSubDeviceUIDKey: outputUID]
            ],
            kAudioAggregateDeviceTapListKey: [
                [
                    kAudioSubTapDriftCompensationKey: true,
                    kAudioSubTapUIDKey: tapDescription.uuid.uuidString
                ]
            ]
        ]

        err = AudioHardwareCreateAggregateDevice(description as CFDictionary, &aggregateDeviceID)
        guard err == noErr else { throw "Failed to create aggregate audio device: \(err)" }

        var streamDescription = try tapID.readAudioTapStreamBasicDescription()
        guard let inputFormat = AVAudioFormat(streamDescription: &streamDescription) else {
            throw "Failed to create audio format for system tap."
        }
        guard let outputFormat = AVAudioFormat(commonFormat: .pcmFormatInt16, sampleRate: inputFormat.sampleRate, channels: inputFormat.channelCount, interleaved: true) else {
            throw "Failed to create output audio format."
        }
        guard let converter = AVAudioConverter(from: inputFormat, to: outputFormat) else {
            throw "Failed to create audio converter."
        }

        self.outputFormat = outputFormat
        audioConverter = converter
        if let outputURL {
            audioFile = try AVAudioFile(forWriting: outputURL, settings: outputFormat.settings, commonFormat: .pcmFormatInt16, interleaved: true)
        }

        err = AudioDeviceCreateIOProcIDWithBlock(&deviceProcID, aggregateDeviceID, queue) { [weak self] _, inputData, _, _, _ in
            guard let self else { return }
            self.pauseLock.lock()
            let paused = self.isPaused
            self.pauseLock.unlock()
            guard !paused else { return }
            guard let outputFormat = self.outputFormat, let converter = self.audioConverter else { return }
            guard let buffer = AVAudioPCMBuffer(pcmFormat: inputFormat, bufferListNoCopy: inputData, deallocator: nil) else { return }
            do {
                self.emitLevel(from: buffer)
                let frameCapacity = max(1, AVAudioFrameCount(Double(buffer.frameLength) * outputFormat.sampleRate / inputFormat.sampleRate))
                guard let convertedBuffer = AVAudioPCMBuffer(pcmFormat: outputFormat, frameCapacity: frameCapacity) else { return }
                var didProvideInput = false
                var conversionError: NSError?
                let status = converter.convert(to: convertedBuffer, error: &conversionError) { _, inputStatus in
                    if didProvideInput {
                        inputStatus.pointee = .noDataNow
                        return nil
                    }
                    didProvideInput = true
                    inputStatus.pointee = .haveData
                    return buffer
                }
                if let conversionError { throw conversionError }
                if status == .haveData || status == .inputRanDry, convertedBuffer.frameLength > 0, let audioFile = self.audioFile {
                    try audioFile.write(from: convertedBuffer)
                }
            } catch {
                self.emit(["event": "error", "message": error.localizedDescription])
            }
        }
        guard err == noErr else { throw "Failed to create audio IO callback: \(err)" }

        err = AudioDeviceStart(aggregateDeviceID, deviceProcID)
        guard err == noErr else { throw "Failed to start system audio capture: \(err)" }

        emit(["event": "ready", "output": outputURL?.path ?? "check"])
    }

    func stop() {
        guard !didStop else { return }
        didStop = true
        if aggregateDeviceID.isValid {
            AudioDeviceStop(aggregateDeviceID, deviceProcID)
            if let deviceProcID {
                AudioDeviceDestroyIOProcID(aggregateDeviceID, deviceProcID)
            }
            AudioHardwareDestroyAggregateDevice(aggregateDeviceID)
        }
        if processTapID.isValid {
            AudioHardwareDestroyProcessTap(processTapID)
        }
        audioFile = nil
        audioConverter = nil
        outputFormat = nil
        emit(["event": "stopped", "output": outputURL?.path ?? "check"])
    }

    private func emitLevel(from buffer: AVAudioPCMBuffer) {
        let now = Date()
        guard now.timeIntervalSince(lastLevelEmit) >= 0.08 else { return }
        lastLevelEmit = now
        let frameLength = Int(buffer.frameLength)
        let channelCount = Int(buffer.format.channelCount)
        guard frameLength > 0, channelCount > 0, let channels = buffer.floatChannelData else {
            emit(["event": "level", "level": "0"])
            return
        }
        var sum: Float = 0
        var count = 0
        for channelIndex in 0..<channelCount {
            let channel = channels[channelIndex]
            for frameIndex in 0..<frameLength {
                let sample = channel[frameIndex]
                sum += sample * sample
                count += 1
            }
        }
        let rms = count > 0 ? sqrt(sum / Float(count)) : 0
        emit(["event": "level", "level": String(min(1, Double(rms) * 4))])
    }

    private func emit(_ object: [String: String]) {
        let data = try! JSONSerialization.data(withJSONObject: object)
        print(String(data: data, encoding: .utf8)!)
        fflush(stdout)
        guard let statusURL else { return }
        try? data.write(to: statusURL)
    }
}

func argumentValue(_ name: String, from arguments: [String]) -> String? {
    guard let index = arguments.firstIndex(of: name), arguments.indices.contains(index + 1) else {
        return nil
    }
    return arguments[index + 1]
}

func emitProcessStatus(_ object: [String: String], statusPath: String?) {
    let data = try! JSONSerialization.data(withJSONObject: object)
    print(String(data: data, encoding: .utf8)!)
    fflush(stdout)
    guard let statusPath else { return }
    try? data.write(to: URL(fileURLWithPath: statusPath))
}

let statusPath = argumentValue("--status", from: CommandLine.arguments)

guard #available(macOS 14.2, *) else {
    emitProcessStatus(["event": "error", "message": "System audio recording requires macOS 14.2 or later."], statusPath: statusPath)
    exit(2)
}

let checkOnly = CommandLine.arguments.contains("--check")
let outputPath = argumentValue("--output", from: CommandLine.arguments)
let pidPath = argumentValue("--pid", from: CommandLine.arguments)
if !checkOnly && outputPath == nil {
    emitProcessStatus(["event": "error", "message": "Usage: os-notetaker-system-audio-recorder --output /path/to/recording.wav"], statusPath: statusPath)
    exit(2)
}

let recorder = SystemAudioRecorder(
    outputURL: outputPath.map { URL(fileURLWithPath: $0) },
    statusURL: statusPath.map { URL(fileURLWithPath: $0) },
    pidURL: pidPath.map { URL(fileURLWithPath: $0) }
)
recorder.writePid()

let terminateSource = DispatchSource.makeSignalSource(signal: SIGTERM, queue: .main)
let interruptSource = DispatchSource.makeSignalSource(signal: SIGINT, queue: .main)
let pauseSource = DispatchSource.makeSignalSource(signal: SIGUSR1, queue: .main)
let resumeSource = DispatchSource.makeSignalSource(signal: SIGUSR2, queue: .main)
signal(SIGTERM, SIG_IGN)
signal(SIGINT, SIG_IGN)
signal(SIGUSR1, SIG_IGN)
signal(SIGUSR2, SIG_IGN)

terminateSource.setEventHandler {
    recorder.stop()
    exit(0)
}
interruptSource.setEventHandler {
    recorder.stop()
    exit(0)
}
pauseSource.setEventHandler {
    recorder.pause()
}
resumeSource.setEventHandler {
    recorder.resume()
}
terminateSource.resume()
interruptSource.resume()
pauseSource.resume()
resumeSource.resume()

do {
    try recorder.start()
    if checkOnly {
        recorder.stop()
        exit(0)
    }
} catch {
    emitProcessStatus(["event": "error", "message": error.localizedDescription], statusPath: statusPath)
    exit(1)
}

dispatchMain()
