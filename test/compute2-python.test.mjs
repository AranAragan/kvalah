// Kvalah Compute v0.2 — Python backend checks (spec M03, M04, E01 + Mistral3 architecture) on tiny random
// models built locally. MLX parity runs only where the mlx/mlx-vlm packages import (Apple Silicon, or the
// CPU build of MLX on Linux); otherwise it is reported as skipped inside the JSON report.
import {python,PY_ROOT} from './compute-helpers.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
const py=python(['torch','transformers','peft','tokenizers','safetensors']);
test('backend checks: SFT mask, torch↔MLX parity, PEFT round trip, Mistral3 target discovery',{skip:py?false:'needs KVALAH_COMPUTE_PYTHON with torch, transformers, peft',timeout:600000},()=>{
  const r=spawnSync(py,[path.join(PY_ROOT,'tests','check_backends.py')],{encoding:'utf8',env:{...process.env,PYTHONPATH:PY_ROOT,KVALAH_COMPUTE_TEST:'1',HF_HUB_OFFLINE:'1'},maxBuffer:16e6});
  let rep;try{rep=JSON.parse(r.stdout.trim().split('\n').pop());}catch{assert.fail('no report: '+r.stderr.slice(-1500));}
  for(const [k,v] of Object.entries(rep.checks))assert.ok(v.ok,k+' '+JSON.stringify(v));
  assert.ok(rep.checks['E01.assistant_only_targets']);assert.ok(rep.checks['mistral3.peft_no_vision']);
});
