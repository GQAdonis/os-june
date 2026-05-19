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

    func read<T>(_ inAddress: AudioObjectPropertyAddress, defaultValue: T) throws -> T {
        var address = inAddress
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
    private let streamAudio: Bool
    private let streamPort: Int?
    private let queue = DispatchQueue(label: "ai.os-notepad.system-audio-recorder", qos: .userInitiated)

    private var processTapID = AudioObjectID.unknown
    private var aggregateDeviceID = AudioObjectID.unknown
    private var deviceProcID: AudioDeviceIOProcID?
    private var audioFile: AVAudioFile?
    private var audioConverter: AVAudioConverter?
    private var outputFormat: AVAudioFormat?
    private var didStop = false
    private var lastLevelEmit = Date.distantPast

    init(outputURL: URL?, statusURL: URL?, pidURL: URL?, streamAudio: Bool, streamPort: Int?) {
        self.outputURL = outputURL
        self.statusURL = statusURL
        self.pidURL = pidURL
        self.streamAudio = streamAudio
        self.streamPort = streamPort
    }

    func writePid() {
        guard let pidURL else { return }
        try? "\(getpid())".write(to: pidURL, atomically: true, encoding: .utf8)
    }

    func start() throws {
        if let outputURL {
            try? FileManager.default.removeItem(at: outputURL)
        }
        if streamAudio, let streamPort {
            try EventStream.shared.connect(port: streamPort)
        }

        let tapDescription = CATapDescription(stereoGlobalTapButExcludeProcesses: [])
        tapDescription.uuid = UUID()
        tapDescription.muteBehavior = .unmuted
        tapDescription.name = "OS Notepad System Audio"

        var tapID = AudioObjectID.unknown
        var err = AudioHardwareCreateProcessTap(tapDescription, &tapID)
        guard err == noErr else {
            throw "System audio tap creation failed with error \(err)"
        }
        processTapID = tapID

        let systemOutputID = try AudioObjectID.readDefaultSystemOutputDevice()
        let outputUID = try systemOutputID.readDeviceUID()
        let aggregateUID = UUID().uuidString
        let description: [String: Any] = [
            kAudioAggregateDeviceNameKey: "OS Notepad System Audio",
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

        aggregateDeviceID = AudioObjectID.unknown
        err = AudioHardwareCreateAggregateDevice(description as CFDictionary, &aggregateDeviceID)
        guard err == noErr else {
            throw "Failed to create aggregate audio device: \(err)"
        }

        var streamDescription = try tapID.readAudioTapStreamBasicDescription()
        guard let format = AVAudioFormat(streamDescription: &streamDescription) else {
            throw "Failed to create audio format for system tap."
        }
        let outputSampleRate = streamAudio ? 24_000 : format.sampleRate
        let outputChannels = streamAudio ? 1 : format.channelCount
        guard let outputFormat = AVAudioFormat(commonFormat: .pcmFormatInt16, sampleRate: outputSampleRate, channels: outputChannels, interleaved: true) else {
            throw "Failed to create output audio format."
        }
        guard let converter = AVAudioConverter(from: format, to: outputFormat) else {
            throw "Failed to create audio converter."
        }

        self.outputFormat = outputFormat
        audioConverter = converter
        if let outputURL {
            audioFile = try AVAudioFile(forWriting: outputURL, settings: outputFormat.settings, commonFormat: .pcmFormatInt16, interleaved: true)
        }

        err = AudioDeviceCreateIOProcIDWithBlock(&deviceProcID, aggregateDeviceID, queue) { [weak self] _, inputData, _, _, _ in
            guard let self, let outputFormat = self.outputFormat, let converter = self.audioConverter else { return }
            guard let buffer = AVAudioPCMBuffer(pcmFormat: format, bufferListNoCopy: inputData, deallocator: nil) else { return }
            do {
                self.emitLevel(from: buffer)
                let frameCapacity = max(1, AVAudioFrameCount(Double(buffer.frameLength) * outputFormat.sampleRate / format.sampleRate))
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
                if let conversionError {
                    throw conversionError
                }
                if status == .haveData || status == .inputRanDry, convertedBuffer.frameLength > 0 {
                    if self.streamAudio {
                        self.emitAudio(from: convertedBuffer)
                    } else if let audioFile = self.audioFile {
                        try audioFile.write(from: convertedBuffer)
                    }
                }
            } catch {
                self.emit(["event": "error", "message": error.localizedDescription])
            }
        }
        guard err == noErr else { throw "Failed to create audio IO callback: \(err)" }

        err = AudioDeviceStart(aggregateDeviceID, deviceProcID)
        guard err == noErr else { throw "Failed to start system audio capture: \(err)" }

        if let outputURL {
            emit(["event": "ready", "output": outputURL.path])
        } else {
            emit(["event": "ready", "mode": "stream"])
        }
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
        if let outputURL {
            emit(["event": "stopped", "output": outputURL.path])
        } else {
            emit(["event": "stopped", "mode": "stream"])
        }
    }

    private func emit(_ object: [String: String]) {
        printJSON(object)
        guard let statusURL, let data = try? JSONSerialization.data(withJSONObject: object) else { return }
        try? data.write(to: statusURL)
    }

    private func emitLevel(from buffer: AVAudioPCMBuffer) {
        let now = Date()
        guard now.timeIntervalSince(lastLevelEmit) >= 0.08 else { return }
        lastLevelEmit = now

        let frameLength = Int(buffer.frameLength)
        let channelCount = Int(buffer.format.channelCount)
        guard frameLength > 0, channelCount > 0, let channels = buffer.floatChannelData else {
            printJSON(["event": "level", "level": 0])
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
        let level = min(1, Double(rms) * 4)
        printJSON(["event": "level", "level": level])
    }

    private func emitAudio(from buffer: AVAudioPCMBuffer) {
        let audioBuffer = buffer.audioBufferList.pointee.mBuffers
        guard let dataPointer = audioBuffer.mData else { return }
        let byteCount = Int(audioBuffer.mDataByteSize)
        guard byteCount > 0 else { return }

        let data = Data(bytes: dataPointer, count: byteCount)
        EventStream.shared.write([
            "event": "audio",
            "format": "pcm16",
            "sampleRate": Int(buffer.format.sampleRate),
            "channels": Int(buffer.format.channelCount),
            "data": data.base64EncodedString()
        ])
    }
}

final class EventStream {
    static let shared = EventStream()
    private var socketFD: Int32 = -1
    private let lock = NSLock()

    func connect(port: Int) throws {
        lock.lock()
        defer { lock.unlock() }
        if socketFD >= 0 { return }

        let fd = socket(AF_INET, SOCK_STREAM, 0)
        guard fd >= 0 else { throw "Failed to create stream socket." }

        var address = sockaddr_in()
        address.sin_family = sa_family_t(AF_INET)
        address.sin_port = in_port_t(port).bigEndian
        address.sin_addr = in_addr(s_addr: inet_addr("127.0.0.1"))

        let result = withUnsafePointer(to: &address) { pointer in
            pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) { sockaddrPointer in
                Darwin.connect(fd, sockaddrPointer, socklen_t(MemoryLayout<sockaddr_in>.size))
            }
        }

        guard result == 0 else {
            Darwin.close(fd)
            throw "Failed to connect system audio stream socket."
        }
        socketFD = fd
    }

    func write(_ object: [String: Any]) {
        guard let data = try? JSONSerialization.data(withJSONObject: object) else { return }
        var payload = data
        payload.append(0x0a)

        lock.lock()
        defer { lock.unlock() }
        guard socketFD >= 0 else { return }
        payload.withUnsafeBytes { rawBuffer in
            guard let baseAddress = rawBuffer.baseAddress else { return }
            _ = Darwin.write(socketFD, baseAddress, rawBuffer.count)
        }
    }

    func close() {
        lock.lock()
        defer { lock.unlock() }
        if socketFD >= 0 {
            Darwin.close(socketFD)
            socketFD = -1
        }
    }
}

func printJSON(_ object: [String: Any]) {
    let data = try! JSONSerialization.data(withJSONObject: object)
    print(String(data: data, encoding: .utf8)!)
    fflush(stdout)
}

func argumentValue(_ name: String, from arguments: [String]) -> String? {
    guard let index = arguments.firstIndex(of: name), arguments.indices.contains(index + 1) else {
        return nil
    }
    return arguments[index + 1]
}

guard #available(macOS 14.2, *) else {
    printJSON(["event": "error", "message": "System audio recording requires macOS 14.2 or later."])
    exit(2)
}

