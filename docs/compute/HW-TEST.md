# Kvalah Compute v0.2 — hardware test instructions (ENVERDASH · ROG · MacBook M1 Pro)

**Status of everything below: NOT RUN.** The build box has no GPU and no Mac. Only CPU tests passed there
(tiny random models, `torch-cpu-test` and CPU-MLX). Record every result honestly as PASS / FAIL / BLOCKED.
Save the outputs (JSON, screenshots, report zip) in one folder per machine.

| Machine | OS | GPU | Backend / variant | Build |
|---|---|---|---|---|
| ENVERDASH (MSI) | Windows 11 x64 | RTX 5070 Laptop 8 GB (Blackwell, BF16) | `cuda` / `cuda-nf4` | `kvalah-0.10.0-compute.1-win-x64-portable.zip` (or `-setup.exe`) |
| ROG | Windows x64 | RTX 2070 8 GB (Turing, FP16) | `cuda` / `cuda-nf4` | same Windows build |
| MacBook M1 Pro 16 GB | macOS 14+ arm64 | Apple GPU (unified) | `mlx` / `mlx-4bit` | from source (no mac build was produced) |

The test build has version **0.10.0-compute.1** so the auto-updater does not replace it with a 0.9.x
release. Compute is **off** after installation; nothing runs until you enable it.

---
## 0. Get the build onto each machine
**Windows (both PCs).** Recommended: the **portable zip** (does not replace the installed kvalah;
the user data folder `%APPDATA%\kvalah` is shared, Compute stays off until enabled):
```powershell
$K = "$env:USERPROFILE\kvalah-compute-test"
Expand-Archive -Path "$env:USERPROFILE\Downloads\kvalah-0.10.0-compute.1-win-x64-portable.zip" -DestinationPath $K -Force
& "$K\kvalah.exe"
```
The build is unsigned: SmartScreen → *More info* → *Run anyway*.

**Mac (from the git bundle `kvalah-feat-compute-v02.bundle`):**
```zsh
cd ~ && git clone -b feat/compute-v02 ~/Downloads/kvalah-feat-compute-v02.bundle kvalah-compute-v02
cd kvalah-compute-v02 && node --version   # needs Node >= 22 (brew install node if missing)
npm ci && npm run desktop
```

## 1. Python 3.12 runtime (separate venv; nothing installed globally)
**ENVERDASH and ROG (PowerShell):**
```powershell
nvidia-smi                                   # note driver version; cu130 wheels need driver >= 580
py -3.12 --version                           # if missing: winget install -e --id Python.Python.3.12
$R = "$env:USERPROFILE\kvalah-compute"
New-Item -ItemType Directory -Force $R | Out-Null
py -3.12 -m venv "$R\.venv"
& "$R\.venv\Scripts\python.exe" -m pip install --upgrade pip
& "$R\.venv\Scripts\python.exe" -m pip install torch==2.14.1 --index-url https://download.pytorch.org/whl/cu130
& "$R\.venv\Scripts\python.exe" -m pip install -r "$K\resources\app\compute\runtime\requirements-cuda.txt"
& "$R\.venv\Scripts\python.exe" -c "import torch;print(torch.__version__,torch.cuda.is_available(),torch.cuda.get_device_name(0),torch.cuda.is_bf16_supported())"
```
If the ROG driver is older than 580 and cannot be updated: use `--index-url https://download.pytorch.org/whl/cu126`
for torch 2.14.1 on ROG only (cu126 has no Blackwell kernels, so not on ENVERDASH). Record which you used.

**Mac (zsh):**
```zsh
brew install python@3.12
R=~/kvalah-compute; mkdir -p $R
/opt/homebrew/bin/python3.12 -m venv $R/.venv
$R/.venv/bin/python -m pip install --upgrade pip
$R/.venv/bin/python -m pip install -r ~/kvalah-compute-v02/compute/runtime/requirements-mlx.txt
$R/.venv/bin/python -c "import platform,mlx.core as mx;print(platform.machine(),mx.__version__,mx.default_device())"   # must print arm64 … gpu
```

