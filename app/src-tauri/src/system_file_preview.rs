//! Use the same registered thumbnail providers as Windows Explorer. No format
//! whitelist and no format-specific decoder: RDC and other custom formats work
//! when their application has installed a Shell thumbnail provider.

#[cfg(windows)]
pub(crate) fn thumbnail(path: &std::path::Path) -> Option<Vec<u8>> {
    use windows::core::PCWSTR;
    use windows::Win32::Foundation::SIZE;
    use windows::Win32::Graphics::Gdi::*;
    use windows::Win32::System::Com::{CoInitializeEx, CoUninitialize, COINIT_APARTMENTTHREADED};
    use windows::Win32::UI::Shell::{
        IShellItemImageFactory, SHCreateItemFromParsingName, SIIGBF_THUMBNAILONLY,
    };
    use std::os::windows::ffi::OsStrExt;

    struct Apartment;
    impl Drop for Apartment {
        fn drop(&mut self) { unsafe { CoUninitialize() }; }
    }
    struct Bitmap(HBITMAP);
    impl Drop for Bitmap {
        fn drop(&mut self) { let _ = unsafe { DeleteObject(HGDIOBJ(self.0.0)) }; }
    }
    struct Dc(HDC);
    impl Drop for Dc {
        fn drop(&mut self) { let _ = unsafe { DeleteDC(self.0) }; }
    }

    // Called from a blocking worker, never the webview thread. A failed COM
    // apartment setup simply leaves the normal binary-file fallback in place.
    unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED) }.ok().ok()?;
    let _apartment = Apartment;
    // Shell parsing requires ordinary Windows separators and paths, whereas
    // canonicalize returns the extended-length \\?\ spelling.
    let mut wide: Vec<u16> = path.as_os_str().encode_wide()
        .map(|ch| if ch == b'/' as u16 { b'\\' as u16 } else { ch }).collect();
    if wide.starts_with(&[92, 92, 63, 92, 85, 78, 67, 92]) {
        wide.splice(..8, [92, 92]);
    } else if wide.starts_with(&[92, 92, 63, 92]) {
        wide.drain(..4);
    }
    wide.push(0);
    let factory: IShellItemImageFactory = unsafe {
        SHCreateItemFromParsingName(PCWSTR(wide.as_ptr()), None)
    }.ok()?;
    // THUMBNAILONLY avoids misrepresenting a generic application icon as a
    // file preview. Missing providers and provider errors are ordinary fallback.
    let bitmap = Bitmap(unsafe {
        factory.GetImage(SIZE { cx: 1024, cy: 1024 }, SIIGBF_THUMBNAILONLY)
    }.ok()?);
    let mut object = BITMAP::default();
    if unsafe { GetObjectW(HGDIOBJ(bitmap.0.0), std::mem::size_of::<BITMAP>() as i32,
        Some((&mut object as *mut BITMAP).cast())) } == 0 {
        return None;
    }
    let width = u32::try_from(object.bmWidth).ok()?;
    let height = u32::try_from(object.bmHeight).ok()?;
    if width == 0 || height == 0 || width > 4096 || height > 4096 { return None; }
    let dc = Dc(unsafe { CreateCompatibleDC(None) });
    if dc.0.0.is_null() { return None; }
    let mut info = BITMAPINFO::default();
    info.bmiHeader.biSize = std::mem::size_of::<BITMAPINFOHEADER>() as u32;
    info.bmiHeader.biWidth = width as i32;
    info.bmiHeader.biHeight = -(height as i32); // top-down rows
    info.bmiHeader.biPlanes = 1;
    info.bmiHeader.biBitCount = 32;
    info.bmiHeader.biCompression = BI_RGB.0;
    let mut bgra = vec![0u8; width as usize * height as usize * 4];
    if unsafe { GetDIBits(dc.0, bitmap.0, 0, height, Some(bgra.as_mut_ptr().cast()),
        &mut info, DIB_RGB_COLORS) } != height as i32 {
        return None;
    }
    // Some providers return a 32-bit bitmap whose alpha channel is all zero.
    let opaque = bgra.chunks_exact(4).all(|pixel| pixel[3] == 0);
    for pixel in bgra.chunks_exact_mut(4) {
        pixel.swap(0, 2);
        if opaque { pixel[3] = 255; }
    }
    let image = image::RgbaImage::from_raw(width, height, bgra)?;
    let mut png = std::io::Cursor::new(Vec::new());
    image.write_to(&mut png, image::ImageFormat::Png).ok()?;
    Some(png.into_inner())
}

#[cfg(not(windows))]
pub(crate) fn thumbnail(_path: &std::path::Path) -> Option<Vec<u8>> { None }

#[cfg(all(test, windows))]
mod tests {
    #[test]
    fn missing_file_has_no_system_thumbnail() {
        assert!(super::thumbnail(std::path::Path::new("Z:\\ugs-missing\\capture.rdc")).is_none());
    }

    // Opt-in integration test exercises the actual registered Shell provider,
    // not a mocked thumbnail. Output doubles as the visual verification input.
    #[test]
    fn real_shell_thumbnail() {
        let Ok(path) = std::env::var("UGS_TEST_SHELL_FILE") else { return; };
        let png = super::thumbnail(std::path::Path::new(&path)).expect("Shell thumbnail unavailable");
        let image = image::load_from_memory(&png).unwrap();
        assert!(image.width() > 0 && image.height() > 0);
        if let Ok(output) = std::env::var("UGS_TEST_SHELL_OUTPUT") {
            std::fs::write(output, png).unwrap();
        }
    }
}
