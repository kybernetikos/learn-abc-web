# learn-abc — frontend

Static PWA that takes a phone photo of folk-music sheet music, lets the user mark the four corners of the paper, sends the image to a hosted [Qwen3-VL-32B fine-tune](https://huggingface.co/folk-abc/learn-abc-qwen3vl32b) for transcription, and renders + plays the resulting [ABC notation](https://abcnotation.com/) using [abcjs](https://abcjs.net/).

This repo is just the front-end. The model and inference API are separate:

| component | where it lives |
|---|---|
| Model adapter (LoRA) | https://huggingface.co/folk-abc/learn-abc-qwen3vl32b |
| Inference API | hosted on [Modal](https://modal.com) — endpoint URL is hardcoded in `app.js` |
| Training/eval pipeline | local repo (not public) |

## How to run locally

It's a static page + ES module — any HTTP server works:

```bash
python3 -m http.server 8000
# then open http://localhost:8000/
```

To point at a non-default API (e.g. running scripts/api_server.py locally):

```
http://localhost:8000/?api=http://localhost:8000
```

## How submissions are used

Photos and corrections submitted through the live demo are stored on the inference server's persistent disk and used to inform future iterations of the model. No personal information (IP, location, device ID) is stored. The opt-out checkbox on the result page lets users disable storage for a particular submission.

## License

Apache-2.0. The third-party `abcjs-basic-min.js` is bundled here for offline use; it has its own license — see https://github.com/paulrosen/abcjs.
