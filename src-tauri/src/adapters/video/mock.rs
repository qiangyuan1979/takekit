//! 本地模拟视频适配器（M7）：没有 API Key 也能把「生成」这一步走完。
//!
//! 它不联网、不读磁盘，只在内存里维护一小张"任务进度表"：
//! `submit` 记下这条任务要轮询几次才成功，`poll` 每被问一次就推进一格，
//! 到点了就吐出一个 `mock://` 假的下载地址，`fetch` 再按这个地址现画一张
//! 带渐变色的占位图交差。
//!
//! 两条由**提示词里的小标记**触发的特殊行为，让用户可以手动演示失败与
//! "等很久"这两条分支（前端会把它们写进新手引导）：
//! - 提示词含 `#fail` → 轮询到点时返回"审核未通过"，用于演示失败重试；
//! - 提示词含 `#slow` → 需要多轮询几次才成功，用于演示"长时间排队"。
//!
//! 产物是 PNG 占位图而非真视频，这是有意为之的**诚实妥协**：编一段假 mp4
//! 只会让预览器报错。前端按扩展名决定用 `<img>` 还是 `<video>` 展示，
//! 并明确标注"模拟产物"。

use super::{
    Polled, Submitted, VideoCredentials, VideoGenerator, VideoOutput, VideoRequest, VideoStatus,
};
use crate::error::{AppError, AppResult};
use futures_util::future::BoxFuture;
use image::{DynamicImage, ImageBuffer, ImageFormat, Rgb};
use std::collections::HashMap;
use std::io::Cursor;
use std::sync::Mutex;

/// 适配器标识。
pub const NAME: &str = "mock";

/// 默认需要几轮轮询才"生成完毕"。
const POLLS_BEFORE_SUCCESS: u32 = 2;

/// 提示词含该标记时演示失败分支。
const FAIL_MARKER: &str = "#fail";

/// 提示词含该标记时演示排队较久。
const SLOW_MARKER: &str = "#slow";

/// 演示"排队较久"时需要的轮询次数。
const SLOW_POLLS: u32 = 6;

/// 占位图尺寸（16:9，够小但仍能看清）。
const PLACEHOLDER_W: u32 = 480;
const PLACEHOLDER_H: u32 = 270;

/// 内存里的一条模拟任务。
struct MockTask {
    /// 已经被问过几次。
    polls: u32,
    /// 攒够几次才算成功。
    needed: u32,
    /// 到点时是否转为失败态。
    fail: bool,
}

/// 本地模拟视频生成器。
pub struct MockVideoGenerator {
    /// 短临界区、且不跨 `await`，用标准库锁即可（不引入 `tokio::sync`）。
    tasks: Mutex<HashMap<String, MockTask>>,
}

impl MockVideoGenerator {
    /// 接入配置对模拟器无意义（免 Key 可用），签名保持与真机适配器一致。
    pub fn new(_credentials: &VideoCredentials) -> Self {
        Self {
            tasks: Mutex::new(HashMap::new()),
        }
    }
}

impl VideoGenerator for MockVideoGenerator {
    fn name(&self) -> &'static str {
        NAME
    }

    fn submit<'a>(&'a self, request: &'a VideoRequest) -> BoxFuture<'a, AppResult<Submitted>> {
        Box::pin(async move {
            let task_id = format!("mock-{}", crate::project::new_id());
            let prompt = &request.prompt;
            let task = MockTask {
                polls: 0,
                needed: if prompt.contains(SLOW_MARKER) {
                    SLOW_POLLS
                } else {
                    POLLS_BEFORE_SUCCESS
                },
                fail: prompt.contains(FAIL_MARKER),
            };
            self.tasks
                .lock()
                .map_err(|_| lock_poisoned())?
                .insert(task_id.clone(), task);
            Ok(Submitted {
                handle: task_id.clone(),
                task_id,
            })
        })
    }

    fn poll<'a>(&'a self, handle: &'a str) -> BoxFuture<'a, AppResult<Polled>> {
        Box::pin(async move {
            let mut tasks = self.tasks.lock().map_err(|_| lock_poisoned())?;
            let task = tasks.get_mut(handle).ok_or_else(|| AppError::NotFound {
                path: format!("mock task `{handle}`"),
            })?;
            task.polls += 1;
            if task.polls < task.needed {
                return Ok(Polled {
                    status: VideoStatus::Running,
                    video_url: None,
                    error: None,
                });
            }
            if task.fail {
                return Ok(Polled {
                    status: VideoStatus::Failed,
                    video_url: None,
                    error: Some("模拟：内容审核未通过，建议改写提示词后重试。".into()),
                });
            }
            Ok(Polled {
                status: VideoStatus::Succeeded,
                video_url: Some(format!("mock://clip/{handle}")),
                error: None,
            })
        })
    }

    fn fetch<'a>(&'a self, url: &'a str) -> BoxFuture<'a, AppResult<VideoOutput>> {
        Box::pin(async move {
            Ok(VideoOutput {
                bytes: placeholder_png(url)?,
                mime: "image/png".into(),
            })
        })
    }

    fn cancel<'a>(&'a self, handle: &'a str) -> BoxFuture<'a, AppResult<()>> {
        Box::pin(async move {
            self.tasks
                .lock()
                .map_err(|_| lock_poisoned())?
                .remove(handle);
            Ok(())
        })
    }
}

