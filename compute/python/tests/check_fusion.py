"""Deterministic PyTorch reference tests, runnable with python -m unittest."""

import pathlib
import tempfile
import unittest

import torch

from kvalah_compute.fusion import ExpertMLP, FFN, FusionModel, LoRA, Loop, Router, supervised_loss
from kvalah_compute.fusion_pipeline import Stage, pipeline_step



class FusionTests(unittest.TestCase):
    def setUp(self):
        torch.manual_seed(31)
        torch.set_num_threads(1)

    def test_ffa_and_lora_forward_gradient(self):
        x=torch.randn(3,6,dtype=torch.float64,requires_grad=True)
        lora=LoRA(6,5,2,4).double()
        with torch.no_grad():
            lora.B.normal_()
        self.assertTrue(torch.autograd.gradcheck(lora,(x,)))
        lora(x).square().mean().backward()
        self.assertIsNone(lora.A.grad)
        self.assertGreater(float(lora.B.grad.norm()),0)
        trainable=LoRA(6,5,2,4,frozen_a=False).double()
        with torch.no_grad():
            trainable.B.normal_()
        trainable(x).square().mean().backward()
        self.assertGreater(float(trainable.A.grad.norm()),0)

    def test_ffn_expansion_is_noop_with_nonzero_down_gradient(self):
        x=torch.randn(1,4,12)
        base=ExpertMLP(FFN(12,24),Router(12))
        expected,_=base(x)
        base.add("code",FFN(12,16,residual=True))
        actual,_=base(x)
        self.assertTrue(torch.equal(actual,expected))
        actual.square().sum().backward()
        self.assertIsNone(base.base.down.weight.grad)
        self.assertGreater(float(base.experts["code"].down.weight.grad.norm()),0)
        self.assertTrue(torch.autograd.gradcheck(FFN(3,4).double(),(torch.randn(2,3,dtype=torch.float64,requires_grad=True),)))
        base.disabled.add("code")
        self.assertTrue(torch.equal(base(x)[0],expected))

    def test_top1_gradient_and_causal_token_routing(self):
        model=ExpertMLP(FFN(8,16),Router(8,top_k=1,capacity=2))
        model.add("math",FFN(8,8))
        model.add("code",FFN(8,8))
        x=torch.randn(2,5,8)
        y,stats=model(x)
        y.square().mean().backward()
        self.assertGreater(sum(float(p.grad.norm()) for p in model.router.parameters()),0)
        self.assertTrue((stats["counts"]<=4).all())
        model.eval()
        y,_=model(x)
        changed=x.clone()
        changed[:,3:]+=100
        observed,_=model(changed)
        torch.testing.assert_close(y[:,:3],observed[:,:3],rtol=0,atol=0)
        model.disabled.add("math")
        _,stats=model(x)
        self.assertEqual(stats["keys"],["code"])

    def test_loop_cache_causality_and_backward(self):
        tokens=torch.tensor([[1,7,14,4,9,8]])
        one=FusionModel(loop=Loop(1,3,1)).eval()
        reference=FusionModel().eval()
        reference.load_state_dict(one.state_dict())
        self.assertTrue(torch.equal(one(tokens)[0],reference(tokens)[0]))
        for passes in (2,3,4):
            model=FusionModel(loop=Loop(1,3,passes,sliding_window=3),activation_checkpointing=True,router={"mode":"request"})
            for block in model.blocks:
                block.ffn.add("math",FFN(24,48,residual=True))
                block.ffn.add("code",FFN(24,48))
            model.eval()
            with torch.no_grad():
                full=model(tokens)[0]
                altered=tokens.clone()
                altered[:,4:]=torch.tensor([21,22])
                torch.testing.assert_close(model(altered)[0][:,:4],full[:,:4],atol=1e-6,rtol=1e-6)
                cache=None
                results=[]
                for token in tokens.split(1,dim=1):
                    logits,cache,_=model(token,cache=cache,use_cache=True)
                    results.append(logits)
                torch.testing.assert_close(torch.cat(results,dim=1),full,atol=1e-6,rtol=1e-6)
                self.assertEqual(len(cache["kv"]),4+2*(passes-1))
            model.train()
            loss,_=supervised_loss(model(tokens)[0],tokens,torch.tensor([[False,False,True,True,True,True]]))
            loss.backward()
            self.assertTrue(torch.isfinite(model.loop_gates.grad).all())
            self.assertTrue((model.loop_gates.grad!=0).all())
            self.assertIsNone(model.blocks[1].qkv.weight.grad)

    def test_mistral_hook_keeps_base_and_changes_only_selected_request(self):
        from transformers import MistralConfig, MistralForCausalLM
        from kvalah_compute.fusion_ministral import attach_to_mistral, insert_expert, request

        config=MistralConfig(vocab_size=64,hidden_size=24,intermediate_size=48,num_hidden_layers=2,
                             num_attention_heads=4,num_key_value_heads=2,max_position_embeddings=64)
        model=MistralForCausalLM(config).eval()
        input_ids=torch.tensor([[2,8,5,9]])
        baseline=model(input_ids,use_cache=False).logits.detach()
        slots=attach_to_mistral(model)
        a=insert_expert(slots,name="code",kind="ffa-lora",layers=[0],rank=4)[0]
        b=insert_expert(slots,name="math",kind="ffn",layers=[1],intermediate=12)[1]
        model.eval()
        self.assertTrue(torch.equal(model(input_ids,use_cache=False).logits,baseline))
        with torch.no_grad():
            a.B.normal_(std=0.1)
            b.down.weight.normal_(std=0.1)
        with request(weights={"code":1.0}):
            out=model(input_ids,use_cache=False).logits
            self.assertFalse(torch.equal(out,baseline))
            with request(weights={}):
                self.assertTrue(torch.equal(model(input_ids,use_cache=False).logits,baseline))
            self.assertTrue(torch.equal(model(input_ids,use_cache=False).logits,out))

    def test_pipeline_backward_and_restart_from_step_boundary(self):
        layouts=[[(10,False)],[(11,True)],[(12,False)]]
        stages=[Stage(6,layout) for layout in layouts]
        snapshots=[{k:v.detach().clone() for k,v in stage.state_dict().items()} for stage in stages]
        x=[torch.randn(2,6),torch.randn(1,6)]
        y=[torch.randn_like(t) for t in x]
        ref=nn_output=torch.nn.Sequential(*stages)
        lr=0.03
        loss=sum((nn_output(a)-b).square().sum() for a,b in zip(x,y,strict=True))/sum(t.numel() for t in y)
        loss.backward()
        with tempfile.TemporaryDirectory() as temp:
            target=pathlib.Path(temp)/"round.safetensors"
            target.write_bytes(b"previous committed snapshot")
            def fail(stage_procs):
                stage_procs[1].process.kill()
                stage_procs[1].process.wait()
            with self.assertRaises((EOFError,BrokenPipeError,OSError)):
                pipeline_step(6,layouts,x,y,snapshots,epoch="r1",lr=lr,destination=target,failure_hook=fail)
            self.assertEqual(target.read_bytes(),b"previous committed snapshot")
            result=pipeline_step(6,layouts,x,y,snapshots,epoch="r1",lr=lr,destination=target)
            self.assertAlmostEqual(result["loss"],float(loss.detach()),places=6)
            for n,p in ref.named_parameters():
                i,k=n.split('.',1)
                expected=p.detach() if p.grad is None else p.detach()-lr*p.grad
                torch.testing.assert_close(result["weights"][n],expected,rtol=0,atol=2e-7)
                if p.grad is not None:
                    torch.testing.assert_close(result["gradients"][int(i)][k],p.grad,rtol=0,atol=2e-7)


if __name__=="__main__":
    unittest.main()
