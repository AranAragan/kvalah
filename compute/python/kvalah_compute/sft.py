"""SFT objective shared by all backends (spec §7). target_mask[t] == 1 means input_ids[t] is a supervised
target; it is predicted by logits[t-1]. So the loss uses logits[:-1] against input_ids[1:] with mask[1:]
(exactly one shift, no double shift). Loss = sum NLL over targets / number of targets in the optimizer step."""
from .errors import SidecarError

def check_row(row, max_length):
    ids, mask = row["input_ids"], row["target_mask"]
    if not (isinstance(ids, list) and isinstance(mask, list) and len(ids) == len(mask) and 2 <= len(ids) <= max_length):
        raise SidecarError("INVALID_SCHEMA", "row %s has bad length" % row.get("id"))
    if mask[0] != 0:
        raise SidecarError("INVALID_SCHEMA", "first position cannot be a target")
    n = sum(1 for m in mask[1:] if m)
    if n == 0:
        raise SidecarError("NO_TARGET_TOKENS", "row %s has no supervised tokens" % row.get("id"))
    return n

def targets(row):
    return sum(1 for m in row["target_mask"][1:] if m)
