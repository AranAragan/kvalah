// Kvalah Compute v0.2 — Python backend checks (spec M03, M04, E01 + Mistral3 architecture) on tiny random
// models built locally. MLX parity runs only where the mlx/mlx-vlm packages import (Apple Silicon, or the
// CPU build of MLX on Linux); otherwise it is reported as skipped inside the JSON report.
import {python,PY_ROOT} from './compute-helpers.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
const py=python(['torch','transformers','peft','tokenizers','safetensors']);
const mistralPython=python(['transformers','mistral_common']);

test('MistralCommon finetuning masks only assistant turns in English and Russian',{skip:mistralPython?false:'needs KVALAH_COMPUTE_PYTHON with mistral_common'},()=>{
  const result=spawnSync(mistralPython,[path.join(PY_ROOT,'tests','check_mistral_masks.py')],{
    encoding:'utf8',env:{...process.env,PYTHONPATH:PY_ROOT,PYTHONUTF8:'1',HF_HUB_OFFLINE:'1',TRANSFORMERS_OFFLINE:'1'}});
  assert.equal(result.status,0,result.stderr||result.stdout);
});
test('backend checks: SFT mask, torch↔MLX parity, PEFT round trip, Mistral3 target discovery',{skip:py?false:'needs KVALAH_COMPUTE_PYTHON with torch, transformers, peft',timeout:600000},t=>{
  const r=spawnSync(py,[path.join(PY_ROOT,'tests','check_backends.py')],{encoding:'utf8',env:{...process.env,PYTHONPATH:PY_ROOT,KVALAH_COMPUTE_TEST:'1',HF_HUB_OFFLINE:'1'},maxBuffer:16e6});
  let rep;try{rep=JSON.parse(r.stdout.trim().split('\n').pop());}catch{assert.fail('no report: '+r.stderr.slice(-1500));}
  for(const [k,v] of Object.entries(rep.checks)){
    if(v.skipped)t.diagnostic('SKIP '+k+' '+v.skipped);
    else assert.ok(v.ok,k+' '+JSON.stringify(v));
  }
  assert.ok(rep.checks['E01.assistant_only_targets']);assert.ok(rep.checks['mistral3.peft_no_vision']);
});

test('T13: checkpoint recovery rolls back a corrupt generation as one adapter/optimizer pair',{skip:py?false:'needs KVALAH_COMPUTE_PYTHON with numpy and safetensors'},()=>{
  const script=`
import tempfile
from pathlib import Path
import numpy as np
from kvalah_compute.sidecar import _save_checkpoint, _restore_checkpoint

task = {"task_id": "one", "lease_id": "lease", "layers": 1, "targets": {"q_proj": [2, 2]},
        "rank": 1, "local_steps": 3, "optimizer": {"name": "adamw"}}
name = "layers.0.self_attn.q_proj"
base = {name + ".A": np.zeros((1, 2), np.float32), name + ".B": np.zeros((2, 1), np.float32)}

class Backend:
    def set_adapter(self, adapter):
        self.adapter = adapter
    def make_optimizer(self, _):
        pass
    def load_optimizer_state(self, arrays, meta):
        self.optimizer = arrays, meta

with tempfile.TemporaryDirectory() as tmp:
    a1 = {name + ".B": np.ones((2, 1), np.float32)}
    a2 = {name + ".B": np.full((2, 1), 2, np.float32)}
    one = _save_checkpoint(tmp, None, task, "test", 1, a1, {"step": np.array([1])}, {"step": 1})
    two = _save_checkpoint(tmp, one, task, "test", 2, a2, {"step": np.array([2])}, {"step": 2})
    (Path(tmp) / two / "opt.safetensors").write_bytes(b"interrupted write")
    backend = Backend()
    assert _restore_checkpoint(tmp, task, "test", base, backend, None) == (1, one)
    np.testing.assert_array_equal(backend.adapter[name + ".B"], a1[name + ".B"])
    np.testing.assert_array_equal(backend.optimizer[0]["step"], [1])
    assert backend.optimizer[1] == {"step": 1}
    assert _restore_checkpoint(tmp, {**task, "lease_id": "new"}, "test", base, backend, None) == (0, None)
`;
  const r=spawnSync(py,['-c',script],{encoding:'utf8',env:{...process.env,PYTHONPATH:PY_ROOT}});
  assert.equal(r.status,0,r.stderr||r.stdout);
});