## 2. Model folders (pinned revisions; reuse the v0.1 folders if they are these revisions)
**Windows (BF16 source, quantized to NF4 at load time):**
```powershell
& "$R\.venv\Scripts\python.exe" -m pip install "huggingface_hub[cli]"
& "$R\.venv\Scripts\hf.exe" download mistralai/Ministral-3-3B-Instruct-2512-BF16 --revision ef287ce8b4b5f858eaf679e9d6402265beb8624f --local-dir "$R\models\Ministral-3-3B-Instruct-2512-BF16"
```
(If the repo asks for a licence acceptance/login: accept it on huggingface.co and run `hf auth login` first.)
Copy the same folder to ROG instead of downloading twice if convenient — the files digest must be identical.

**Mac (MLX community 4-bit; provenance stays "unverified" by design):**
```zsh
$R/.venv/bin/python -m pip install "huggingface_hub[cli]"
$R/.venv/bin/hf download mlx-community/Ministral-3-3B-Instruct-2512-4bit --revision a962dcb09eee4169c890e544c9eb938f1113fdee --local-dir $R/models/Ministral-3-3B-Instruct-2512-4bit
```

## 3. HW-DOCTOR — runtime + one real training step (each machine)
**Windows** (Electron runs the CLI as Node; pipe the output so it shows in PowerShell):
```powershell
$env:ELECTRON_RUN_AS_NODE = "1"
& "$K\kvalah.exe" "$K\resources\app\compute\cli.mjs" doctor --python "$R\.venv\Scripts\python.exe" --backend cuda --model-dir "$R\models\Ministral-3-3B-Instruct-2512-BF16" --variant cuda-nf4 --preflight --json 2>&1 | Tee-Object "$R\doctor-$env:COMPUTERNAME.json"
Remove-Item Env:ELECTRON_RUN_AS_NODE
```
**Mac:**
```zsh
cd ~/kvalah-compute-v02
node compute/cli.mjs doctor --python $R/.venv/bin/python --backend mlx --model-dir $R/models/Ministral-3-3B-Instruct-2512-4bit --variant mlx-4bit --preflight --json 2>&1 | tee $R/doctor-mac.json
```
PASS criteria: `runtime.backend_ok: true`; ENVERDASH `precision: "bf16"`, ROG `precision: "fp16"`;
`model.architecture_ok: true`; `preflight.ok: true`. Record `preflight.model_load_s`, `step_s` and
`peak_reserved_bytes` (CUDA) / `mlx_peak_bytes` (Mac) exactly as printed. FAIL → keep the JSON and the stderr.

## 4. HW-GUI setup (each machine, in the app)
1. Sidebar → **Compute** → *Enable the Compute section*.
2. **Models & data**: Python executable = the venv python above; Backend `cuda` (Windows) / `mlx` (Mac) →
   *Check runtime*. Model folder → *Verify model* (variant `cuda-nf4` / `mlx-4bit`). Windows: *Check origin on
   Hugging Face* → expect **verified**. Mac: expect **unverified** (MLX community conversion, see report notes).
   *Run preflight* → "Preflight OK".
3. **Participation** (for this capacity test only): Additional limits → Profile **Full**; GPU 100 %, CPU 50 %;
   untick *Only when idle*. Mains power must stay connected. **Mac:** also untick *Pause when games start*
   (no game sensor on macOS — the app otherwise pauses with that reason, which is expected behaviour).

## 5. HW-B01 — clean 3-device Smoke (2 rounds × 3 steps, all 3 required)
**ENVERDASH:**
1. Devices → Local coordinator: Address = ENVERDASH's LAN IP (not 127.0.0.1), Port 8765 → *Start
   coordinator*. Windows Firewall prompt: allow **Private networks only**.
2. *Join this computer as a worker*. Participation toggle → read consent → tick → *Allow*.
3. *Create one-time pairing code* → send the string to ROG (one code per device; create a second for the Mac).

**ROG and Mac:** Devices → paste the string → device name `ROG` / `Mac` → *Connect* → state `pending`.
**ENVERDASH:** Devices list → *Approve* both. Check: 3 different device IDs and key fingerprints, correct
aliases, all `online`, no duplicate-name warning. **ROG and Mac:** *Check approval* → `active`;
Participation toggle → consent (it shows ENVERDASH's endpoint + fingerprint — compare with ENVERDASH's screen) → *Allow*.

**ENVERDASH → Training Lab:**
1. *Register the checked local model* (cuda-nf4, verified). Under *Reported by approved devices* click
   *Register this variant* for the Mac's `mlx-4bit` (ROG's cuda-nf4 must show **no** entry — same digest).
