"""Create deterministic inputs for three signed CPU reference assignments."""

import json
import sys
from pathlib import Path

import torch

from kvalah_compute.fusion_lab import install, make_model, parameters_for, save_weights


def main(output):
    torch.set_num_threads(1)
    torch.manual_seed(379)
    model_config=dict(width=16,heads=4,layers=2,intermediate=24,vocab=32,context=20)
    model=make_model(model_config,device="cpu")
    save_weights(output/"backbone.safetensors",model.state_dict())
    (output/"architecture.json").write_text(json.dumps(dict(format="kvalah-fusion-cpu-job/v1",model=model_config)),encoding="utf-8")
    for key in ("code","math","language"):
        expert=dict(key=key,kind="ffa-lora",layers=[1],rank=3,alpha=6)
        install(model,expert)
        checkpoint=parameters_for(model,"expert",key)
        save_weights(output/f"{key}.safetensors",checkpoint)
        (output/f"{key}.json").write_text(json.dumps(expert),encoding="utf-8")


if __name__=="__main__":
    main(Path(sys.argv[1]))
