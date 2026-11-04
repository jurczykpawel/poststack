# Recorded provider responses (PROVFIX1)

Raw platform responses captured on 2026-11-04 while publishing through PostStack's own provider code
(`metaProvider`, `youtubeProvider`, `tiktokProvider`) against the TEST environment's test accounts.
Each publication was then checked live: GET of the stored handle, a comment posted on it (and deleted),
and the link `postUrlFor` builds. After that the publication was deleted. Tests replay these files
instead of invented responses: an invented `post_id: "r1"` once hid that Facebook Reels return a bare
post id that Graph cannot address (error #12 on the first comment).

## Anonymization

- Access tokens were redacted at capture (`<TOKEN>`); upload ids are `<UPLOAD_ID>`.
- Every id of 10+ digits and every opaque YouTube/TikTok id is replaced by a deterministic substitute
  of the same length and alphabet, so `<page>_<post>` and `<post>_<comment>` stay consistent across
  all files. Account names, signed CDN URLs and bucket names are replaced with neutral values.

## Files

| File | Path | What was verified live |
|------|------|------------------------|
| `facebook-photo-published.json` | FB `/photos`, published | `post_id` = `<page>_<post>`; GET, comment, link OK; comment webhook carries the same `post_id` |
| `facebook-photo-unpublished.json` | FB `/photos`, `published=false` | only `id` (photo) is returned; comment on it works; the post is not public, so no link |
| `facebook-video-published.json` | FB `/videos` | response is the video `id`; webhook comments arrive with a different `<page>_<post>` |
| `facebook-video-post-id.json` | FB `/videos` + `GET ?fields=post_id` | `post_id` is available 0.8 s after the upload call |
| `facebook-video-post-handle.json` | FB `/videos` addressed as `<page>_<post>` | GET, comment, link (`og:url` = the video) OK; deleting the post deletes the video |
| `facebook-reel-published.json` | FB Reel start/upload/finish | `finish` returns a bare `post_id`; `<page>_<post>` works for GET, comment, link |
| `facebook-reel-draft.json` | FB Reel, `video_state=DRAFT` | same response shape as published |
| `facebook-video-unpublished-denied.json` | FB `/videos`, `published=false` | Page token gets `#200` (no permission) |
| `facebook-story.json` | FB Page photo story | returned `post_id` cannot be read, commented or deleted through Graph |
| `instagram-containers.json` | IG image / REELS / STORIES containers | container create + status polling; never published, nothing public |
| `prod-stored-handles.json` | handles stored on PROD | read-only GET: IG media ids resolve with `permalink`; legacy bare FB reel id fails with `#12` |
| `youtube-upload-private.json` | YouTube resumable upload, private | video id works for GET; comment on a private video is refused (403 forbidden) |
| `youtube-upload-unlisted.json` | YouTube resumable upload, unlisted | comment accepted; `watch?v=` link |
| `tiktok-inbox.json` | TikTok inbox upload | handle is the `publish_id`; status ends `SEND_TO_USER_INBOX` |
| `tiktok-direct-self-only.json` | TikTok direct post, `SELF_ONLY` | status ends `PUBLISH_COMPLETE` without a public post id |

Not recordable on 2026-11-04: Instagram `media_publish` (Instagram posts cannot be made private and
removing them through the API was not confirmed; the stored handle shape is taken from PROD), X,
LinkedIn and Threads (no connected TEST channel). Their tests use the providers' documented examples.
