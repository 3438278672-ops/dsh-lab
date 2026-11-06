# dsh-adb-phone

Host-only DeepSeek Harness bundle that drives a phone over `adb`. Eight `phone_*` tools, no runtime dependencies.

## Install / reload

```powershell
# install (already done for the desktop profile)
#   plugin_manager action=install_bundle target="D:/path/to/dsh-adb-phone"

# the profile links this directory, so edits are picked up only after a reload:
#   plugin_manager action=set_plugin target=include:adb-phone enabled=false
#   plugin_manager action=set_plugin target=include:adb-phone enabled=true
```

## Tools

| tool | what it does |
| --- | --- |
| `phone_screen` | `screencap -p` → PNG saved under `%TEMP%\dsh-phone\`, returned as an image block plus `screen=Awake focus=pkg/activity` |
| `phone_ui` | `uiautomator dump` → one line per labeled/clickable node: `N. Kind "text" #id @x,y [tap]`; `query` filters on kind/text/desc/id/pkg |
| `phone_tap` | `input tap x y`; `holdMs` turns it into a long press |
| `phone_swipe` | `input swipe x1 y1 x2 y2 duration` |
| `phone_type` | ASCII → `input text`; anything else (中文/emoji/accents) → ADBKeyboard bridge; `clear` empties the field first; `submit` appends Enter |
| `phone_key` | named keys (back/home/enter/recents/power/wakeup/sleep/menu/volume/…) or a numeric keycode, `times` repeats |
| `phone_app` | `current` \| `launch` (package or substring) \| `list` (optional `filter`) \| `stop` |
| `phone_wait` | poll the tree until an element matching `text` appears (`gone` inverts it) — replaces blind sleeping |

## Discovery order for adb and the device

1. `DSH_ADB_PATH`
2. `ANDROID_HOME` / `ANDROID_SDK_ROOT` / `ANDROID_SDK` + `platform-tools/adb[.exe]`
3. `%LOCALAPPDATA%\Android\platform-tools\adb.exe`
4. `adb` on `PATH`

The serial is the first `device` line of `adb devices` and is cached for the process.

## 中文 / emoji 输入

`adb shell input text` 把每个字符喂给 KeyCharacterMap，而虚拟键盘的表里没有 CJK ——
`input text 你好` 在 Android 16 上直接 NPE：

```
java.lang.NullPointerException: Attempt to get length of null array
	at com.android.server.input.InputShellCommand.sendText(InputShellCommand.java:425)
```

