//! 参考表（reference sheet）：把多张参考图合成为**一张**图。
//!
//! 背景：厂商原生图生图只接受一张参考图，而关键帧首帧需要「角色参考图 +
//! 场景参考图 + 画风锚」同时生效（spec §5.5、决策点 4）。所以在本地把多张
//! 参考图按固定网格拼成一张，交给厂商原生图生图，分区含义由前端写进提示词。
//!
//! 布局规则是**跨端约定**：前端 `frameOps.refSheetCells()` 按同一规则生成分区
//! 标注文案，两边各有一组单测把这套规则钉死（改动必须两边同步）。

use crate::error::{AppError, AppResult};
use image::{imageops, DynamicImage, ImageFormat, Rgba, RgbaImage};
use std::io::Cursor;

/// 单张参考表最多容纳的参考图数量（超过就不再拼，直接报错）。
pub const MAX_REFS: usize = 4;

/// 拼图底色：中性深灰。既区别于纯黑（避免被当作画面留黑边），
/// 又能让空单元格一眼可辨。
const SHEET_BACKGROUND: Rgba<u8> = Rgba([32, 32, 36, 255]);

/// 参考图数量 → 网格 `(列, 行)`；数量不在支持范围内时返回 `None`。
///
/// - 2 张：左右并排；
/// - 3 / 4 张：2×2 网格（3 张时右下角留底色）。
pub fn layout_for(count: usize) -> Option<(u32, u32)> {
    match count {
        0 => None,
        1 => Some((1, 1)),
        2 => Some((2, 1)),
        3 | 4 => Some((2, 2)),
        _ => None,
    }
}

/// 把若干张（已解码前的）参考图字节拼成一张 `width × height` 的 PNG。
///
/// 每张图等比缩放后居中放进自己的单元格；单元格之间不留缝，最后一列 / 行
/// 吸收整除余数，保证画布右下边缘不出现空白条。
pub fn compose(refs: &[Vec<u8>], width: u32, height: u32) -> AppResult<Vec<u8>> {
    let (cols, rows) = layout_for(refs.len()).ok_or_else(|| AppError::Validation {
        field: "refImages".into(),
        detail: format!(
            "cannot compose {} reference images (1..={MAX_REFS})",
            refs.len()
        ),
    })?;
    if width < cols || height < rows {
        return Err(AppError::Validation {
            field: "size".into(),
            detail: format!("canvas {width}x{height} is too small for a {cols}x{rows} grid"),
        });
    }

    let mut canvas = RgbaImage::from_pixel(width, height, SHEET_BACKGROUND);

    for (index, bytes) in refs.iter().enumerate() {
        let (x, y, cell_w, cell_h) = cell_rect(index, cols, rows, width, height);
        let decoded = image::load_from_memory(bytes).map_err(|e| AppError::Validation {
            field: "refImages".into(),
            detail: format!("cannot decode reference #{}: {e}", index + 1),
        })?;
        let fitted = decoded.resize(cell_w, cell_h, imageops::FilterType::Lanczos3);
        let left = x + (cell_w - fitted.width()) / 2;
        let top = y + (cell_h - fitted.height()) / 2;
        imageops::overlay(&mut canvas, &fitted, i64::from(left), i64::from(top));
    }

    let mut buffer = Cursor::new(Vec::new());
    DynamicImage::ImageRgba8(canvas)
        .write_to(&mut buffer, ImageFormat::Png)
        .map_err(|e| AppError::Internal(format!("encode reference sheet: {e}")))?;
    Ok(buffer.into_inner())
}

/// 第 `index` 个单元格的 `(x, y, 宽, 高)`（行优先填充）。
fn cell_rect(index: usize, cols: u32, rows: u32, width: u32, height: u32) -> (u32, u32, u32, u32) {
    let col = index as u32 % cols;
    let row = index as u32 / cols;
    let cell_w = width / cols;
    let cell_h = height / rows;
    let x = col * cell_w;
    let y = row * cell_h;
    let w = if col + 1 == cols { width - x } else { cell_w };
    let h = if row + 1 == rows { height - y } else { cell_h };
    (x, y, w, h)
}

#[cfg(test)]
mod tests {
    //! 覆盖 spec 要求的三件事：**尺寸**、**分区**、**边缘**。

    use super::*;
    use image::{ImageBuffer, Rgb};

    /// 一张纯色 PNG，用作可辨识的参考图。
    fn solid_png(w: u32, h: u32, color: [u8; 3]) -> Vec<u8> {
        let image = ImageBuffer::<Rgb<u8>, _>::from_pixel(w, h, Rgb(color));
        let mut buffer = Cursor::new(Vec::new());
        DynamicImage::ImageRgb8(image)
            .write_to(&mut buffer, ImageFormat::Png)
            .unwrap();
        buffer.into_inner()
    }

