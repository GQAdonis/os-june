//! Synthetic paste + paste-target tracking, run in the main June process.
//!
//! Part of moving Accessibility off the dictation helper: the synthetic Cmd+V
//! that inserts a transcript needs the Accessibility grant, so doing it here
//! (rather than in the helper) makes `June.app` the sole Accessibility subject.
//! [`remember_focus_target`] records the app that was frontmost when dictation
//! started so the paste lands there even if a June window grabbed focus.

#[cfg(target_os = "macos")]
mod imp {
    use objc2::rc::Retained;
    use objc2::runtime::ProtocolObject;
    use objc2_app_kit::{
        NSApplicationActivationOptions, NSPasteboard, NSPasteboardItem, NSPasteboardTypeString,
        NSPasteboardWriting, NSRunningApplication, NSWorkspace,
    };
    use objc2_foundation::{NSArray, NSData, NSString};
    use std::ffi::c_void;
    use std::sync::atomic::{AtomicI32, Ordering};
    use std::thread;
    use std::time::Duration;

    // --- CoreGraphics synthetic keystroke (Cmd+V) -------------------------
    type CGEventSourceRef = *mut c_void;
    type CGEventRef = *mut c_void;

    const KEY_V: u16 = 9; // kVK_ANSI_V
    const FLAG_COMMAND: u64 = 1 << 20; // kCGEventFlagMaskCommand
    const HID_SYSTEM_STATE: i32 = 1; // kCGEventSourceStateHIDSystemState
    const HID_EVENT_TAP: u32 = 0; // kCGHIDEventTap

    #[link(name = "CoreGraphics", kind = "framework")]
    extern "C" {
        fn CGEventSourceCreate(state_id: i32) -> CGEventSourceRef;
        fn CGEventCreateKeyboardEvent(
            source: CGEventSourceRef,
            virtual_key: u16,
            key_down: bool,
        ) -> CGEventRef;
        fn CGEventSetFlags(event: CGEventRef, flags: u64);
        fn CGEventPost(tap: u32, event: CGEventRef);
    }

    #[link(name = "CoreFoundation", kind = "framework")]
    extern "C" {
        fn CFRelease(cf: *const c_void);
    }

    /// PID of the app that was frontmost when dictation started. 0 = unset.
    static FOCUS_TARGET_PID: AtomicI32 = AtomicI32::new(0);

    /// Record the frontmost application as the paste target. Called when
    /// dictation starts (a shortcut press) — at that point the user's target
    /// app is frontmost, not June. June itself is never recorded as the target.
    pub fn remember_focus_target() {
        let workspace = NSWorkspace::sharedWorkspace();
        if let Some(app) = workspace.frontmostApplication() {
            let pid = app.processIdentifier();
            if pid != std::process::id() as i32 {
                FOCUS_TARGET_PID.store(pid, Ordering::Relaxed);
            }
        }
    }

    /// Bring the recorded target app back to the front before pasting, so a
    /// June window that grabbed focus mid-recording doesn't swallow the Cmd+V.
    fn activate_focus_target() {
        let pid = FOCUS_TARGET_PID.load(Ordering::Relaxed);
        if pid == 0 {
            return;
        }
        if let Some(app) = NSRunningApplication::runningApplicationWithProcessIdentifier(pid) {
            app.activateWithOptions(NSApplicationActivationOptions::empty());
            // Give the app a beat to come forward before the keystroke lands.
            thread::sleep(Duration::from_millis(120));
        }
    }