所以非 ASCII 走 [ADBKeyboard](https://github.com/senzhk/ADBKeyBoard)：它是一个输入法，
靠广播收文本（`ADB_INPUT_B64 --es msg <base64>`），绕开 KCM。

一次性准备（本机已做）：

```powershell
# vendor/ADBKeyboard.apk 来自 api.github.com 的 contents 接口，17374 字节
adb -s <serial> install -r "$env:TEMP\ADBKeyboard.apk"
adb -s <serial> shell ime enable com.android.adbkeyboard/.AdbIME   # 只启用，不改默认
```

之后 `phone_type` 自己处理切换：记下当前 IME → `ime set` 到 ADBKeyboard → 广播 base64
→ 把 IME 交还给用户原来那个（搜狗）。约 600ms/次，用户手机上会闪一下输入法。

IME 没装时工具会直接报错并给出上面的安装命令，不会静默吞掉。

## Gotchas baked in

- `adb exec-out` merges the device's stderr into stdout, so `screencap -p` can arrive prefixed with `[Warning] Multiple displays were found…`. `extractPng` slices from the PNG signature to the `IEND` chunk.
- This phone has a rear/sub display; `dumpsys window` lists both, so the focused window is taken from the **last** `mCurrentFocus=Window{…}` match (the active display), not the first.
- `adb pull` refuses non-ASCII destination paths (`D:\含中文的目录\…`); the plugin never pulls — it reads `exec-out` bytes and writes them itself.
- **A sleeping phone eats input silently.** `input tap` goes nowhere and `screencap` replays a stale frame, no error on either side. Every interacting tool now asks `dumpsys power` for `mWakefulness` first and presses `KEYCODE_WAKEUP` (224) when it is not `Awake`; `phone_screen` reports `screen=<state>` and says `(woke it)` when it intervened.
- `uiautomator dump` fails with `could not get idle state` while the window animates (common right after a tap), so `dumpUi` retries up to 3× with 400 ms backoff.
- Screenshots land in `%TEMP%\dsh-phone\` at ~1.5 MB each; only the newest 20 are kept.
- Only display 0 (1200×2608) is driven. Display 1 is the 976×596 rear screen — it is currently OFF, and nothing here captures or taps it.

## Limits worth knowing

- **Lockscreen**: this device has no PIN — a swipe up unlocks it, so a locked phone is recoverable:
  `phone_key wakeup`, then `phone_swipe 600,2350 600,700`. What still looks broken is the moment
  *while* locked: launching an app shows it as a card on the keyguard (`focus` is the app, but the
  screen is the locked-shell), so screenshot before believing you are inside the app. The display
  locks on its own timeout (~30 s of no input), which bites during long thinking pauses.
- **WebView apps are opaque to `phone_ui`**: 淘宝闪购 / 饿了么 (Weex + `TMSActivity`) usually dump
  **0 elements**, so there you only have `phone_screen` pixels — read every screen before tapping.
  美团, 设置, the browser and WebViews that do expose nodes are fine. This is also why coupon and
  cutlery popups are easy to tap by accident.
- **Payment handoff is fragile**: at 立即支付 the 支付宝 handoff got killed by MIUI's memory cleaner
  (toast `已经清理至最佳状态`) and the app dropped to the launcher with **no order created** — always
  verify 我的 → 全部订单 after paying instead of trusting the tap.
- **Rear display**: display 1 (976×596) is deliberately out of scope — the owner says it is effectively unused on this device.
- **IME blocking**: a field that refuses third-party IMEs (password boxes, some banks) will take the `clear`/中文 path and appear to do nothing → ask the human.
- Each non-ASCII `phone_type` borrows the user's input method for ~600 ms, so their keyboard visibly flashes.
- **超级小爱 has no accessibility tree.** While its window has focus, `uiautomator dump` returns the *home
  screen* (20 nodes, `第 7 页共 7 页`), so `phone_ui`/`phone_wait` are blind there — drive it from
  `phone_screen` coordinates only. Also its composer is multi-line: `phone_type {submit:true}` inserts a
  newline instead of sending, so the blue ↑ send button has to be tapped explicitly.
- **`phone_key assist` is a four-stage chain, not a keypress.** On this HyperOS 3 build:
  `input keyevent 219/231` does nothing (no global binding), `am start -a android.intent.action.ASSIST`
  only reveals the launcher, and `am start -n com.miui.voiceassist/…` is refused
  (`no activity of com.miui.voiceassist would start`). Reason: 超级小爱 is registered as a **launcher
  shortcut**, not a LAUNCHER activity — no `MAIN`/`LAUNCHER` intent exists, so nothing but a tap can raise
  it. The chain therefore ends by going home, reading the tree, and tapping the icon whose label contains
  小爱 (`tapHomeIcon()`); each stage only reports success when the focused window actually *changed*.
  Cost of that last resort: it pulls the phone back to the home screen first.

## Asking the human (QQ picture channel)

Text replies on the QQ bridge need a per-conversation **agent token**, which only the
QQ-side (reserved2) sessions are issued — a desktop session gets
`reserved2 模式发送必须携带 agent token`. The `qqimage` MCP has no such gate, so the way
to reach the owner is a picture with the question drawn on it:

```powershell
# 1. phone_screen already left a fresh PNG in %TEMP%\dsh-phone\
python make-ping.py "密码框挡住了，帮我输一下"     # -> ping.png, 720 wide, caption band on top
# 2. qqimage MCP:  key=private:100000002, path=<abs path>\ping.png
```

Verified 2026-10-26 (`messageId` came back from the bridge).

## Smoke test

```powershell
node test.mjs            # registers the tools against a fake ctx and runs the read-only ones
node probe-unicode.mjs   # what this phone supports: ime list, cmd clipboard, input text CJK, sdk
python make-ping.py "…"  # compose a QQ ping from the newest screenshot
```
