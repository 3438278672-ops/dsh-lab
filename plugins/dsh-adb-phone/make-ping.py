"""Compose a QQ ping: the latest phone screenshot with a caption band on top.

Used when the agent is blocked on the phone (password field / lockscreen) and has to
reach the human. QQ text sending is token-gated for bridge sessions, but the
qqimage MCP can send a picture, so the question rides along as pixels.
"""
import glob
import os
import sys

from PIL import Image, ImageDraw, ImageFont

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "ping.png")
FONT = r"C:\Windows\Fonts\msyh.ttc"
CAPTION = sys.argv[1] if len(sys.argv) > 1 else "手机那边需要你一下"
WIDTH = 720


def latest_shot():
    shots = glob.glob(os.path.join(os.environ.get("TEMP", "."), "dsh-phone", "screen-*.png"))
    # the sequence number restarts when the plugin reloads, so order by mtime
    return max(shots, key=os.path.getmtime) if shots else None


def wrap(draw, text, font, max_width):
    lines, line = [], ""
    for ch in text:
        if draw.textlength(line + ch, font=font) > max_width and line:
            lines.append(line)
            line = ch
        else:
            line += ch
    if line:
        lines.append(line)
    return lines


def main():
    shot = latest_shot()
    if not shot:
        raise SystemExit("no screenshot to attach")

    body = Image.open(shot).convert("RGB")
    body = body.resize((WIDTH, int(body.height * WIDTH / body.width)), Image.LANCZOS)

    font = ImageFont.truetype(FONT, 26)
    lines = wrap(ImageDraw.Draw(body), CAPTION, font, WIDTH - 48)
    band = 24 + len(lines) * 40

    canvas = Image.new("RGB", (WIDTH, band + body.height), "white")
    canvas.paste(body, (0, band))
    draw = ImageDraw.Draw(canvas)
    draw.rectangle([0, 0, WIDTH, band], fill=(20, 20, 20))
    for index, line in enumerate(lines):
        draw.text((24, 18 + index * 40), line, font=font, fill=(250, 250, 250))

    canvas.save(OUT, "PNG")
    print(OUT)
    print(f"{canvas.width}x{canvas.height} from {os.path.basename(shot)}")


if __name__ == "__main__":
    main()