let streamAudio = CommandLine.arguments.contains("--stream")
let outputPath = argumentValue("--output", from: CommandLine.arguments)
let streamPort = argumentValue("--stream-port", from: CommandLine.arguments).flatMap(Int.init)
if !streamAudio && outputPath == nil {
    printJSON(["event": "error", "message": "Usage: os-notepad-recorder --output /path/to/recording.wav [--stream --stream-port PORT] [--status /path/status.json] [--pid /path/pid.txt]"])
    exit(2)
}
if streamAudio && streamPort == nil {
    printJSON(["event": "error", "message": "Streaming system audio requires --stream-port."])
    exit(2)
}

let recorder = SystemAudioRecorder(
    outputURL: outputPath.map { URL(fileURLWithPath: $0) },
    statusURL: argumentValue("--status", from: CommandLine.arguments).map { URL(fileURLWithPath: $0) },
    pidURL: argumentValue("--pid", from: CommandLine.arguments).map { URL(fileURLWithPath: $0) },
    streamAudio: streamAudio,
    streamPort: streamPort
)
recorder.writePid()

let signalSource = DispatchSource.makeSignalSource(signal: SIGINT, queue: .main)
let terminateSource = DispatchSource.makeSignalSource(signal: SIGTERM, queue: .main)
signal(SIGINT, SIG_IGN)
signal(SIGTERM, SIG_IGN)

signalSource.setEventHandler {
    recorder.stop()
    EventStream.shared.close()
    exit(0)
}
terminateSource.setEventHandler {
    recorder.stop()
    EventStream.shared.close()
    exit(0)
}
signalSource.resume()
terminateSource.resume()

do {
    try recorder.start()
} catch {
    printJSON(["event": "error", "message": error.localizedDescription])
    exit(1)
}

dispatchMain()