2. *Import the bundled smoke fixture*.
3. New experiment: name `b01-smoke`, profile Smoke, dataset `smoke-sft-v1@1`, variants `cuda-nf4` + `mlx-4bit`,
   quorum *All target devices*, target 3 → *Check configuration*: record tasks (6), config hash, frozen-A hash;
   the warning "research quality not possible (synthetic dataset, provenance unverified)" is expected.
4. *Create and start*. Monitoring: watch slots → each device gets one task per round.
   If it waits, the blocker text must say why (record it).
5. After COMPLETED (and the validation NLL rows for round 0 and 2): Training Lab → tick *include weights* →
   *Export report* → choose a folder. Then Models & data → *Verify report* with that zip → must say OK.

PASS: 2 committed rounds, 6 accepted updates from 3 distinct devices, verify-report OK.
Record from the Monitoring tab: round durations, aggregation ms, validation NLL r0 → r2 (no improvement is
required for Smoke), per-device tok/s and peak memory from the device list.

Also verify offline on ENVERDASH:
```powershell
$env:ELECTRON_RUN_AS_NODE="1"; & "$K\kvalah.exe" "$K\resources\app\compute\cli.mjs" verify-report --file "<path>\kvalah-compute-report-<run>.zip" --json 2>&1 | Tee-Object "$R\verify-b01.json"; Remove-Item Env:ELECTRON_RUN_AS_NODE
```

## 6. HW-F — fault injection (new experiment, Pilot preset, quorum fault tolerant min 2 / target 3)
| ID | Action | Expected |
|---|---|---|
| F1 | During a round, on ROG: Participation → **Pause**, wait 3 min (lease TTL 120 s), **Resume** | ROG shows Paused (manual) → task resumes or lease expires and slot is reassigned; no double count |
| F2 | Pull ROG's Wi-Fi/Ethernet mid-task for > 3 min, reconnect | round commits at deadline with 2 of 3, or ROG's late update is shown as excluded/quarantined |
| F3 | Close kvalah on ENVERDASH (coordinator) during a round, reopen | coordinator restarts automatically (was running), round continues; checkpoint hashes unchanged |
| F4 | ENVERDASH: start a chat with the local model while ENVERDASH trains | ENVERDASH worker pauses with "local AI is in use"; chat works; worker resumes afterwards |
| F5 | ROG on battery (unplug) with *Only on mains power* ticked | pauses with "running on battery" |
| F6 | Revoke the Mac in Devices | Mac shows revoked; its lease returns to the queue; it gets no new tasks |
Record the event lists (Monitoring → Events) as screenshots.

## 7. HW-E — PEFT export
Training Lab → *Export PEFT adapter* on the B01 run. Check `adapter_config.json`: `r: 8`, `lora_alpha: 16`,
`target_modules` = the q_proj/v_proj language layers. Optional load test on ENVERDASH:
```powershell
& "$R\.venv\Scripts\python.exe" -c "from transformers import AutoModelForImageTextToText as M;from peft import PeftModel;import sys;m=M.from_pretrained(sys.argv[1]);p=PeftModel.from_pretrained(m,sys.argv[2]);print('loaded',sum(1 for n,_ in p.named_parameters() if 'lora_' in n))" "$R\models\Ministral-3-3B-Instruct-2512-BF16" "<export folder>"
```
(If the model class name differs in your transformers version, record the error instead of changing code.)

## 8. What to send back
Per machine: doctor JSON, screenshots of Models & data / Participation / Devices, the B01 report zip and
verify output, fault-injection notes, and any error text. Mark each step PASS / FAIL / BLOCKED.

## Troubleshooting
* **CUDA OOM in preflight**: close other GPU apps (Ollama: `ollama stop <model>`), retry; record peak memory.
* **Port in use / firewall**: choose another port (e.g. 8766). Changing address or port regenerates the
  certificate → all devices must pair again (new pairing strings).
* **`sensor unavailable` pause**: untick the corresponding option (game detection exists only on Windows).
* **Device stuck `pending`**: approve it on ENVERDASH, then *Check approval* on the device.
* **MLX import error**: make sure the venv python is arm64 (`python -c "import platform;print(platform.machine())"`).
