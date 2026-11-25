"""TEST-ONLY backend (KVALAH_COMPUTE_TEST=1): no model, deterministic pseudo-gradient on B so protocol,
outbox, governor and aggregation tests can run without a GPU. It proves nothing about training quality
and is refused in production by make_backend()."""
import hashlib, os, time
import numpy as np

class MockBackend:
    name = "mock"
    def probe(self):
        return {"precision": "fp32", "device": "mock", "test_only": True}
    def load(self, model_dir, task):
        self.task = task
        return {"precision": "fp32", "test_only": True}
    def set_adapter(self, t):
        self.A = {k: v.copy() for k, v in t.items() if k.endswith(".A")}
        self.B = {k: v.copy() for k, v in t.items() if k.endswith(".B")}
    def make_optimizer(self, o):
        self.lr = o["lr"]
        self.clip = o["clip_norm"]
        self.state = {}
    def train_step(self, rows):
        total = sum(sum(1 for m in r["target_mask"][1:] if m) for r in rows)
        seed = int(hashlib.sha256(("|".join(str(r["id"]) for r in rows)).encode()).hexdigest()[:8], 16)
        rng = np.random.default_rng(seed)
        delay = float(os.environ.get("KVALAH_MOCK_STEP_S", "0"))
        if delay:
            time.sleep(delay)
        for k in sorted(self.B):
            g = rng.standard_normal(self.B[k].shape).astype(np.float32) * 1e-3
            self.B[k] = (self.B[k] - self.lr * g).astype(np.float32)
        return float(total) * 2.0, total, 1.0
    def sync(self):
        pass
    def get_A(self):
        return {k: v.copy() for k, v in self.A.items()}
    def get_B(self):
        return {k: v.copy() for k, v in self.B.items()}
    def optimizer_state(self):
        return {}, {}
    def load_optimizer_state(self, arrays, meta):
        pass
    def evaluate(self, rows):
        n = sum(sum(1 for m in r["target_mask"][1:] if m) for r in rows)
        return {"nll_sum": 2.0 * n, "tokens": n, "correct": 0}
    def metrics(self):
        return {}
    def release(self):
        pass