/// 锁中毒（持锁线程 panic）在模拟器里不该发生，兜底成内部错误。
fn lock_poisoned() -> AppError {
    AppError::Internal("mock task table lock poisoned".into())
}

/// 按地址的字符哈希取基色，画一张自上而下渐亮的占位图。
fn placeholder_png(seed: &str) -> AppResult<Vec<u8>> {
    let hash = seed.bytes().fold(0u32, |acc, byte| {
        acc.wrapping_mul(31).wrapping_add(byte as u32)
    });
    let base = [
        (hash & 0xFF) as u8,
        ((hash >> 8) & 0xFF) as u8,
        ((hash >> 16) & 0xFF) as u8,
    ];

    let mut img = ImageBuffer::<Rgb<u8>, Vec<u8>>::new(PLACEHOLDER_W, PLACEHOLDER_H);
    for y in 0..PLACEHOLDER_H {
        for x in 0..PLACEHOLDER_W {
            let t = (x + y) as f32 / (PLACEHOLDER_W + PLACEHOLDER_H) as f32;
            let scale = 0.4 + 0.6 * t;
            img.put_pixel(
                x,
                y,
                Rgb([
                    (base[0] as f32 * scale) as u8,
                    (base[1] as f32 * scale) as u8,
                    (base[2] as f32 * scale) as u8,
                ]),
            );
        }
    }

    let mut cursor = Cursor::new(Vec::new());
    DynamicImage::ImageRgb8(img)
        .write_to(&mut cursor, ImageFormat::Png)
        .map_err(|e| AppError::Internal(format!("failed to encode placeholder image: {e}")))?;
    Ok(cursor.into_inner())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::project::VideoParams;
    use std::time::Duration;

    fn credentials() -> VideoCredentials {
        VideoCredentials {
            base_url: String::new(),
            api_key: String::new(),
            model: String::new(),
            timeout: Duration::from_secs(5),
        }
    }

    fn request(prompt: &str) -> VideoRequest {
        VideoRequest {
            prompt: prompt.into(),
            params: VideoParams::default(),
        }
    }

    #[tokio::test]
    async fn polls_advance_until_success() {
        let generator = MockVideoGenerator::new(&credentials());
        let submitted = generator.submit(&request("女主推门而入")).await.unwrap();

        let first = generator.poll(&submitted.handle).await.unwrap();
        assert_eq!(first.status, VideoStatus::Running);
        assert!(first.video_url.is_none());

        let second = generator.poll(&submitted.handle).await.unwrap();
        assert_eq!(second.status, VideoStatus::Succeeded);
        assert_eq!(
            second.video_url.as_deref(),
            Some(format!("mock://clip/{}", submitted.handle).as_str())
        );
    }

    #[tokio::test]
    async fn fail_marker_turns_task_into_failure() {
        let generator = MockVideoGenerator::new(&credentials());
        let submitted = generator.submit(&request("打斗 #fail")).await.unwrap();

        let mut last = generator.poll(&submitted.handle).await.unwrap();
        for _ in 0..POLLS_BEFORE_SUCCESS {
            last = generator.poll(&submitted.handle).await.unwrap();
        }
        assert_eq!(last.status, VideoStatus::Failed);
        assert!(last.error.is_some());
    }

    #[tokio::test]
    async fn slow_marker_needs_more_polls() {
        let generator = MockVideoGenerator::new(&credentials());
        let submitted = generator.submit(&request("长镜头 #slow")).await.unwrap();

        for _ in 0..POLLS_BEFORE_SUCCESS {
            let polled = generator.poll(&submitted.handle).await.unwrap();
            assert_eq!(polled.status, VideoStatus::Running);
        }
    }

    #[tokio::test]
    async fn fetch_draws_a_png_placeholder() {
        let generator = MockVideoGenerator::new(&credentials());
        let submitted = generator.submit(&request("女主推门而入")).await.unwrap();
        let url = format!("mock://clip/{}", submitted.handle);

        let output = generator.fetch(&url).await.unwrap();
        assert_eq!(output.mime, "image/png");
        assert!(output.bytes.starts_with(&[0x89, b'P', b'N', b'G']));
    }

    #[tokio::test]
    async fn cancel_forgets_the_task() {
        let generator = MockVideoGenerator::new(&credentials());
        let submitted = generator.submit(&request("女主推门而入")).await.unwrap();

        generator.cancel(&submitted.handle).await.unwrap();
        assert!(generator.poll(&submitted.handle).await.is_err());
    }

    #[tokio::test]
    async fn unknown_handle_reports_not_found() {
        let generator = MockVideoGenerator::new(&credentials());
        assert!(generator.poll("mock-missing").await.is_err());
    }
}