    fn decode(bytes: &[u8]) -> RgbaImage {
        image::load_from_memory(bytes).unwrap().to_rgba8()
    }

    #[test]
    fn layout_matches_the_cross_language_convention() {
        assert_eq!(layout_for(0), None);
        assert_eq!(layout_for(1), Some((1, 1)));
        assert_eq!(layout_for(2), Some((2, 1)));
        assert_eq!(layout_for(3), Some((2, 2)));
        assert_eq!(layout_for(4), Some((2, 2)));
        assert_eq!(layout_for(5), None);
    }

    #[test]
    fn sheet_keeps_the_requested_canvas_size() {
        let refs = vec![
            solid_png(64, 64, [255, 0, 0]),
            solid_png(64, 64, [0, 255, 0]),
            solid_png(64, 64, [0, 0, 255]),
        ];
        let sheet = decode(&compose(&refs, 864, 1536).unwrap());
        assert_eq!((sheet.width(), sheet.height()), (864, 1536));
    }

    #[test]
    fn each_reference_lands_in_its_own_cell() {
        // 2 张 → 左右各占一半，中心像素应分别是左右两张图的颜色。
        let refs = vec![
            solid_png(64, 64, [255, 0, 0]),
            solid_png(64, 64, [0, 0, 255]),
        ];
        let sheet = decode(&compose(&refs, 800, 400).unwrap());

        let left = sheet.get_pixel(200, 200);
        let right = sheet.get_pixel(600, 200);
        assert!(left[0] > 200 && left[2] < 60, "左格应为红：{left:?}");
        assert!(right[2] > 200 && right[0] < 60, "右格应为蓝：{right:?}");
    }

    #[test]
    fn third_reference_goes_to_the_bottom_left_cell() {
        let refs = vec![
            solid_png(64, 64, [255, 0, 0]),
            solid_png(64, 64, [0, 255, 0]),
            solid_png(64, 64, [0, 0, 255]),
        ];
        let sheet = decode(&compose(&refs, 800, 800).unwrap());

        let top_left = sheet.get_pixel(200, 200);
        let top_right = sheet.get_pixel(600, 200);
        let bottom_left = sheet.get_pixel(200, 600);
        let bottom_right = *sheet.get_pixel(600, 600);
        assert!(top_left[0] > 200, "左上应为红：{top_left:?}");
        assert!(top_right[1] > 200, "右上应为绿：{top_right:?}");
        assert!(bottom_left[2] > 200, "左下应为蓝：{bottom_left:?}");
        assert_eq!(bottom_right, SHEET_BACKGROUND, "右下空位应为底色");
    }

    #[test]
    fn bottom_right_edge_is_opaque_and_gap_free() {
        // 尺寸取 3 的倍数以外的值，验证余数被最后一列 / 行吸收。
        let refs = vec![
            solid_png(8, 8, [255, 255, 255]),
            solid_png(8, 8, [255, 255, 255]),
            solid_png(8, 8, [255, 255, 255]),
        ];
        let sheet = decode(&compose(&refs, 865, 1537).unwrap());
        assert_eq!((sheet.width(), sheet.height()), (865, 1537));

        for (x, y) in [(864, 1536), (864, 0), (0, 1536)] {
            let pixel = *sheet.get_pixel(x, y);
            assert_eq!(pixel[3], 255, "({x},{y}) 不应是透明像素");
            assert_ne!(pixel, Rgba([0, 0, 0, 0]), "({x},{y}) 不应是空白");
        }
    }

    #[test]
    fn unsupported_counts_and_canvases_are_rejected() {
        assert_eq!(compose(&[], 800, 800).unwrap_err().code(), "validation");
        let five = vec![solid_png(8, 8, [1, 2, 3]); 5];
        assert_eq!(compose(&five, 800, 800).unwrap_err().code(), "validation");
        // 画布比网格还小，切不出单元格。
        let two = vec![solid_png(8, 8, [1, 2, 3]); 2];
        assert_eq!(compose(&two, 1, 8).unwrap_err().code(), "validation");
    }

    #[test]
    fn undecodable_reference_is_reported_as_validation() {
        let refs = vec![solid_png(8, 8, [1, 2, 3]), b"not-an-image".to_vec()];
        let error = compose(&refs, 800, 800).unwrap_err();
        assert_eq!(error.code(), "validation");
        assert!(error.to_string().contains("#2"), "{error}");
    }
}
