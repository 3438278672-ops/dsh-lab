"""语音转写（可选增强层）：faster-whisper，CPU int8 也能跑。

从 stdin 逐行读本地音频路径，每行输出一个 JSON（{"file","text"}）。

注意：faster-whisper 1.2.x 的 av 解码路径和 PyAV 19 不兼容
（open() 收到未知的 metadata_errors），所以这里先用 ffmpeg 转成
16k 单声道 wav，再用 numpy 直接喂给模型，绕开 av。
"""
import argparse
import json
import os
import subprocess
import sys
import tempfile
import wave

os.environ.setdefault('HF_ENDPOINT', 'https://hf-mirror.com')

FFMPEG = os.environ.get('QQ_ARCHIVE_FFMPEG') or 'ffmpeg'


def load_audio(path):
    import numpy as np

    fd, wav = tempfile.mkstemp(suffix='.wav')
    os.close(fd)
    try:
        subprocess.run(
            [FFMPEG, '-y', '-loglevel', 'error', '-i', path, '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', wav],
            check=True,
            timeout=180,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.PIPE,
        )
        with wave.open(wav, 'rb') as w:
            frames = w.readframes(w.getnframes())
        return np.frombuffer(frames, dtype=np.int16).astype(np.float32) / 32768.0
    finally:
        try:
            os.unlink(wav)
        except OSError:
            pass


def main():
    p = argparse.ArgumentParser()
    p.add_argument('--model', default='small')
    p.add_argument('--device', default='cpu')
    p.add_argument('--compute', default='int8')
    p.add_argument('--list', dest='list_path', default='', help='每行一个音频路径的 UTF-8 文件（走命令行参数比 stdin 稳，中文路径不受控制台编码影响）')
    a = p.parse_args()

    # 输出统一 UTF-8：Windows 控制台默认 GBK，会把 JSON 里的中文路径写坏
    sys.stdout.reconfigure(encoding='utf-8')
    sys.stderr.reconfigure(encoding='utf-8', errors='replace')

    from faster_whisper import WhisperModel

    model = WhisperModel(a.model, device=a.device, compute_type=a.compute)

    if a.list_path:
        with open(a.list_path, 'r', encoding='utf-8') as f:
            paths = [ln.strip() for ln in f if ln.strip()]
    else:
        sys.stdin.reconfigure(encoding='utf-8', errors='replace')
        paths = [ln.strip() for ln in sys.stdin if ln.strip()]

    for path in paths:
        try:
            audio = load_audio(path)
            if audio.size < 1600:  # 不到 0.1 秒，跳过
                print(json.dumps({'file': path, 'text': ''}, ensure_ascii=False), flush=True)
                continue
            segments, info = model.transcribe(
                audio,
                language='zh',
                vad_filter=True,
                beam_size=1,
                initial_prompt='以下是中文群聊语音，请用简体中文转写，保留标点。',
            )
            text = ''.join(s.text for s in segments).strip()
            print(json.dumps({'file': path, 'text': text, 'lang': info.language}, ensure_ascii=False), flush=True)
        except Exception as e:  # 单个文件失败不影响后面的
            print(json.dumps({'file': path, 'error': str(e)[:300]}, ensure_ascii=False), flush=True)


if __name__ == '__main__':
    main()
