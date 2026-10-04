# ogs-plugin-square-omni

OpenGolfSim launch monitor plugin for the Square Golf Omni (BLE).

## Install

Copy this folder into the OpenGolfSim plugins folder:

- Windows: `%USERPROFILE%\AppData\Roaming\opengolfsim-desktop\plugins\`
- macOS: `~/Library/Application Support/opengolfsim-desktop/plugins/`

Do **not** pair the Omni in OS Bluetooth settings; it does not support pairing.

## Current scope

- Ball metrics (speed, VLA, HLA, total spin, spin axis) → `shotData.sendShot`
- Ready state from the sensor stream, battery from `0x91`, firmware from `86602003`
- Club fixed to Driver (right-handed). Club switching not yet wired.
- Club metrics (`0x87`/`0x07`) not requested; the OGS `Shot` type has no club fields.

## Contribute

We welcome contributions to this repo to make things work better. Feel free to file issues, or open pull requests for fixes or improvements.