    /// Post a synthetic Cmd+V to the frontmost app via the HID event tap —
    /// mirrors the helper's `postPasteShortcut`. Requires the Accessibility
    /// grant, which is now held by this process.
    fn post_paste_shortcut() {
        // SAFETY: standard CoreGraphics event-posting sequence; every event we
        // create with a Create-rule function is released after posting.
        unsafe {
            let source = CGEventSourceCreate(HID_SYSTEM_STATE);
            let key_down = CGEventCreateKeyboardEvent(source, KEY_V, true);
            let key_up = CGEventCreateKeyboardEvent(source, KEY_V, false);
            if !key_down.is_null() {
                CGEventSetFlags(key_down, FLAG_COMMAND);
                CGEventPost(HID_EVENT_TAP, key_down);
                CFRelease(key_down);
            }
            if !key_up.is_null() {
                CGEventSetFlags(key_up, FLAG_COMMAND);
                CGEventPost(HID_EVENT_TAP, key_up);
                CFRelease(key_up);
            }
            if !source.is_null() {
                CFRelease(source);
            }
        }
    }

    /// The general pasteboard captured as plain bytes, preserving each item
    /// separately (a clipboard can hold several items, e.g. multiple copied
    /// files). Plain Rust data is `Send`, so the delayed restore can run on a
    /// background thread.
    type Snapshot = Vec<Vec<(String, Vec<u8>)>>;

    fn capture(pasteboard: &NSPasteboard) -> Snapshot {
        let mut items = Vec::new();
        if let Some(pasteboard_items) = pasteboard.pasteboardItems() {
            for item in pasteboard_items.iter() {
                let mut entries = Vec::new();
                for ty in item.types().iter() {
                    if let Some(data) = item.dataForType(&ty) {
                        entries.push((ty.to_string(), data.to_vec()));
                    }
                }
                items.push(entries);
            }
        }
        items
    }

    fn restore(pasteboard: &NSPasteboard, items: &Snapshot) {
        pasteboard.clearContents();
        if items.is_empty() {
            return;
        }
        let restored: Vec<Retained<ProtocolObject<dyn NSPasteboardWriting>>> = items
            .iter()
            .map(|entries| {
                let item = NSPasteboardItem::new();
                for (ty, bytes) in entries {
                    let data = NSData::with_bytes(bytes);
                    let ty = NSString::from_str(ty);
                    item.setData_forType(&data, &ty);
                }
                ProtocolObject::from_retained(item)
            })
            .collect();
        let array = NSArray::from_retained_slice(&restored);
        pasteboard.writeObjects(&array);
    }

    /// Place `text` on the clipboard, bring the recorded target app forward,
    /// paste with a synthetic Cmd+V, then restore the prior clipboard once the
    /// paste has landed (only if it hasn't changed since). Mirrors the helper's
    /// `PasteboardInserter.paste`.
    pub fn paste(text: &str) {
        let pasteboard = NSPasteboard::generalPasteboard();
        let snapshot = capture(&pasteboard);

        pasteboard.clearContents();
        let ns_text = NSString::from_str(text);
        // NSPasteboardTypeString is an extern static (unsafe to read); the
        // pasteboard methods themselves are safe.
        let string_type = unsafe { NSPasteboardTypeString };
        let wrote = pasteboard.setString_forType(&ns_text, string_type);
        if !wrote {
            restore(&pasteboard, &snapshot);
            return;
        }

        activate_focus_target();
        post_paste_shortcut();

        // Restore the user's clipboard once the paste has had time to land,
        // and only if our transcript is still what's on it (don't stomp on a
        // copy the user made in the meantime).
        let text_owned = text.to_string();
        thread::spawn(move || {
            thread::sleep(Duration::from_millis(700));
            let pasteboard = NSPasteboard::generalPasteboard();
            let string_type = unsafe { NSPasteboardTypeString };
            let current = pasteboard.stringForType(string_type);
            let still_ours = current
                .map(|value| value.to_string() == text_owned)
                .unwrap_or(false);
            if still_ours {
                restore(&pasteboard, &snapshot);
            }
        });
    }
}

/// Record the frontmost app as the paste target (call when dictation starts).
/// No-op off macOS.
pub fn remember_focus_target() {
    #[cfg(target_os = "macos")]
    {
        imp::remember_focus_target();
    }
}

/// Paste `text` into the recorded target application. No-op off macOS.
pub fn paste(text: &str) {
    #[cfg(target_os = "macos")]
    {
        imp::paste(text);
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = text;
    }
}
